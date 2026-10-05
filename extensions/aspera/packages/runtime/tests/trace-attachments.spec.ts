/** Only references recorded by the owning event can read the published attachment store. */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import { expect, it } from 'vitest'
import { readTraceAttachment } from '../src/trace-attachments.ts'

it('reads bounded verified bytes and rejects a reference absent from the selected event', async () => {
  mkdirSync('.artifacts', { recursive: true })
  const home = mkdtempSync(resolve('.artifacts/trace-attachment-'))
  const ctx = new Context()
  try {
    const attachments = new LocalAttachmentStore(ctx, { dshHome: home })
    const ref = await attachments.saveFile({ name: 'long-output.txt', data: Buffer.from('完整输出🙂\n'.repeat(100)) })
    const event = { content: [{ type: 'file', attachment: ref }] }
    let offset = 0; const bytes: Buffer[] = []
    while (offset < ref.bytes) {
      const part = await readTraceAttachment(home, event, ref.attachmentId, offset, 71)
      expect(part.nextOffset).toBeGreaterThan(offset); offset = part.nextOffset; bytes.push(Buffer.from(part.data, 'base64'))
    }
    expect(Buffer.concat(bytes).toString('utf8')).toBe('完整输出🙂\n'.repeat(100))
    await expect(readTraceAttachment(home, { content: [] }, ref.attachmentId, 0, 100)).rejects.toThrow('not referenced')
    await expect(readTraceAttachment(home, event, ref.attachmentId, ref.bytes + 1, 100)).rejects.toThrow('exceeds')
  } finally { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) }
})
