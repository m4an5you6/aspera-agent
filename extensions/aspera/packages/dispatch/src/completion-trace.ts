/** Original DSH persistence supplies paged review events independently of the supplementary JSONL copy. */
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { agentRecordRequestSchema, projectAgentRecord } from '@aspera/experiments'
import type { CompletionReview, AgentRecordRequest, AgentRecordPage } from '@aspera/experiments'
import { redactCompletionData } from './completion-data.ts'

/** @param persistence - standard read-only Session provider. @param review - original operation and Session identity.
 * @param raw - bounded page and continuation. @param secrets - current account-owned credentials.
 * @returns complete redacted original events, or undefined when only the supplementary copy remains.
 */
export async function readCompletionTrace(persistence: Pick<SessionPersistence, 'stat' | 'open'>, review: CompletionReview,
  raw: AgentRecordRequest, secrets: readonly string[]): Promise<AgentRecordPage | undefined> {
  const input = agentRecordRequestSchema.parse(raw)
  if (input.experimentId !== review.experimentId || input.phase !== 'execution' || input.cursor !== undefined
    && (input.cursor.experimentId !== review.experimentId || input.cursor.phase !== 'execution' || input.cursor.sessionId !== review.sessionId)) throw new Error('Review trace cursor belongs to another operation')
  const id = SessionId(review.sessionId), stat = await persistence.stat(id)
  if (stat === undefined) return undefined
  const handle = await persistence.open(id, 'read')
  try {
    const start = input.beforeSeq === undefined ? input.cursor?.nextSeq ?? Math.max(0, (stat.eventCount ?? 0) - input.limit)
      : Math.max(0, input.beforeSeq - input.limit)
    const { events } = await handle.read(start, input.limit + 1)
    const records = events.filter(event => input.beforeSeq === undefined || event.seq < input.beforeSeq).slice(0, input.limit).map(event =>
      projectAgentRecord({ ...event, data: redactCompletionData(event.data, secrets) }, { experimentId: review.experimentId, phase: 'execution', sessionId: review.sessionId }, Infinity))
    const nextSeq = (records.at(-1)?.seq ?? start - 1) + 1
    return { records, cursor: { experimentId: review.experimentId, phase: 'execution', sessionId: review.sessionId, nextSeq },
      hasMore: input.cursor === undefined ? start > 0 : events.length > records.length, missing: false, reset: false }
  } finally { await handle.close() }
}
