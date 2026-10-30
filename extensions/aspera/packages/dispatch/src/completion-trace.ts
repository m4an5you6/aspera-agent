/** Original DSH persistence supplies paged review events independently of the supplementary JSONL copy. */
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { agentRecordRequestSchema, projectAgentRecord } from '@aspera/experiments'
import type { CompletionReview, AgentRecordRequest, AgentRecordPage } from '@aspera/experiments'
import { redactCompletionData } from './completion-data.ts'

/** Locate the valid logical end with single-event probes when a backend omits cheap count metadata. */
async function logicalEventCount(handle: Pick<SessionHandle, 'read'>): Promise<number> {
  let lower = 0, upper = 1
  while ((await handle.read(upper, 1)).events.length > 0) {
    if (upper === Number.MAX_SAFE_INTEGER) throw new Error('Review Session exceeds the supported logical event range')
    lower = upper + 1; upper = Math.min(upper * 2, Number.MAX_SAFE_INTEGER)
  }
  while (lower < upper) {
    const middle = lower + Math.floor((upper - lower) / 2)
    if ((await handle.read(middle, 1)).events.length === 0) upper = middle
    else lower = middle + 1
  }
  return lower
}

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
    let start: number
    if (input.beforeSeq !== undefined) start = Math.max(0, input.beforeSeq - input.limit)
    else if (input.cursor !== undefined) start = input.cursor.nextSeq
    else {
      const count = stat.eventCount === undefined ? await logicalEventCount(handle) : stat.eventCount
      start = Math.max(0, count - input.limit)
    }
    const { events } = await handle.read(start, input.limit + 1)
    const records = events.filter(event => input.beforeSeq === undefined || event.seq < input.beforeSeq).slice(0, input.limit).map(event =>
      projectAgentRecord({ ...event, data: redactCompletionData(event.data, secrets) }, { experimentId: review.experimentId, phase: 'execution', sessionId: review.sessionId }, Infinity))
    const nextSeq = (records.at(-1)?.seq ?? start - 1) + 1
    return { records, cursor: { experimentId: review.experimentId, phase: 'execution', sessionId: review.sessionId, nextSeq },
      hasMore: input.cursor === undefined ? start > 0 : events.length > records.length, missing: false, reset: false }
  } finally { await handle.close() }
}
