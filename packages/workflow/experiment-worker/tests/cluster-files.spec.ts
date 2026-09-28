/** Byte cursors and artifact confinement use real isolated files. */
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { clusterFiles, clusterPath, readClusterChunk } from '../src/cluster-files.ts'
import { serverIdSchema } from '../src/cluster-protocol.ts'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() { const root = mkdtempSync(join(tmpdir(), 'cluster-files-')); roots.push(root); return root }
it('resumes UTF-8 bytes, reports replacement, truncation and missing logs', () => {
  const root = fixture(); const path = join(root, 'log')
  writeFileSync(path, '训练 A')
  const first = readClusterChunk(path, 0, undefined, 2)
  const next = readClusterChunk(path, first.nextOffset, first.generation, 100)
  expect(Buffer.concat([Buffer.from(first.data, 'base64'), Buffer.from(next.data, 'base64')]).toString('utf8')).toBe('训练 A')
  appendFileSync(path, ' B')
  expect(Buffer.from(readClusterChunk(path, next.nextOffset, next.generation, 100).data, 'base64').toString()).toBe(' B')
  renameSync(path, join(root, 'old')); writeFileSync(path, 'new')
  const rotated = readClusterChunk(path, next.nextOffset, next.generation, 100)
  expect(rotated).toMatchObject({ reset: true, offset: 0, nextOffset: 3 })
  writeFileSync(path, 'x')
  expect(readClusterChunk(path, 3, rotated.generation, 100).reset).toBe(true)
  rmSync(path)
  expect(readClusterChunk(path, 1, rotated.generation, 100)).toMatchObject({ reset: true, generation: '', eof: true })
})
it('lists bounded metadata and downloads only files inside the selected experiment', () => {
  const root = fixture(); mkdirSync(join(root, 'outputs')); writeFileSync(join(root, 'outputs', 'a.bin'),
    'abc'); writeFileSync(join(root, 'z.txt'), 'z')
  const id = serverIdSchema.parse(randomUUID())
  const metadata = clusterFiles(root, id, 1)
  expect(metadata.files).toHaveLength(1); expect(metadata.truncated).toBe(true)
  expect(metadata.files[0]!.serverId).toBe(id)
  expect(Buffer.from(readClusterChunk(clusterPath(root, 'outputs/a.bin'), 0, undefined, 10, root).data, 'base64').toString()).toBe('abc')
  for (const path of ['../secret', '/secret', 'outputs/../../secret', 'outputs\\secret',
    'outputs//secret']) expect(() => clusterPath(root, path)).toThrow()
})
it.skipIf(process.platform === 'win32')('refuses file links and linked parent directories', () => {
  const root = fixture(); const outside = fixture(); writeFileSync(join(outside, 'secret'), 'private')
  symlinkSync(outside, join(root, 'link')); symlinkSync(join(outside, 'secret'), join(root, 'file'))
  expect(() => clusterPath(root, 'link/secret')).toThrow('links')
  expect(() => readClusterChunk(join(root, 'file'), 0, undefined, 100, root)).toThrow()
  expect(clusterFiles(root, serverIdSchema.parse(randomUUID()), 10).files).toEqual([])
})
