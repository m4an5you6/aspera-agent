/** The stopped-controller reader accesses owned files without a GPU, account tools or a runtime launch. */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import { experimentIdSchema, serverIdSchema, clusterServerSchema } from '@aspera/experiments'
import type { FleetExperiment } from '../src/types.ts'
import { RunArchiveReader, runArchivePolicySchema } from '../src/run-archive-reader.ts'
import type { ArchiveReadDriver } from '../src/run-archive-reader.ts'

const base = resolve('.artifacts'); mkdirSync(base, { recursive: true })
const roots: string[] = []
const helper = readFileSync(new URL('../scripts/read-archive.mjs', import.meta.url), 'utf8')

it('falls back to a fresh read-only SSH deadline after the control request times out', async () => {
  const id = experimentIdSchema.parse(randomUUID()); const serverId = serverIdSchema.parse(randomUUID())
  const server = clusterServerSchema.parse({ id: serverId, name: 'node', host: 'fixture', username: 'trainer', sshPort: 22,
    remotePort: 43019, remoteRoot: '/owned', authMode: 'password' })
  const record = fromAny<FleetExperiment, object>({ request: { experimentId: id }, servers: [server], coordinator: server,
    submission: { protocol: 4, experimentId: id } })
  let sshRead = false
  const driver: ArchiveReadDriver = { connection: async () => ({ target: { host: 'fixture', sshPort: 22, remotePort: 43019, toolTimeoutMs: 1000 } }),
    rpc: async (_record, _operation, _input, signal) => new Promise((_resolve, reject) => {
      signal.throwIfAborted(); signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
    remoteResult: async (_target, _script, signal, _password, output) => {
      signal?.throwIfAborted(); sshRead = true
      const stdout = JSON.stringify({ sources: [], processes: [], metrics: [], truncated: false }); output?.('stdout', stdout)
      return { stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, exitConfirmed: true }
    }, trace: async () => { throw new Error('Unused API') }, observation: async () => { throw new Error('Unused API') }, pipe: async () => { throw new Error('Unused API') } }
  const reader = new RunArchiveReader(driver, runArchivePolicySchema.parse({ archiveRequestTimeoutMs: 1000 }))
  expect(await reader.catalog(record, serverId, undefined, new AbortController().signal)).toMatchObject({ runtimeAvailable: false })
  expect(sshRead).toBe(true)
}, 10000)
afterEach(() => { for (const root of roots.splice(0)) { if (dirname(root) !== base) throw new Error('Test cleanup root differs'); rmSync(root, { recursive: true, force: true }) } })
function fixture() {
  const root = mkdtempSync(resolve(base, 'run-archive-read-')); roots.push(root)
  const runRoot = resolve(root, 'run'); const controlRoot = resolve(root, 'control'); const serverId = randomUUID(); const experimentId = randomUUID()
  mkdirSync(resolve(runRoot, 'workspace/project/logs'), { recursive: true }); mkdirSync(controlRoot)
  writeFileSync(resolve(runRoot, '.aspera-owner.json'), JSON.stringify({ version: 1, serverId, experimentId }))
  writeFileSync(resolve(runRoot, 'events.jsonl'), JSON.stringify({ sessionId: 'exec', source: 'execution', event: { seq: 0, time: 1, type: 'tool/result', data: {} } }) + '\n')
  writeFileSync(resolve(runRoot, 'workspace/project/logs/train.log'), 'loss=0.3\n')
  mkdirSync(resolve(runRoot, 'workspace/models/logs'), { recursive: true }); writeFileSync(resolve(runRoot, 'workspace/models/logs/download.log'), 'weight cache')
  const input = { runRoot, controlRoot, serverId, experimentId, coordinator: true, sessions: { planning: 'plan', execution: 'exec' }, maxEntries: 100,
    logPatterns: ['**/*.log', '**/logs/**/*.txt', '**/logs/**/*.jsonl'], excludeDirectories: ['models', '.venv', 'cache'] }
  return { root, input, runRoot }
}
function call(operation: 'archiveCatalog' | 'archiveRead', input: object): unknown {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', helper + `\nconsole.log(JSON.stringify(${operation}(${JSON.stringify(input)})))`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
}
function catalog(input: object) {
  const raw = call('archiveCatalog', input)
  if (typeof raw !== 'object' || raw === null || !('sources' in raw) || !Array.isArray(raw.sources)) throw new Error('Fixture catalog is unavailable')
  return raw.sources.map(source => {
    if (typeof source !== 'object' || source === null || !('path' in source) || !('generation' in source)) throw new Error('Fixture source is unavailable')
    return { path: String(source.path), generation: String(source.generation) }
  })
}

it('finds owned Agent events and training logs while excluding model caches', () => {
  const f = fixture(); const sources = catalog(f.input)
  expect(sources.some(source => source.path === 'events.jsonl')).toBe(true)
  expect(sources.some(source => source.path === 'workspace/project/logs/train.log')).toBe(true)
  expect(sources.some(source => source.path.includes('models/'))).toBe(false)
  const source = sources.find(source => source.path.endsWith('train.log'))!
  expect(call('archiveRead', { ...f.input, ...source, offset: 0, limit: 3 })).toMatchObject({ data: Buffer.from('los').toString('base64'), offset: 0, nextOffset: 3, eof: false })
})
it('archives owned installer lifetime and reuse records and refuses another experiment record', () => {
  const f = fixture(); const operationId = randomUUID()
  const folder = resolve(f.runRoot, 'environment-runtime-v1'); mkdirSync(folder)
  const file = resolve(folder, operationId + '.json')
  const row = { version: 1, experimentId: f.input.experimentId, serverId: f.input.serverId, operationId, deadline: 1234 }
  writeFileSync(file, JSON.stringify(row))
  expect(catalog(f.input)).toContainEqual(expect.objectContaining({ path: 'environment-runtime-v1/' + operationId + '.json' }))
  writeFileSync(file, JSON.stringify({ ...row, experimentId: randomUUID() }))
  expect(() => catalog(f.input)).toThrow('ownership differs')
})

it('rejects another experiment, traversal and a changed source generation', () => {
  const f = fixture(); const source = catalog(f.input)[0]!
  expect(() => call('archiveCatalog', { ...f.input, experimentId: randomUUID() })).toThrow('ownership')
  expect(() => call('archiveRead', { ...f.input, ...source, path: '../control/private.log', offset: 0, limit: 3 })).toThrow('outside')
  expect(() => call('archiveRead', { ...f.input, ...source, generation: 'different', offset: 0, limit: 3 })).toThrow('generation changed')
})

it('archives material recovery, capacity and historical borrowing records with original ownership', () => {
  const f = fixture(), operationId = randomUUID()
  const paths = ['material-operations-v1/' + operationId + '/receipt.v1.json', 'material-operations-v1/' + operationId + '/receipt-123-original.v1.json',
    'material-operations-v1/' + operationId + '/copy-plan.v1.json', 'storage-plans-v1/' + operationId + '.json',
    'environment-borrowings-v1/training.json', 'material-bindings-v1/' + 'a'.repeat(64) + '.json']
  const row = { version: 1, experimentId: f.input.experimentId, serverId: f.input.serverId, operationId }
  for (const path of paths) {
    const target = resolve(f.runRoot, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, JSON.stringify(row))
  }
  expect(catalog(f.input).map(row => row.path)).toEqual(expect.arrayContaining(paths))
  writeFileSync(resolve(f.runRoot, paths[0]!), JSON.stringify({ ...row, serverId: randomUUID() }))
  expect(() => catalog(f.input)).toThrow('ownership differs')
})

it('rejects symlink escape when the host permits symlink creation', () => {
  const f = fixture(); const outside = resolve(f.root, 'private.log'); const link = resolve(f.runRoot, 'workspace/project/logs/escape.log')
  writeFileSync(outside, 'private')
  try { symlinkSync(outside, link, 'file') }
  catch (error) { if (process.platform === 'win32' && error instanceof Error && 'code' in error && error.code === 'EPERM') return; throw error }
  try { expect(() => call('archiveRead', { ...f.input, path: 'workspace/project/logs/escape.log', generation: 'x', offset: 0, limit: 3 })).toThrow('symbolic links') }
  finally { unlinkSync(link) }
})
