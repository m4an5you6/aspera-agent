/** Model input pages retain file byte cursors while exposing readable UTF-8 text. */
import { z } from 'zod'
import { clusterPath, readClusterChunk } from '@aspera/experiments'

/** Binary inputs require an explicit encoding; text pages are the model-facing default. */
export const submittedInputReadSchema = z.object({ name: z.string().min(1), offset: z.number().int().nonnegative(),
  generation: z.string().optional(), encoding: z.enum(['utf8', 'base64']).optional() }).strict()

/** Read one owned input without a shell or persistent decoding files.
 * @param folder - original experiment input directory. @param names - immutable submitted basenames.
 * @param request - model JSON selecting a file and byte cursor. @param maxBytes - resolved planning text page limit.
 * @returns original byte identity and either bounded text or explicitly requested base64 data.
 */
export function readSubmittedInput(folder: string, names: readonly string[], request: unknown, maxBytes: number) {
  const input = submittedInputReadSchema.parse(request), spec = { ...input, encoding: input.encoding ?? 'utf8' }
  if (!names.includes(spec.name)) throw new Error('input is outside this experiment')
  const chunk = readClusterChunk(clusterPath(folder, spec.name), spec.offset, spec.generation, maxBytes, folder)
  if (spec.encoding === 'base64') return { ...chunk, encoding: spec.encoding }
  const bytes = Buffer.from(chunk.data, 'base64')
  let text: string
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes, { stream: !chunk.eof }) }
  catch (error) { throw new Error('Input is not valid UTF-8 text; request encoding=base64 for binary data', { cause: error }) }
  const consumed = Buffer.byteLength(text), { data: _data, ...identity } = chunk
  return { ...identity, encoding: spec.encoding, text, nextOffset: chunk.offset + consumed, eof: chunk.eof && consumed === bytes.length }
}
