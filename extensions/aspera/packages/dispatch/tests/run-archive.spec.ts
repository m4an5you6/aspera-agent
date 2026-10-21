/** Page-independent synchronization, durable continuation and quiescent deletion use explicit read barriers. */
import { fromAny } from '@total-typescript/shoehorn'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema, clusterServerSchema } from '@aspera/experiments'
import type { ClusterRecord } from '@aspera/experiments'
import type { FleetExperiment } from '../src/types.ts'
import { RunArchives } from '../src/run-archive.ts'
import { runArchivePolicySchema } from '../src/run-archive-reader.ts'
import type { RunArchiveReader } from '../src/run-archive-reader.ts'
import { archiveRemoteSourceSchema } from '../src/run-archive-store.ts'

const base = resolve('.artifacts'); mkdirSync(base, { recursive: true })
const fixtures: { root: string; archive: RunArchives }[] = []
afterEach(async () => {
  try { for (const f of fixtures.splice(0)) { await f.archive.close(); if (dirname(f.root) !== base) throw new Error('Test cleanup root differs'); rmSync(f.root, { recursive: true, force: true }) } }
  finally { vi.useRealTimers() }
})
function fixture(content: Buffer, format: 'events' | 'text' | 'observations' = 'events', pages = 16) {
  const root = mkdtempSync(resolve(base, 'run-archive-'))
  const id = experimentIdSchema.parse(randomUUID()); const serverId = serverIdSchema.parse(randomUUID())
  const server = clusterServerSchema.parse({ id: serverId, name: 'GPU node', host: 'fixture', username: 'trainer', sshPort: 22, remotePort: 43019, remoteRoot: '/owned', authMode: 'password' })
  const record = fromAny<FleetExperiment, object>({ request: { experimentId: id }, createdAt: 1, servers: [server], coordinator: server,
    submission: { protocol: 4, experimentId: id }, receipt: {}, latest: {} })
  let bytes = content; let removed = false; let unavailable = false
  const source = archiveRemoteSourceSchema.parse({ id: format === 'events' ? 'trace-execution' : 'training', path: format === 'events' ? 'events.jsonl' : 'workspace/logs/train.log',
    kind: format === 'events' ? 'trace' : 'log', format, phase: 'execution', sessionId: 'exec', generation: 'one', size: content.length, modifiedAt: 1, stream: 'mixed' })
  const reader: Pick<RunArchiveReader, 'catalog' | 'bytes' | 'trace' | 'observation' | 'pipe'> = {
    catalog: vi.fn(async () => { if (unavailable) throw new Error('SSH ECONNREFUSED'); return { catalog: { sources: [{ ...source, size: bytes.length }], processes: [], metrics: [], truncated: false }, runtimeAvailable: false } }),
    bytes: vi.fn(async (_record, _server, _source, offset) => {
      const part = bytes.subarray(offset, offset + 1024)
      return { data: part.toString('base64'), offset, nextOffset: offset + part.length, generation: 'one', length: bytes.length, eof: offset + part.length === bytes.length, reset: false }
    }),
    trace: vi.fn(async () => undefined), observation: vi.fn(async () => undefined), pipe: vi.fn(async () => undefined),
  }
  const owner = { list: () => [record], get: () => record, alive: () => !removed, secrets: async () => ['top-secret'], observe: async () => {} }
  const policy = runArchivePolicySchema.parse({ archiveReadBytes: 1024, archiveBatchPages: pages, archiveMinimumFreeBytes: 0 })
  const archive = new RunArchives(root, owner, reader, policy)
  fixtures.push({ root, archive })
  return { id, root, serverId, record, archive, reader, owner, policy, content: (next: Buffer) => { bytes = next },
    offline: (value = true) => { unavailable = value }, remove: () => { removed = true } }
}
function event(seq: number, text: string) { return JSON.stringify({ source: 'execution', sessionId: 'exec', event: { seq, time: 100 + seq, type: 'assistant/message', data: { text } } }) + '\n' }
async function synchronize(f: ReturnType<typeof fixture>) { f.archive.request(f.id); await f.archive.settled(f.id) }

function release(f: ReturnType<typeof fixture>, state: ClusterRecord['state'] = 'completed') {
  f.record.latest = fromAny<ClusterRecord, object>({ submission: f.record.submission, state, resourcesReleased: true, updatedAt: Date.now(), sessionId: 'exec' })
  const original = f.reader.catalog
  f.reader.catalog = vi.fn(async (...args: Parameters<RunArchiveReader['catalog']>) => {
    const result = await original(...args)
    return { ...result, catalog: { ...result.catalog, record: f.record.latest } }
  })
}

it('waits fifteen seconds after a round finishes and keeps the previous success visible during the next check', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const f = fixture(Buffer.from(event(0, 'saved')))
  f.archive.start(); await f.archive.settled(f.id)
  expect(f.archive.status(f.id)).toMatchObject({ state: 'caught-up', lastSyncedAt: 0 })
  let resume: (() => void) | undefined
  const barrier = new Promise<void>(resolve => { resume = resolve })
  const original = f.reader.catalog
  f.reader.catalog = vi.fn(async (...args: Parameters<RunArchiveReader['catalog']>) => { await barrier; return original(...args) })
  try {
    await vi.advanceTimersByTimeAsync(14999)
    expect(f.reader.catalog).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(f.reader.catalog).toHaveBeenCalledTimes(1)
    expect(f.archive.status(f.id)).toMatchObject({ state: 'caught-up', lastSyncedAt: 0 })
    await vi.advanceTimersByTimeAsync(4000)
    resume!(); await f.archive.settled(f.id)
    expect(f.archive.status(f.id).lastSyncedAt).toBe(19000)
    await vi.advanceTimersByTimeAsync(14999)
    expect(f.reader.catalog).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.reader.catalog).toHaveBeenCalledTimes(2)
  } finally { resume?.() }
})

it('accelerates a bounded backlog to five seconds and returns to fifteen seconds when caught up', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const f = fixture(Buffer.from(event(0, 'x'.repeat(1800))), 'events', 1)
  f.archive.start(); await f.archive.settled(f.id)
  expect(f.archive.status(f.id).state).toBe('syncing')
  await vi.advanceTimersByTimeAsync(4999)
  expect(f.reader.catalog).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.reader.catalog).toHaveBeenCalledTimes(2)
  expect(f.archive.status(f.id).state).toBe('caught-up')
  await vi.advanceTimersByTimeAsync(14999)
  expect(f.reader.catalog).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.reader.catalog).toHaveBeenCalledTimes(3)
})

it.each(['awaiting-approval', 'waiting-reply'] as const)('checks %s every thirty seconds while retaining owned process logs', async state => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const f = fixture(Buffer.from(event(0, 'waiting')))
  f.record.latest = fromAny<ClusterRecord, object>({ state })
  f.archive.start(); await f.archive.settled(f.id)
  f.content(Buffer.from(event(0, 'waiting') + event(1, 'managed process output')))
  await vi.advanceTimersByTimeAsync(29999)
  expect(f.reader.catalog).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.reader.catalog).toHaveBeenCalledTimes(2)
  expect(f.archive.store(f.id)?.records({ experimentId: f.id, phase: 'execution' })?.records).toHaveLength(2)
})

it('backs failures off at ten, twenty, forty and sixty seconds and resets after recovery', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const f = fixture(Buffer.from(event(0, 'recover')))
  f.offline(); f.archive.start(); await f.archive.settled(f.id)
  let calls = 1
  for (const wait of [10000, 20000, 40000, 60000, 60000]) {
    await vi.advanceTimersByTimeAsync(wait - 1)
    expect(f.reader.catalog).toHaveBeenCalledTimes(calls)
    await vi.advanceTimersByTimeAsync(1)
    expect(f.reader.catalog).toHaveBeenCalledTimes(++calls)
  }
  f.offline(false)
  await vi.advanceTimersByTimeAsync(60000)
  expect(f.archive.status(f.id).state).toBe('caught-up')
  await vi.advanceTimersByTimeAsync(14999)
  expect(f.reader.catalog).toHaveBeenCalledTimes(calls + 1)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.reader.catalog).toHaveBeenCalledTimes(calls + 2)
})

it('manual synchronization bypasses a deadline once and replaces the scheduled retry', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const f = fixture(Buffer.from(event(0, 'manual')))
  f.offline(); f.archive.start(); await f.archive.settled(f.id)
  await vi.advanceTimersByTimeAsync(3000)
  f.offline(false); f.archive.request(f.id); f.archive.request(f.id)
  await f.archive.settled(f.id)
  expect(f.reader.catalog).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(14999)
  expect(f.reader.catalog).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(f.reader.catalog).toHaveBeenCalledTimes(3)
})

it.each(['completed', 'failed', 'cancelled', 'blocked', 'interrupted'] as const)('takes an immediate final copy for %s then stops polling without erasing historical gaps', async state => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const f = fixture(Buffer.from(event(0, 'before completion')))
  f.archive.start(); await f.archive.settled(f.id)
  f.archive.store(f.id)!.gap('Earlier metric samples are unavailable; only the retained remote window was recovered')
  f.content(Buffer.from(event(0, 'before completion') + event(1, 'final output')))
  release(f, state); f.archive.changed(f.id); await f.archive.settled(f.id)
  expect(f.reader.catalog).toHaveBeenCalledTimes(1)
  expect(f.archive.store(f.id)?.records({ experimentId: f.id, phase: 'execution' })?.records).toHaveLength(2)
  expect(f.archive.status(f.id)).toMatchObject({ state: 'incomplete', complete: false })
  await vi.advanceTimersByTimeAsync(120000)
  expect(f.reader.catalog).toHaveBeenCalledTimes(1)
  f.archive.request(f.id); await f.archive.settled(f.id)
  expect(f.reader.catalog).toHaveBeenCalledTimes(2)
})

it('retries a failed final copy before stopping and resumes a final read after reopening saved cursors', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0)
  const f = fixture(Buffer.from(event(0, 'final')))
  release(f); f.offline(); f.archive.start(); await f.archive.settled(f.id)
  f.offline(false)
  await vi.advanceTimersByTimeAsync(10000)
  expect(f.archive.status(f.id).complete).toBe(true)
  await f.archive.close()
  const recovered = new RunArchives(f.root, f.owner, f.reader, f.policy)
  fixtures.push({ root: mkdtempSync(resolve(base, 'run-archive-empty-')), archive: recovered })
  const before = vi.mocked(f.reader.catalog).mock.calls.length
  recovered.start(); await recovered.settled(f.id)
  expect(f.reader.catalog).toHaveBeenCalledTimes(before + 1)
  expect(recovered.store(f.id)?.records({ experimentId: f.id, phase: 'execution' })?.records).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(120000)
  expect(f.reader.catalog).toHaveBeenCalledTimes(before + 1)
})

it('copies complete events before any page is opened and retains them after the SSH connection fails', async () => {
  const f = fixture(Buffer.from(event(0, 'top-secret')))
  await synchronize(f)
  const page = f.archive.store(f.id)?.records({ experimentId: f.id, phase: 'execution' })
  expect(page?.records).toHaveLength(1)
  expect(page?.records[0]?.data).not.toContain('top-secret')
  f.offline(); await synchronize(f)
  expect(f.archive.status(f.id)).toMatchObject({ state: 'disconnected', runtimeAvailable: false, complete: false })
  expect(f.archive.store(f.id)?.records({ experimentId: f.id, phase: 'execution' })?.records).toEqual(page?.records)
  for (const file of readdirSync(resolve(f.root, f.id)).filter(file => file.endsWith('.json'))) expect(readFileSync(resolve(f.root, f.id, file), 'utf8')).not.toContain('top-secret')
})

it('continues oversized and incomplete JSON across bounded rounds and restart without duplicating events', async () => {
  const line = event(0, '汉字'.repeat(3000))
  const f = fixture(Buffer.from(line.slice(0, -1)), 'events', 2)
  for (let index = 0; index < 12; index++) await synchronize(f)
  expect(f.archive.store(f.id)?.records({ experimentId: f.id, phase: 'execution' })?.records).toHaveLength(0)
  await f.archive.close()
  const recovered = new RunArchives(f.root, f.owner, f.reader, f.policy)
  fixtures.push({ root: mkdtempSync(resolve(base, 'run-archive-empty-')), archive: recovered })
  f.content(Buffer.from(line))
  for (let index = 0; index < 12; index++) { recovered.request(f.id); await recovered.settled(f.id) }
  expect(recovered.store(f.id)?.records({ experimentId: f.id, phase: 'execution' })?.records).toHaveLength(1)
  expect(JSON.parse(recovered.store(f.id)!.records({ experimentId: f.id, phase: 'execution' })!.records[0]!.data).text).toBe('汉字'.repeat(3000))
  recovered.request(f.id); await recovered.settled(f.id)
  expect(recovered.store(f.id)?.records({ experimentId: f.id, phase: 'execution' })?.records).toHaveLength(1)
})

it('captures UTF-8 text and split credentials with real source positions and no fabricated line times', async () => {
  const input = '中'.repeat(1800) + ' password=top-secret\n' + '文'.repeat(1800) + '\n'
  const f = fixture(Buffer.from(input), 'text', 20)
  await synchronize(f)
  const source = f.archive.store(f.id)!.logSources(f.serverId)[0]!
  const page = f.archive.store(f.id)!.log({ experimentId: f.id, serverId: f.serverId, sourceId: source.id, fromStart: true, limit: 65536 })!
  const text = page.lines.map(line => line.text).join('')
  expect(text).toContain('中'.repeat(1800)); expect(text).toContain('文'.repeat(1800)); expect(text).not.toContain('top-secret')
  expect(page.lines.every(line => line.time === undefined)).toBe(true)
  expect(f.archive.status(f.id).complete).toBe(false)
})

it('waits for blocked reads and rejects their late completion before deletion', async () => {
  const f = fixture(Buffer.from(event(0, 'late')))
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const ready = new Promise<void>(resolveReady => { entered = resolveReady })
  const barrier = new Promise<void>(resolveBarrier => { release = resolveBarrier })
  const original = f.reader.bytes
  f.reader.bytes = async (...args) => { entered!(); await barrier; return original(...args) }
  f.archive.request(f.id); await ready; f.remove()
  let stopped = false; const stop = f.archive.stop(f.id).then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false)
  release!(); await stop
  expect(readdirSync(resolve(f.root, f.id)).filter(name => /^[a-f0-9]{64}\.json$/.test(name))).toHaveLength(0)
})

it('starts its own profile timer and suppresses duplicate synchronization requests', async () => {
  const f = fixture(Buffer.from(event(0, 'background')))
  f.archive.start(); f.archive.request(f.id); f.archive.request(f.id)
  await f.archive.settled(f.id)
  expect(f.reader.catalog).toHaveBeenCalledTimes(1)
  expect(f.archive.store(f.id)?.records({ experimentId: f.id, phase: 'execution' })?.records).toHaveLength(1)
})

it('rejects a different saved Session before copying any event', async () => {
  const f = fixture(Buffer.from(event(0, 'foreign').replace('"sessionId":"exec"', '"sessionId":"other"')))
  await synchronize(f)
  expect(f.archive.status(f.id)).toMatchObject({ state: 'paused', complete: false })
  expect(f.archive.store(f.id)?.records({ experimentId: f.id, phase: 'execution' })?.records).toHaveLength(0)
})

it('serializes two experiments sharing a server while retaining independent copies', async () => {
  const f = fixture(Buffer.from(event(0, 'shared server')))
  const secondId = experimentIdSchema.parse(randomUUID())
  const second = { ...f.record, request: { ...f.record.request, experimentId: secondId }, submission: { ...f.record.submission!, experimentId: secondId } }
  let release: (() => void) | undefined; let entered: (() => void) | undefined; let secondQueued: (() => void) | undefined
  const ready = new Promise<void>(resolveReady => { entered = resolveReady })
  const queued = new Promise<void>(resolveQueued => { secondQueued = resolveQueued })
  const barrier = new Promise<void>(resolveBarrier => { release = resolveBarrier })
  const calls: string[] = []; const original = f.reader.catalog
  f.reader.catalog = async (...args) => {
    calls.push(args[0].request.experimentId)
    if (args[0].request.experimentId === f.id) { entered!(); await barrier }
    return original(...args)
  }
  const archive = new RunArchives(f.root, { list: () => [f.record, second], get: id => id === f.id ? f.record : second,
    alive: () => true, secrets: async record => { if (record.request.experimentId === secondId) secondQueued!(); return [] }, observe: async () => {} }, f.reader, f.policy)
  try {
    archive.request(f.id); await ready; archive.request(secondId); await queued
    expect(calls).toEqual([f.id])
    release!(); await Promise.all([archive.settled(f.id), archive.settled(secondId)])
    expect(calls).toEqual([f.id, secondId])
    expect(archive.store(secondId)?.records({ experimentId: secondId, phase: 'execution' })?.records[0]?.experimentId).toBe(secondId)
  } finally { release?.(); await archive.close() }
})

it('keeps the round owned until every node read finishes after another node fails', async () => {
  const f = fixture(Buffer.from(event(0, 'multi-node')))
  const second = { ...f.record.servers[0]!, id: serverIdSchema.parse(randomUUID()) }
  f.record.servers.push(second)
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const ready = new Promise<void>(resolveReady => { entered = resolveReady })
  const barrier = new Promise<void>(resolveBarrier => { release = resolveBarrier })
  const original = f.reader.catalog
  f.reader.catalog = async (...args) => {
    if (args[1] === f.serverId) throw new Error('SSH node A unavailable')
    entered!(); await barrier
    return original(...args)
  }
  f.archive.request(f.id); await ready
  let settled = false
  const waiting = f.archive.settled(f.id).then(() => { settled = true })
  await Promise.resolve(); expect(settled).toBe(false)
  release!(); await waiting
  expect(f.archive.status(f.id).state).toBe('disconnected')
})
