/** Identity-checked command streams remain available outside the read-only command workspace. */
import { z } from 'zod'
import { processLogPageSchema, processLogCursorSchema, serverIdSchema } from '@aspera/experiments'
import type { ClusterPrivate } from './cluster-runtime.ts'
import { clusterNodeRequest } from './cluster-runtime.ts'

const inputSchema = z.object({ server_id: serverIdSchema, command_id: processLogCursorSchema.shape.commandId,
  stream: z.enum(['stdout', 'stderr']), offset: z.number().int().nonnegative(), generation: z.string().optional() }).strict()

/** Read one bounded stream page; incomplete UTF-8 remains at the next cursor.
 * @param runtime - immutable experiment allocation and private transport.
 * @param raw - model-supplied stream identity and continuation.
 * @param limit - resolved deployment byte limit.
 * @param signal - tool lifetime.
 * @returns text and the verified physical continuation, without starting any command.
 */
export async function readCommandOutput(runtime: ClusterPrivate, raw: unknown, limit: number, signal?: AbortSignal) {
  const input = inputSchema.parse(raw), experimentId = runtime.submission.experimentId
  if (!runtime.submission.nodes.some(node => node.server.id === input.server_id)) throw new Error('Command output node is outside the original allocation')
  if (input.offset !== 0 && input.generation === undefined) throw new Error('Continuing command output requires its returned generation')
  const identity = { experimentId, serverId: input.server_id, commandId: input.command_id, stream: input.stream }
  const page = processLogPageSchema.parse(await clusterNodeRequest(runtime, input.server_id, 'process-log', { ...identity, limit,
    ...(input.generation === undefined ? {} : { cursor: { ...identity, generation: input.generation, offset: input.offset } }) }, signal))
  const chunk = page.chunk
  if (page.cursor.experimentId !== experimentId || page.cursor.serverId !== input.server_id
    || page.cursor.commandId !== input.command_id || page.cursor.stream !== input.stream
    || page.cursor.generation !== chunk.generation || page.cursor.offset !== chunk.nextOffset
    || (!chunk.reset && chunk.offset !== input.offset)) throw new Error('Command output does not match its requested source or cursor')
  const bytes = Buffer.from(chunk.data, 'base64')
  if (bytes.length > limit || chunk.nextOffset !== chunk.offset + bytes.length) throw new Error('Command output exceeded its requested byte range')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: true }) }
  catch (error) { throw new Error('Command output contains invalid UTF-8; retain the original byte log for download', { cause: error }) }
  const consumed = Buffer.byteLength(text), nextOffset = chunk.offset + consumed
  return { ...identity, stream: input.stream, offset: chunk.offset, nextOffset, generation: chunk.generation,
    reset: chunk.reset, eof: chunk.eof && consumed === bytes.length, missing: page.missing,
    ...(consumed === bytes.length ? {} : { incompleteUtf8Bytes: bytes.length - consumed }), text }
}
