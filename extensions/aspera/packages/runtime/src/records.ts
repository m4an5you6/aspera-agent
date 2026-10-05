/** Coordinator reads only the phase log associated with the saved execution Session. */
import { createReadStream, existsSync, statSync } from 'node:fs'
import { finished } from 'node:stream/promises'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { agentRecordRequestSchema, projectAgentRecord } from '@aspera/experiments'
import type { AgentRecordRequest, AgentRecordPage } from '@aspera/experiments'

/** Read a bounded phase page while keeping incomplete physical tails out of the cursor.
 * @param path - coordinator-owned JSONL. @param raw - caller pagination. @param sessionId - saved phase Session.
 * @param maximumChars - page budget. @param complete - retain entire event payloads, allowing one oversized event per page.
 * @param eventLimit - payload size before lazy detail retrieval. @returns observed events and continuation.
 */
export async function readPhaseRecords(path: string, raw: AgentRecordRequest, sessionId: string, maximumChars: number, complete = false, eventLimit = Infinity): Promise<AgentRecordPage> {
  const request = agentRecordRequestSchema.parse(raw)
  const cursor = request.cursor
  if (cursor !== undefined && (cursor.experimentId !== request.experimentId || cursor.phase !== request.phase || cursor.sessionId !== sessionId)) throw new Error('Agent cursor belongs to another experiment, phase or Session')
  if (!existsSync(path)) return { records: [], hasMore: false, missing: true, reset: cursor !== undefined }
  const stats = statSync(path)
  const generation = `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
  const reset = cursor?.generation !== undefined && cursor.generation !== generation
  const start = request.beforeSeq === undefined ? (reset ? 0 : cursor?.nextSeq ?? 0) : Math.max(0, request.beforeSeq - request.limit)
  const records: AgentRecordPage['records'] = []
  const tail = request.beforeSeq !== undefined || (complete && request.cursor === undefined)
  const input = createReadStream(path)
  const settled = finished(input).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE') throw error
  })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let end = 0; let characters = 0; let hasMore = false
  try {
    for await (const line of lines) {
      end += Buffer.byteLength(line) + 1
      if (end > stats.size) break
      const envelope = z.object({ sessionId: z.string(), source: z.string(), event: z.object({ seq: z.number().int().nonnegative(), time: z.number(), type: z.string(), data: z.unknown() }) }).parse(JSON.parse(line))
      if (envelope.sessionId !== sessionId || envelope.source !== (request.phase === 'planning' ? 'plan' : 'execution')) continue
      if (envelope.event.seq < start) continue
      if (request.beforeSeq !== undefined && envelope.event.seq >= request.beforeSeq) break
      if (!tail && (records.length >= request.limit || characters >= maximumChars)) { hasMore = true; break }
      const row = projectAgentRecord(envelope.event, { experimentId: request.experimentId, phase: request.phase, sessionId }, complete ? eventLimit : maximumChars - characters)
      records.push(row); characters += row.data.length
      if (tail) while (records.length > 1 && (records.length > request.limit || characters > maximumChars)) characters -= records.shift()!.data.length
    }
  } finally { lines.close(); input.destroy(); await settled }
  return { records, cursor: { experimentId: request.experimentId, phase: request.phase, sessionId,
    nextSeq: (records.at(-1)?.seq ?? start - 1) + 1, generation }, hasMore, missing: false, reset }
}
