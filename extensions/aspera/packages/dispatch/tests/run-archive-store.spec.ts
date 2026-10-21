/** Local copy recovery and ownership are exercised without a live controller or shared home. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { agentRecordSchema, experimentIdSchema, serverIdSchema, metricSampleSchema, clusterSubmissionSchema, clusterRecordSchema } from '@aspera/experiments'
import { inventory, modelSnapshots, placement } from '../../experiments/tests/fixtures.ts'
import { RunArchiveStore, archiveRemoteSourceSchema, archiveHash } from '../src/run-archive-store.ts'

const roots: string[] = []
const base = resolve('.artifacts'); mkdirSync(base, { recursive: true })
afterEach(() => { for (const root of roots.splice(0)) { if (dirname(root) !== base) throw new Error('Test cleanup root differs'); rmSync(root, { recursive: true, force: true }) } })
function fixture(capacity?: (path: string) => number) {
  const root = mkdtempSync(resolve(base, 'run-archive-store-')); roots.push(root)
  const id = experimentIdSchema.parse(randomUUID()); const server = serverIdSchema.parse(randomUUID()); const digest = 'a'.repeat(64)
  const open = () => new RunArchiveStore(root, id, digest, 0, capacity)
  return { root, id, server, digest, open, store: open() }
}
function trace() { return archiveRemoteSourceSchema.parse({ id: 'trace-execution', path: 'events.jsonl', kind: 'trace', format: 'events',
  phase: 'execution', sessionId: 'exec', generation: 'physical-1', size: 10000, modifiedAt: 1 }) }

it('reopens complete events with their original sequences, paginates history and refuses another submission', () => {
  const f = fixture(); const stream = f.store.source(f.server, trace())
  const rows = [0, 1, 2].map(seq => agentRecordSchema.parse({ experimentId: f.id, phase: 'execution', sessionId: 'exec', seq,
    time: seq + 10, type: 'tool/result', data: JSON.stringify({ content: 'x'.repeat(seq === 1 ? 100000 : 1) }), truncated: false }))
  f.store.commit(stream, rows, 10000, true, 100)
  const reopened = f.open()
  expect(reopened.records({ experimentId: f.id, phase: 'execution', cursor: { experimentId: f.id, phase: 'execution', sessionId: 'exec',
    generation: 'physical-1', nextSeq: 2 } })?.reset).toBe(false)
  expect(reopened.records({ experimentId: f.id, phase: 'execution', limit: 2 })?.records.map(row => row.seq)).toEqual([1, 2])
  expect(reopened.records({ experimentId: f.id, phase: 'execution', beforeSeq: 1, limit: 2 })?.records.map(row => row.seq)).toEqual([0])
  expect(reopened.records({ experimentId: f.id, phase: 'execution', beforeSeq: 2, limit: 1 })?.records[0]?.data).toBe(rows[1]!.data)
  expect(() => new RunArchiveStore(f.root, f.id, 'b'.repeat(64), 0)).toThrow('another experiment or submission')
  expect(() => reopened.records({ experimentId: f.id, phase: 'execution', cursor: { experimentId: randomUUID(), phase: 'execution', sessionId: 'exec', nextSeq: 0 } })).toThrow('another experiment')
})

it('keeps replacement and truncated generations readable without treating EOF as experiment success', () => {
  const f = fixture(); const source = archiveRemoteSourceSchema.parse({ id: 'training', path: 'workspace/logs/train.log', kind: 'log',
    format: 'text', generation: 'one', size: 9, modifiedAt: 1, stream: 'mixed', label: 'train.log' })
  f.store.commit(f.store.source(f.server, source), [{ seq: 0, stream: 'mixed', text: '原始记录\n' }], 9, true, 10)
  const before = f.store.logSources(f.server)[0]!
  const next = f.store.source(f.server, { ...source, size: 3, modifiedAt: 2 })
  f.store.commit(next, [{ seq: 0, stream: 'mixed', text: '新\n' }], 3, true, 20)
  expect(f.store.logSources(f.server)).toHaveLength(2)
  expect(f.store.log({ experimentId: f.id, serverId: f.server, sourceId: before.id, fromStart: true })?.lines[0]?.text).toBe('原始记录\n')
  expect(f.store.status()).toMatchObject({ complete: false, sources: [{ complete: false }, { complete: false }] })
  expect(f.store.status().sources[0]?.gaps).not.toHaveLength(0)
  const replacement = f.store.source(f.server, { ...source, size: 3, modifiedAt: 3 })
  f.store.commit(replacement, [{ seq: 0, stream: 'mixed', text: '替\n' }], 3, true, 30)
  expect(f.store.logSources(f.server)).toHaveLength(3)
  expect(f.store.log({ experimentId: f.id, serverId: f.server, sourceId: f.store.logSources(f.server)[0]!.id, fromStart: true })?.lines[0]?.text).toBe('替\n')
})

it('does not publish cursor changes after a disk write fails and resumes without replaying committed output', () => {
  let free = 10000000
  const f = fixture(() => free); const source = archiveRemoteSourceSchema.parse({ id: 'pipe', path: 'process-logs/c/stdout.log',
    kind: 'process-log', commandId: 'c', stream: 'stdout', format: 'text', generation: 'one', size: 30, modifiedAt: 1 })
  const stream = f.store.source(f.server, source)
  f.store.commit(stream, [{ seq: 0, stream: 'stdout', text: 'first\n' }], 6, false, 1)
  free = 0
  expect(() => f.store.commit(stream, [{ seq: 6, stream: 'stdout', text: 'second\n' }], 13, false, 2)).toThrow('disk reserve')
  free = 10000000
  const recovered = f.open(); const cursor = recovered.source(f.server, source)
  expect(cursor.remoteOffset).toBe(6)
  recovered.commit(cursor, [{ seq: 0, stream: 'stdout', text: 'first\n' }, { seq: 6, stream: 'stdout', text: 'second\n' }], 13, true, 3)
  expect(Buffer.from(recovered.processLog({ experimentId: f.id, serverId: f.server, commandId: 'c', stream: 'stdout' }, 65536)!.chunk.data, 'base64').toString()).toBe('first\nsecond\n')
  expect(() => recovered.processLog({ experimentId: f.id, serverId: f.server, commandId: 'c', stream: 'stdout', cursor: {
    experimentId: f.id, serverId: randomUUID(), commandId: 'c', stream: 'stdout', generation: 'bad', offset: 0 } }, 65536)).toThrow('another command')
})

it('rolls back the index when a complete data block was written but the index cannot be committed', () => {
  let calls = 0; let failIndex = false
  const f = fixture(() => failIndex && ++calls === 2 ? 0 : 10000000)
  const source = archiveRemoteSourceSchema.parse({ id: 'large-log', path: 'workspace/logs/output.log', kind: 'log', format: 'text',
    generation: 'one', size: 20000, modifiedAt: 1, stream: 'mixed' })
  const stream = f.store.source(f.server, source)
  f.store.commit(stream, [{ seq: 0, stream: 'mixed', text: 'before\n' }], 7, false, 1)
  failIndex = true
  expect(() => f.store.commit(stream, [{ seq: 7, stream: 'mixed', text: 'after'.repeat(4000) }], 20000, true, 2)).toThrow('disk reserve')
  failIndex = false
  const reopened = f.open(); const current = reopened.source(f.server, source)
  expect(current.remoteOffset).toBe(7)
  reopened.commit(current, [{ seq: 7, stream: 'mixed', text: 'after'.repeat(4000) }], 20000, true, 3)
  const log = reopened.logSources(f.server)[0]!
  expect(reopened.log({ experimentId: f.id, serverId: f.server, sourceId: log.id, limit: 1024 })?.lines[0]?.text).toBe('after'.repeat(4000))
})

it('preserves equal-time metric series, rejects foreign ownership and detects corrupted committed blocks', () => {
  const f = fixture()
  const resource = metricSampleSchema.parse({ experimentId: f.id, serverId: f.server, time: 10, gpus: [] })
  const training = { ...resource, training: { loss: 0.1 } }
  const catalog = { sources: [], processes: [], metrics: [resource, training, resource], truncated: false }
  f.store.facts(catalog, f.server, false); f.store.facts(catalog, f.server, false)
  expect(f.store.metrics({ experimentId: f.id, serverId: f.server })).toHaveLength(2)
  expect(() => f.store.facts({ ...catalog, metrics: [{ ...resource, experimentId: experimentIdSchema.parse(randomUUID()) }] }, f.server, false)).toThrow('another experiment')
  const block = resolve(f.root, f.id, archiveHash([resource, training]) + '.json')
  expect(existsSync(block)).toBe(true)
  writeFileSync(block, '[]\n')
  expect(() => f.open().metrics({ experimentId: f.id, serverId: f.server })).toThrow('integrity')
})

it('does not reopen completed command metadata or fabricate a missing step report', () => {
  const f = fixture()
  f.store.facts({ sources: [], processes: [{ experimentId: f.id, serverId: f.server, commandId: 'train', command: 'train', streams: ['stdout'], state: 'completed', exitCode: 0, released: true }], metrics: [], truncated: false }, f.server, false)
  const recovered = f.open()
  expect(recovered.processes(f.server)[0]).toMatchObject({ state: 'completed', exitCode: 0 })
  expect(recovered.progress()).toBeUndefined()
  expect(readdirSync(resolve(f.root, f.id)).every(name => !name.endsWith('.incoming'))).toBe(true)
  expect(readFileSync(resolve(f.root, f.id, 'manifest.v1.json'), 'utf8')).not.toContain('progress.json')
})

it('keeps terminal output open until the associated command is confirmed released', () => {
  const f = fixture()
  const server = { id: f.server, name: 'node', host: 'fixture', username: 'trainer', sshPort: 22, remotePort: 43019, remoteRoot: '/owned', authMode: 'password',
    storagePlacement: placement(f.server, f.id, '/owned') }
  const submission = clusterSubmissionSchema.parse({ protocol: 4, name: 'cached', experimentId: f.id, models: modelSnapshots(), deploymentId: 'a'.repeat(64),
    inventories: [{ serverId: f.server, inventory: inventory('/owned') }], objective: 'saved output', coordinator: server,
    nodes: [{ server, devicePaths: ['/dev/nvidia0'], backendPath: '/usr/bin/bwrap', hiddenPaths: [], gpuInfo: 'CPU fixture' }], inputs: [], createdAt: 1,
    strategy: { mode: 'automatic', coordinator: 'single-agent' }, versions: { dsh: '0.2.0-rc.2', extension: '0.1.1', harness: 'a'.repeat(64), data: [] } })
  const record = clusterRecordSchema.parse({ submission, payloadHash: 'b'.repeat(64), sequence: 1, revision: 1, state: 'completed',
    resourcesReleased: true, updatedAt: 1, handover: '本机派发完成，远端实验已接管' })
  const store = new RunArchiveStore(f.root, f.id, archiveHash(submission), 0)
  const process = { experimentId: f.id, serverId: f.server, commandId: 'service', command: 'service', streams: ['stdout' as const], state: 'running' as const, released: false, exitCode: null }
  const catalog = { sources: [], processes: [process], metrics: [], record, truncated: false }
  store.facts(catalog, f.server, true); store.health('caught-up', 2)
  expect(store.status().complete).toBe(false)
  expect(store.settled([f.server])).toBe(false)
  store.facts({ ...catalog, processes: [{ ...process, state: 'completed', released: true, exitCode: 0 }] }, f.server, true)
  expect(store.status().complete).toBe(true)
  expect(store.settled([f.server])).toBe(true)
  expect(store.settled([f.server, serverIdSchema.parse(randomUUID())])).toBe(false)
  store.facts({ ...catalog, processes: [{ ...process, state: 'interrupted', released: true }] }, f.server, true)
  expect(store.settled([f.server])).toBe(true)
  store.health('disconnected', 3, 'SSH unavailable')
  expect(store.status().complete).toBe(false)
})
