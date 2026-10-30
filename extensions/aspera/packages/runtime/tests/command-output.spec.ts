/** Command output readers validate source ownership and retain incomplete UTF-8 bytes. */
import { randomUUID } from 'node:crypto'
import { fromAny } from '@total-typescript/shoehorn'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { readCommandOutput } from '../src/command-output.ts'
import { clusterNodeRequest } from '../src/cluster-runtime.ts'
import type { ClusterPrivate } from '../src/cluster-runtime.ts'

vi.mock('../src/cluster-runtime.ts', async original => ({ ...await original<typeof import('../src/cluster-runtime.ts')>(), clusterNodeRequest: vi.fn() }))
afterEach(() => { vi.mocked(clusterNodeRequest).mockReset() })
function fixture(text = 'A你B') {
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const runtime = fromAny<ClusterPrivate, object>({ submission: { experimentId, nodes: [{ server: { id: serverId } }] } })
  const input = { server_id: serverId, command_id: 'probe', stream: 'stdout', offset: 0 }
  const bytes = Buffer.from(text)
  const page = (offset = 0, limit = bytes.length) => {
    const data = bytes.subarray(offset, offset + limit)
    return { chunk: { generation: 'original', offset, nextOffset: offset + data.length, data: data.toString('base64'), reset: false, eof: offset + data.length === bytes.length },
      cursor: { experimentId, serverId, commandId: 'probe', stream: 'stdout', generation: 'original', offset: offset + data.length }, missing: false }
  }
  return { runtime, input, page, experimentId, serverId }
}
it('reads Unicode across pages without advancing past a partial character or launching a command', async () => {
  const f = fixture(), signal = new AbortController().signal
  vi.mocked(clusterNodeRequest).mockImplementation(async (_runtime, _server, operation, raw) => {
    expect(operation).toBe('process-log')
    const input = fromAny<{ cursor?: { offset: number }; limit: number }, unknown>(raw)
    return f.page(input.cursor?.offset ?? 0, input.limit)
  })
  const first = await readCommandOutput(f.runtime, f.input, 3, signal)
  expect(first).toMatchObject({ text: 'A', nextOffset: 1, incompleteUtf8Bytes: 2, eof: false })
  const second = await readCommandOutput(f.runtime, { ...f.input, offset: first.nextOffset, generation: first.generation }, 3, signal)
  expect(second).toMatchObject({ text: '你', nextOffset: 4, eof: false })
  const third = await readCommandOutput(f.runtime, { ...f.input, offset: second.nextOffset, generation: second.generation }, 3, signal)
  expect(third).toMatchObject({ text: 'B', nextOffset: 5, eof: true })
  expect(vi.mocked(clusterNodeRequest).mock.calls.every(call => call[4] === signal)).toBe(true)
})
it('preserves a UTF-8 byte order marker in byte-addressed output', async () => {
  const f = fixture('\uFEFF中文'); vi.mocked(clusterNodeRequest).mockResolvedValue(f.page())
  expect(await readCommandOutput(f.runtime, f.input, 100)).toMatchObject({ text: '\uFEFF中文', nextOffset: 9, eof: true })
})
it('rejects unauthorized nodes and a continuation without generation before reading', async () => {
  const f = fixture()
  await expect(readCommandOutput(f.runtime, { ...f.input, server_id: serverIdSchema.parse(randomUUID()) }, 100)).rejects.toThrow('outside')
  await expect(readCommandOutput(f.runtime, { ...f.input, command_id: '../other' }, 100)).rejects.toThrow()
  await expect(readCommandOutput(f.runtime, { ...f.input, offset: 1 }, 100)).rejects.toThrow('generation')
  expect(clusterNodeRequest).not.toHaveBeenCalled()
})
it.each(['experimentId', 'serverId', 'commandId', 'stream', 'generation'] as const)('rejects a response with a different %s', async key => {
  const f = fixture(), page = f.page()
  if (key === 'experimentId') page.cursor.experimentId = experimentIdSchema.parse(randomUUID())
  else if (key === 'serverId') page.cursor.serverId = serverIdSchema.parse(randomUUID())
  else page.cursor[key] = key === 'stream' ? 'stderr' : 'different'
  vi.mocked(clusterNodeRequest).mockResolvedValue(page)
  await expect(readCommandOutput(f.runtime, f.input, 100)).rejects.toThrow('requested source')
})
it('reports missing output explicitly and rejects an oversized reply', async () => {
  const f = fixture(''), page = f.page(); page.chunk.generation = ''; page.cursor.generation = ''; page.missing = true
  vi.mocked(clusterNodeRequest).mockResolvedValue(page)
  expect(await readCommandOutput(f.runtime, f.input, 100)).toMatchObject({ text: '', missing: true, eof: true })
  const large = fixture('large'); vi.mocked(clusterNodeRequest).mockResolvedValue(large.page())
  await expect(readCommandOutput(large.runtime, large.input, 1)).rejects.toThrow('byte range')
})
it('returns an explicit reset after physical log replacement', async () => {
  const f = fixture('new'), page = f.page(); page.chunk.reset = true
  vi.mocked(clusterNodeRequest).mockResolvedValue(page)
  expect(await readCommandOutput(f.runtime, { ...f.input, offset: 30, generation: 'old' }, 100)).toMatchObject({ reset: true, offset: 0, nextOffset: 3, text: 'new' })
})
