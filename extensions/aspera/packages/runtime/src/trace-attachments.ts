/** Attachment reads require an exact reference inside an owned Session event. */
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { z } from 'zod'

const identity = z.string().regex(/^sha256:[a-f0-9]{64}$/).transform(AttachmentId)
const fileRef = z.object({ attachmentId: identity, bytes: z.number().int().nonnegative(), name: z.string() })
const imageRef = fileRef.omit({ name: true }).extend({ mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  width: z.number().int().positive(), height: z.number().int().positive(), name: z.string().optional() })

/** @param data - complete event payload. @param id - requested attachment. @returns the recorded attachment reference. */
export function traceAttachmentRef(data: unknown, id: string): z.infer<typeof imageRef> | z.infer<typeof fileRef> {
  const pending = [data]
  while (pending.length > 0) {
    const item = pending.pop()
    if (item === null || typeof item !== 'object') continue
    const image = imageRef.safeParse(item)
    if (image.success && image.data.attachmentId === id) return image.data
    const file = fileRef.safeParse(item)
    if (file.success && file.data.attachmentId === id) return file.data
    pending.push(...Object.values(item))
  }
  throw new Error('Attachment is not referenced by this event')
}

/** @param home - pinned Session profile home. @param data - owned event. @param id - recorded attachment identity.
 * @param offset - byte offset. @param limit - transport budget. @returns verified bytes from the published DSH attachment provider.
 */
export async function readTraceAttachment(home: string, data: unknown, id: string, offset: number, limit: number): Promise<{ data: string; mediaType: string; name: string; nextOffset: number; size: number }> {
  const ref = traceAttachmentRef(data, id)
  if (offset < 0 || offset > ref.bytes) throw new Error('Attachment offset exceeds its recorded size')
  const owner = new Context()
  const store = new LocalAttachmentStore(owner, { dshHome: home })
  try {
    let bytes: Buffer
    if ('mediaType' in ref) bytes = Buffer.from((await store.readImage(ref)).data).subarray(offset, offset + limit)
    else {
      const parts: Buffer[] = []; let position = 0
      // Exhausting the provider stream validates the complete content digest even for a partial read.
      for await (const part of store.readFileStream(ref)) {
        const start = Math.max(0, offset - position), end = Math.min(part.length, offset + limit - position)
        if (end > start) parts.push(Buffer.from(part.subarray(start, end)))
        position += part.length
      }
      bytes = Buffer.concat(parts)
    }
    return { data: bytes.toString('base64'), mediaType: 'mediaType' in ref ? ref.mediaType : 'application/octet-stream',
      name: ref.name ?? 'attachment', nextOffset: offset + bytes.length, size: ref.bytes }
  } finally { await owner.fiber.dispose() }
}
