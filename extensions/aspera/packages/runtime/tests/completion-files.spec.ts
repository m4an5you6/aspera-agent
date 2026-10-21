/** Scoped evidence reads preserve original files and reject escaped or changed ownership. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, symlinkSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import type { CompletionReview, ClusterNode } from '@aspera/experiments'
import { inspectCompletionIdentity, inspectCompletionFile, inspectCompletionSession, inspectHistoricalEnvironment, saveCompletionReview, listCompletionFiles } from '../scripts/completion-files.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts', 'completion-files-')); roots.push(root)
  const runRoot = resolve(root, 'run'), controlRoot = resolve(root, 'control'), releaseRoot = resolve(root, 'release')
  const experimentId = randomUUID(), serverId = randomUUID(), deploymentId = 'a'.repeat(64)
  const node = fromAny<ClusterNode, object>({ server: { id: serverId, name: 'CPU' }, devicePaths: [] })
  const put = (file: string, data: unknown) => { mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)) }
  put(resolve(runRoot, '.aspera-owner.json'), { version: 1, experimentId, serverId })
  put(resolve(controlRoot, '.aspera-owner.json'), { version: 1, kind: 'control', serverId })
  put(resolve(controlRoot, `state/node-home/storages/aspera_node/allocations/${experimentId}.json`), { record: { deploymentId, node, released: true } })
  put(resolve(releaseRoot, 'aspera-release.json'), { deploymentId }); put(resolve(releaseRoot, '.ready'), 'ready')
  put(resolve(runRoot, 'workspace/train.log'), '57/57\ntraining completed\n')
  put(resolve(runRoot, 'workspace/pyenv/pyvenv.cfg'), 'version_info = 3.10.12\ninclude-system-site-packages = false\n')
  put(resolve(runRoot, 'workspace/pyenv/bin/python'), 'CPU fixture, never executed')
  put(resolve(runRoot, 'workspace/pyenv/lib/python3.10/site-packages/ms_swift-4.6.0.dist-info/METADATA'), 'Name: ms-swift\nVersion: 4.6.0\n')
  const request = { runRoot, controlRoot, releaseRoot, experimentId, serverId, deploymentId, node, maxBytes: 1024 }
  return { root, runRoot, request, put }
}
it('binds a read to the original allocation and unchanged fixed release', () => {
  const f = fixture(); expect(inspectCompletionIdentity(f.request)).toEqual({ verified: true })
  f.put(resolve(f.request.releaseRoot, 'aspera-release.json'), { deploymentId: 'b'.repeat(64) })
  expect(() => inspectCompletionIdentity(f.request)).toThrow('fixed release identity')
})
it.each(['../outside', '/absolute/file', 'folder/../../outside'])('refuses evidence path %s', path => {
  const f = fixture(); expect(() => inspectCompletionFile({ ...f.request, path })).toThrow()
})
it('hashes the complete source while bounding text, and detects a new generation', () => {
  const f = fixture(); f.put(resolve(f.runRoot, 'workspace/train.log'), 'x'.repeat(2048))
  const before = inspectCompletionFile({ ...f.request, path: 'train.log', maxBytes: 1024 })
  expect(before.text).toHaveLength(1024); expect(before.truncated).toBe(true)
  f.put(resolve(f.runRoot, 'workspace/train.log'), 'Changed original file\n')
  const after = inspectCompletionFile({ ...f.request, path: 'train.log' })
  expect(before.sha256).not.toBe(after.sha256); expect(before.generation).not.toBe(after.generation)
})
it('hashes large state artifacts without returning binary payload and reads text tails by position', () => {
  const f = fixture(), value = 'head' + 'x'.repeat(1024 * 1024) + 'final result'
  f.put(resolve(f.runRoot, 'workspace/state.pt'), value)
  const meta = inspectCompletionFile({ ...f.request, path: 'state.pt', metadataOnly: true })
  expect(meta).toMatchObject({ sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value), text: '', tail: '', truncated: true })
  const text = inspectCompletionFile({ ...f.request, path: 'state.pt' })
  expect(text.text).toBe(value.slice(0, 1024)); expect(text.tail).toBe(value.slice(-1024)); expect(text.sha256).toBe(meta.sha256)
})
it('registers uv historical metadata read-only and rejects another framework version', () => {
  const f = fixture(), bin = resolve(f.runRoot, 'workspace/pyenv/bin/python'), before = readFileSync(bin)
  const environment = inspectHistoricalEnvironment({ ...f.request, environment: 'pyenv', framework: 'ms-swift', version: '4.6.0' })
  expect(environment).toMatchObject({ kind: 'historical', packages: { 'ms-swift': '4.6.0' } })
  expect(readFileSync(bin)).toEqual(before)
  expect(() => inspectHistoricalEnvironment({ ...f.request, environment: 'pyenv', framework: 'ms-swift', version: '1' })).toThrow('version differs')
})
it('lists result candidates without traversing historical dependency directories', () => {
  const f = fixture(), result = listCompletionFiles({ ...f.request, maxEntries: 100, excludeDirectories: [] })
  expect(result.files.map(file => file.path)).toEqual(['train.log'])
})
it('writes only an independent receipt and rejects a conflicting revision', () => {
  const f = fixture(), original = readFileSync(resolve(f.runRoot, 'workspace/train.log'))
  const receipt = fromAny<CompletionReview, object>({ experimentId: f.request.experimentId, operationId: randomUUID(), submissionHash: 'c'.repeat(64), revision: 1 })
  expect(saveCompletionReview({ ...f.request, receipt }).sha256).toHaveLength(64)
  expect(saveCompletionReview({ ...f.request, receipt }).sha256).toHaveLength(64)
  expect(() => saveCompletionReview({ ...f.request, receipt: { ...receipt, revision: 0 } })).toThrow('revision conflict')
  expect(readFileSync(resolve(f.runRoot, 'workspace/train.log'))).toEqual(original)
})
it('reads complete large Session events and rejects a later blocked Goal as completion proof', () => {
  const f = fixture(), sessionId = 'original-execution', file = resolve(f.runRoot, 'events.jsonl')
  const rows = [
    { type: 'tool/call', data: { name: 'finish_experiment', arguments: JSON.stringify({ status: 'completed', detail: '证据'.repeat(40000) }) } },
    { type: 'goal/change', data: { goal: { phase: 'complete' } } }, { type: 'turn/end', data: {} },
  ].map((event, seq) => ({ sessionId, event: { ...event, seq } }))
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  expect(inspectCompletionSession({ ...f.request, sessionId, maxBytes: 1048576 }).finished).toBe(true)
  expect(inspectCompletionSession({ ...f.request, sessionId: 'another', maxBytes: 1048576 }).finished).toBe(false)
  appendFileSync(file, JSON.stringify({ sessionId, event: { seq: 3, type: 'goal/change', data: { goal: { phase: 'blocked' } } } }) + '\n')
  expect(inspectCompletionSession({ ...f.request, sessionId, maxBytes: 1048576 }).finished).toBe(false)
  appendFileSync(file, '{"partial":')
  expect(() => inspectCompletionSession({ ...f.request, sessionId, maxBytes: 1048576 })).toThrow('incomplete event')
})
it('rejects a directory link to another location without reading its target', () => {
  const f = fixture(), target = resolve(f.root, 'other'), link = resolve(f.runRoot, 'workspace/linked')
  f.put(resolve(target, 'secret.txt'), 'not authorized')
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  try { expect(() => inspectCompletionFile({ ...f.request, path: 'linked/secret.txt' })).toThrow('symbolic link') }
  finally { unlinkSync(link) }
})
