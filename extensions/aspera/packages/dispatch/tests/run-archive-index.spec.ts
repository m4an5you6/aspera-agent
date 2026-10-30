/** Historical indexes validate physical block ownership without repeated path walks. */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { archiveHash, archiveRemoteSourceSchema, RunArchiveStore } from '../src/run-archive-store.ts'

vi.mock('node:fs', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs')>()
  return { ...original, realpathSync: vi.fn(original.realpathSync), readdirSync: vi.fn(original.readdirSync) }
})

const base = resolve('.artifacts')
const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (dirname(root) !== base) throw new Error('Test cleanup root differs')
    fs.rmSync(root, { recursive: true, force: true })
  }
})

function fixture(count = 1) {
  fs.mkdirSync(base, { recursive: true })
  const root = fs.mkdtempSync(resolve(base, 'archive-index-')); roots.push(root)
  const id = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID()), digest = 'a'.repeat(64)
  const store = new RunArchiveStore(root, id, digest, 0)
  const source = archiveRemoteSourceSchema.parse({ id: 'trace', path: 'events.jsonl', kind: 'trace', format: 'events',
    phase: 'execution', sessionId: 'execution', generation: 'one', size: 1000000, modifiedAt: 1 })
  const stream = store.source(serverId, source), blocks: string[] = []
  for (let seq = 0; seq < count; seq++) {
    const rows = [{ experimentId: id, phase: 'execution', sessionId: 'execution', seq, time: seq + 1,
      type: 'tool/result', data: JSON.stringify({ content: 'saved result ' + seq }), truncated: false }]
    const hash = archiveHash(rows), size = Buffer.byteLength(JSON.stringify(rows[0]) + '\n')
    const path = resolve(root, id, hash + '.json'); fs.writeFileSync(path, JSON.stringify(rows) + '\n'); blocks.push(path)
    stream.frames.push({ hash, first: seq, last: seq, start: stream.bytes, end: stream.bytes + size })
    stream.bytes += size; stream.lastSeq = seq
  }
  store.health('caught-up', 1)
  const directory = resolve(root, id), open = () => new RunArchiveStore(root, id, digest, 0)
  return { root, id, directory, blocks, open }
}

it('opens a many-block index with bounded path resolution and preserves offline pagination', () => {
  const f = fixture(1200)
  vi.mocked(fs.realpathSync).mockClear(); vi.mocked(fs.readdirSync).mockClear()
  const store = f.open()
  expect(vi.mocked(fs.realpathSync).mock.calls.length).toBeLessThanOrEqual(8)
  expect(fs.readdirSync).toHaveBeenCalledTimes(1)
  expect(store.records({ experimentId: f.id, phase: 'execution', beforeSeq: 1190, limit: 3 })?.records.map(row => row.seq)).toEqual([1187, 1188, 1189])
})

it.each(['missing', 'directory', 'link'] as const)('refuses a committed block replaced by %s', replacement => {
  const f = fixture(), file = f.blocks[0]!
  fs.unlinkSync(file)
  if (replacement === 'directory') fs.mkdirSync(file)
  if (replacement === 'link') {
    const target = resolve(f.root, 'outside'); fs.mkdirSync(target)
    fs.symlinkSync(target, file, process.platform === 'win32' ? 'junction' : 'dir')
  }
  expect(f.open).toThrow(/missing committed interval|symbolic|regular file/)
})

it('rejects replacement of the archive directory during its index read', () => {
  const f = fixture(), original = fs.readdirSync.bind(fs)
  vi.mocked(fs.readdirSync).mockImplementationOnce((...args) => {
    const result = original(...args)
    fs.renameSync(f.directory, f.directory + '-saved')
    fs.mkdirSync(f.directory)
    return result
  })
  expect(f.open).toThrow(/changed|outside/)
})

it('rechecks a block at read time after its index has been opened', () => {
  const f = fixture(), store = f.open()
  fs.writeFileSync(f.blocks[0]!, '[]\n')
  expect(() => store.records({ experimentId: f.id, phase: 'execution' })).toThrow('integrity')
})
