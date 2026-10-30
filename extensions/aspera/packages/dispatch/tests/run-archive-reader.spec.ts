/** The stopped-controller reader accesses owned files without a GPU, account tools or a runtime launch. */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import { experimentIdSchema, serverIdSchema, clusterServerSchema } from '@aspera/experiments'
import type { ClusterRecord } from '@aspera/experiments'
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

it.each(['planning', 'execution'] as const)('archives the declared %s Session before its queue identity is written', async phase => {
  const f = activeCatalog(phase)
  const result = await f.reader.catalog(f.record, f.serverId, undefined, new AbortController().signal)
  expect(result.catalog.sources.find(source => source.kind === 'trace')).toMatchObject({ sessionId: f.sessionId, phase })
})

it('keeps an unconfirmed legacy phase unavailable and rejects a foreign Session declaration', async () => {
  const f = activeCatalog('planning')
  f.catalog.sources.pop()
  expect((await f.reader.catalog(f.record, f.serverId, undefined, new AbortController().signal)).catalog.sources).toEqual([])
  f.catalog.sources.push(f.declaration)
  f.declaration.source.experimentId = experimentIdSchema.parse(randomUUID())
  await expect(f.reader.catalog(f.record, f.serverId, undefined, new AbortController().signal)).rejects.toThrow('another experiment')
})

it('refuses ambiguous phase declarations until the queue confirms a Session', async () => {
  const f = activeCatalog('planning')
  f.catalog.sources.push({ ...f.declaration, id: 'agent-planning-second', source: { ...f.declaration.source, id: 'agent-planning-second', sessionId: 'another-session' } })
  await expect(f.reader.catalog(f.record, f.serverId, undefined, new AbortController().signal)).rejects.toThrow('multiple declared Agent Sessions')
})

function activeCatalog(phase: 'planning' | 'execution') {
  const id = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID()), sessionId = 'owned-' + phase
  const server = clusterServerSchema.parse({ id: serverId, name: 'node', host: 'fixture', username: 'trainer', sshPort: 22,
    remotePort: 43019, remoteRoot: '/owned', authMode: 'password' })
  const record = fromAny<FleetExperiment, object>({ request: { experimentId: id }, servers: [server], coordinator: server,
    submission: { protocol: 4, experimentId: id }, latest: fromAny<ClusterRecord, object>({ state: phase === 'planning' ? 'planning' : 'running' }) })
  const declaration = { id: 'agent-' + phase, path: 'observations-v1/agent-' + phase + '.jsonl', kind: 'log' as const,
    format: 'observations' as const, generation: 'one', size: 0, modifiedAt: 1,
    source: { version: 1 as const, id: 'agent-' + phase, experimentId: id, serverId, sessionId, phase, kind: 'agent' as const,
      label: phase, streams: ['stdout' as const, 'stderr' as const], createdAt: 1, complete: false } }
  const catalog = { sources: [{ id: 'trace-' + phase, path: 'events.jsonl', kind: 'trace' as const, format: 'events' as const,
    generation: 'one', size: 10, modifiedAt: 1, phase, sessionId: 'unconfirmed' }, declaration], processes: [], metrics: [], truncated: false }
  const driver: ArchiveReadDriver = { connection: async () => ({ target: { host: 'fixture', sshPort: 22, remotePort: 43019, toolTimeoutMs: 1000 } }),
    rpc: async () => { throw new Error('HTTP 404') }, remoteResult: async () => ({ stdout: JSON.stringify(catalog), stderr: '', exitCode: 0,
      signal: null, timedOut: false, cancelled: false, exitConfirmed: true }), trace: async () => { throw new Error('Unused API') },
    observation: async () => { throw new Error('Unused API') }, pipe: async () => { throw new Error('Unused API') } }
  return { record, serverId, sessionId, declaration, catalog, reader: new RunArchiveReader(driver, runArchivePolicySchema.parse({})) }
}
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
it('archives immutable stage retry records offline and refuses another execution Session', () => {
  const f = fixture(), stageId = 'first', attemptId = 'attempt1'
  const folder = resolve(f.runRoot, 'stage-attempts-v1', f.input.serverId + '_' + stageId); mkdirSync(folder, { recursive: true })
  const path = resolve(folder, attemptId + '.json')
  const row = { version: 1, previousAttemptId: attemptId, previousCommand: { commandId: 'failed', state: 'failed', exitCode: 1, released: true },
    registration: { experimentId: f.input.experimentId, serverId: f.input.serverId, stageId, sessionId: 'exec' } }
  writeFileSync(path, JSON.stringify(row) + '\n')
  const source = catalog(f.input).find(value => value.path.endsWith('/attempt1.json'))
  expect(source).toBeDefined()
  expect(call('archiveRead', { ...f.input, ...source, offset: 0, limit: 65536 })).toMatchObject({ eof: true })
  row.registration.sessionId = 'other'
  writeFileSync(path, JSON.stringify(row))
  expect(() => catalog(f.input)).toThrow('ownership')
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

it('archives checkpoint retention without starting controllers and rejects another node', () => {
  const f = fixture(), owner = { experimentId: f.input.experimentId, serverId: f.input.serverId }
  for (const kind of ['registrations', 'sealed']) {
    const directory = resolve(f.runRoot, 'checkpoint-protection-v1', kind); mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, 'fixture.json'), JSON.stringify({ version: 1, ...(kind === 'registrations' ? { registration: owner } : owner) }))
  }
  const sources = catalog(f.input)
  expect(sources.filter(row => row.path.startsWith('checkpoint-protection-v1/'))).toHaveLength(2)
  writeFileSync(resolve(f.runRoot, 'checkpoint-protection-v1/sealed/fixture.json'), JSON.stringify({ version: 1, ...owner, serverId: randomUUID() }))
  expect(() => catalog(f.input)).toThrow('retention ownership')
})
it('archives original public service checks and rejects a substituted operation', () => {
  const f = fixture(), operationId = randomUUID(), folder = resolve(f.runRoot, 'service-verifications-v1')
  mkdirSync(folder)
  const file = resolve(folder, operationId + '.json'), row = { version: 1, experimentId: f.input.experimentId,
    serverId: f.input.serverId, input: { operationId }, state: 'passed' }
  writeFileSync(file, JSON.stringify(row))
  expect(catalog(f.input)).toContainEqual(expect.objectContaining({ path: 'service-verifications-v1/' + operationId + '.json' }))
  writeFileSync(file, JSON.stringify({ ...row, input: { operationId: randomUUID() } }))
  expect(() => catalog(f.input)).toThrow('verification identity')
})

it('archives full repair proposals, measured differences and reference confirmations with their own identities', () => {
  const f = fixture(); const identifier = 'e'.repeat(64)
  const row = { version: 1, experimentId: f.input.experimentId, serverId: f.input.serverId, id: identifier }
  for (const [folder, value] of [
    ['environment-diagnostics-v1', { diagnostic: row, sourceState: { observed: true } }],
    ['environment-repair-plans-v1', { plan: row, sourceStates: [] }],
    ['environment-reference-releases-v1', row],
  ]) {
    const directory = resolve(f.runRoot, String(folder)); mkdirSync(directory)
    writeFileSync(resolve(directory, identifier + '.json'), JSON.stringify(value))
    expect(catalog(f.input)).toContainEqual(expect.objectContaining({ path: folder + '/' + identifier + '.json' }))
  }
  writeFileSync(resolve(f.runRoot, 'environment-repair-plans-v1', identifier + '.json'),
    JSON.stringify({ plan: { ...row, experimentId: randomUUID() } }))
  expect(() => catalog(f.input)).toThrow()
})

it('archives authenticated input proofs, metadata derivations and manager exits with their original ownership', () => {
  const f = fixture(), operationId = randomUUID()
  const row = { version: 1, experimentId: f.input.experimentId, serverId: f.input.serverId, operationId }
  const entries = [
    ['input-verifications-v1', 'a'.repeat(64) + '.json'],
    ['cache-maintenance-v1', 'manager-cache-' + 'b'.repeat(64) + '.json'],
    ['input-sharing-v1', 'input-duplicate-' + 'c'.repeat(64) + '.json'],
    ['release-asset-sharing-v1', 'release-asset-duplicate-' + 'd'.repeat(64) + '.json'],
    ['environment-operations-v1/' + operationId, 'wheel-derivations.v1.json'],
  ]
  for (const [folder, name] of entries) {
    const directory = resolve(f.runRoot, folder!); mkdirSync(directory, { recursive: true })
    writeFileSync(resolve(directory, name!), JSON.stringify(row))
  }
  expect(catalog(f.input).map(source => source.path)).toEqual(expect.arrayContaining(entries.map(([folder, name]) => folder + '/' + name)))
  writeFileSync(resolve(f.runRoot, entries[0]![0]!, entries[0]![1]!), JSON.stringify({ ...row, experimentId: randomUUID() }))
  expect(() => catalog(f.input)).toThrow('ownership')
})

it('archives discovery, source selection and complete tool snapshots after controllers stop', () => {
  const f = fixture(), operationId = randomUUID()
  const paths = ['reuse-verifications-v1/material/' + operationId + '/discovery.v1.json',
    'reuse-verifications-v1/environment/' + operationId + '/selection.v1.json',
    'storage-tool-observations-v1/' + randomUUID() + '/' + 'a'.repeat(64) + '.json',
    'environment-read-diagnostics-v1/' + operationId + '/result.v1.json']
  for (const path of paths) {
    const target = resolve(f.runRoot, path); mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, JSON.stringify({ version: 1, experimentId: f.input.experimentId, serverId: f.input.serverId, operationId }))
  }
  const error = 'environment-read-diagnostics-v1/' + operationId + '/stderr.log'
  writeFileSync(resolve(f.runRoot, error), 'original scan timeout stderr\n')
  expect(catalog(f.input).map(row => row.path)).toEqual(expect.arrayContaining([...paths, error]))
  writeFileSync(resolve(f.runRoot, paths[0]!), JSON.stringify({ version: 1, experimentId: randomUUID(), serverId: f.input.serverId }))
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
    'material-operations-v1/' + operationId + '/copy-plan.v1.json', 'material-operations-v1/' + operationId + '/source-0.1.2.json',
    'material-publications-0.1.2/' + 'a'.repeat(64) + '.json', 'storage-plans-v1/' + operationId + '.json',
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
