/** Paged Agent records and process-log cursors bound to their experiment source. */
import { z } from 'zod'
import { experimentIdSchema, serverIdSchema, clusterCommandResultSchema, clusterChunkSchema } from './cluster-protocol.ts'
import { experimentPhases } from './models.ts'

/** Client continuation identity; never accepted for another phase or Session. */
export const agentRecordCursorSchema = z.object({ experimentId: experimentIdSchema, phase: z.enum(experimentPhases),
  sessionId: z.string(), nextSeq: z.number().int().nonnegative(), generation: z.string().optional() }).strict()
/** Validated bounded page request. */
export const agentRecordRequestSchema = z.object({ experimentId: experimentIdSchema, phase: z.enum(experimentPhases),
  cursor: agentRecordCursorSchema.optional(), beforeSeq: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(100).default(50) }).strict()
/** A real Session event, with oversized payloads explicitly marked. */
export const agentRecordSchema = z.object({ experimentId: experimentIdSchema, phase: z.enum(experimentPhases),
  sessionId: z.string(), seq: z.number().int().nonnegative(), time: z.number(), type: z.string(),
  data: z.string(), truncated: z.boolean(), log: z.object({ serverId: serverIdSchema, commandId: z.string() }).optional() }).strict()
/** Page preserving event sequence and physical source availability. */
export const agentRecordPageSchema = z.object({ records: z.array(agentRecordSchema), cursor: agentRecordCursorSchema.optional(),
  hasMore: z.boolean(), missing: z.boolean(), reset: z.boolean() }).strict()
/** One rendered event. */
export type AgentRecord = z.infer<typeof agentRecordSchema>
/** Public pagination request. */
export type AgentRecordRequest = z.input<typeof agentRecordRequestSchema>
/** Public pagination response. */
export type AgentRecordPage = z.infer<typeof agentRecordPageSchema>
/** Cursor used for reconnection. */
export type AgentRecordCursor = z.infer<typeof agentRecordCursorSchema>
/** Process directory entry; old records may lack separated streams. */
export const experimentProcessSchema = clusterCommandResultSchema.extend({ experimentId: experimentIdSchema,
  serverId: serverIdSchema, command: z.string(), streams: z.array(z.enum(['stdout', 'stderr'])) }).strict()
/** Process list item. */
export type ExperimentProcess = z.infer<typeof experimentProcessSchema>
/** Cursor includes all log source dimensions and the physical file generation. */
export const processLogCursorSchema = z.object({ experimentId: experimentIdSchema, serverId: serverIdSchema,
  commandId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), stream: z.enum(['stdout', 'stderr']), generation: z.string(), offset: z.number().int().nonnegative() }).strict()
/** Process log source and optional continuation. */
export const processLogRequestSchema = processLogCursorSchema.omit({ generation: true, offset: true }).extend({ cursor: processLogCursorSchema.optional() }).strict()
/** Bounded log bytes plus an identity-bound continuation. */
export const processLogPageSchema = z.object({ chunk: clusterChunkSchema, cursor: processLogCursorSchema, missing: z.boolean() }).strict()
/** Process log request. */
export type ProcessLogRequest = z.input<typeof processLogRequestSchema>
/** Process log response. */
export type ProcessLogPage = z.infer<typeof processLogPageSchema>

/** Project an observed event without estimating timings or inventing messages.
 * @param event - validated Session event. @param source - experiment, phase and Session ownership.
 * @param maximumChars - response budget for one payload. @returns public record with an optional tool-log link.
 */
export function projectAgentRecord(event: { seq: number; time: number; type: string; data: unknown },
  source: Pick<AgentRecord, 'experimentId' | 'phase' | 'sessionId'>, maximumChars: number): AgentRecord {
  const data = JSON.stringify(event.data)
  let log: AgentRecord['log']
  if (event.type === 'tool/call') {
    const call = z.object({ name: z.string(), arguments: z.string() }).safeParse(event.data)
    if (call.success && ['run_experiment_command', 'start_inference_service'].includes(call.data.name)) {
      try {
        const args = z.object({ server_id: serverIdSchema, run_id: z.string().optional(), service_id: z.string().uuid().optional() }).parse(JSON.parse(call.data.arguments))
        const commandId = args.run_id ?? (args.service_id === undefined ? undefined : `service-${args.service_id}`)
        if (commandId !== undefined) log = { serverId: args.server_id, commandId }
      } catch (error) { void error } // Unexecuted invalid tool arguments have no process association.
    }
  }
  return { ...source, seq: event.seq, time: event.time, type: event.type, data: data.slice(0, maximumChars),
    truncated: data.length > maximumChars, ...(log === undefined ? {} : { log }) }
}
