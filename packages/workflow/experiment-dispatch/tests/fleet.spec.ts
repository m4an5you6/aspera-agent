/** Independent dispatch identities, pinned destinations, and durable receipt recovery. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clusterRecordSchema, clusterServerSchema } from '@deepseek-ai/dsh-experiment-worker'
import type { ClusterSubmission } from '@deepseek-ai/dsh-experiment-worker'
import { ExperimentFleet } from '../src/fleet.ts'
import type { FleetExperiment } from '../src/types.ts'
import { request } from '../src/transport.ts'
import { snapshotSource } from '../src/snapshot.ts'
import { prepareClusterServer } from '../src/cluster-deploy.ts'

vi.mock('../src/transport.ts', () => ({ request: vi.fn(), remote: vi.fn(async () => ''), copy: vi.fn(),
  shellQuote: (value: string) => value }))
vi.mock('../src/deploy.ts', () => ({ installPrivateFile: vi.fn() }))
vi.mock('../src/snapshot.ts', () => ({ snapshotSource: vi.fn() }))
vi.mock('../src/cluster-deploy.ts', () => ({ prepareClusterServer: vi.fn(), ensureClusterRole: vi.fn(),
  describeClusterNode: vi.fn(async (server: unknown) => ({ server, devicePaths: ['/dev/nvidia0'],
    backendPath: '/usr/bin/bwrap', hiddenPaths: [], gpuInfo: 'GPU 0' })),
  delegateClusterLogin: vi.fn(async () => ({ knownHostsFile: '/private/known_hosts' })),
}))
const fleets: ExperimentFleet[] = []
afterEach(async () => { await Promise.all(fleets.splice(0).map(fleet => fleet.close())) })
beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(snapshotSource).mockResolvedValue({ digest: 'a'.repeat(64), archive: '/snapshot.tar',
    dispose: () => {} } as Awaited<ReturnType<typeof snapshotSource>>)
  vi.mocked(prepareClusterServer).mockResolvedValue({ state: 'ready', deploymentId: 'a'.repeat(64),
    preparationId: 'a'.repeat(64), backend: 'bwrap',
    sandboxWriteProbe: 'passed', cudaProbe: 'passed', workspaceRoot: '/runs/workspace', devicePaths: ['/dev/nvidia0'],
    backendPath: '/usr/bin/bwrap', hiddenPaths: [] })
})

function receipt(submission: ClusterSubmission) {
  return clusterRecordSchema.parse({ submission, payloadHash: 'b'.repeat(64), sequence: 1, revision: 1, state: 'queued',
    resourcesReleased: true, updatedAt: 1, handover: '本机派发完成，远端实验已接管' })
}

async function fixture() {
  const tables = new Map<string, Map<string, unknown>>()
  const records = new Map<string, FleetExperiment>()
  tables.set('experiments', records)
  const live = new Map<string, ReturnType<typeof makeAgent>>()
  const saved = new Map<string, ReturnType<typeof makeAgent>>()
  function makeAgent(id: string) {
    return { id, goal: { id: `goal-${id}`, revision: 1, phase: 'active' },
      session: { append: vi.fn() } }
  }
  const handle = (agent: ReturnType<typeof makeAgent>) => ({ agent, dispose: async () => { live.delete(agent.id) } })
  const complete = vi.fn((agent: ReturnType<typeof makeAgent>, ref: { id: string; revision: number }) => {
    expect(agent.goal).toMatchObject(ref)
    agent.goal = { ...agent.goal, phase: 'complete', revision: agent.goal.revision + 1 }
  })
  const resume = vi.fn(async ({ resumeSessionId }: { resumeSessionId: string }) => {
    const agent = saved.get(resumeSessionId)!
    live.set(resumeSessionId, agent)
    return handle(agent)
  })
  const ctx = { storageDomain: { open: async () => ({ table: (name: string) => {
    let table = tables.get(name); if (table === undefined) { table = new Map(); tables.set(name, table) }
    return { get: (id: string) => table.get(id), entries: () => table.entries(),
      put: async (id: string, value: unknown) => { table.set(id, structuredClone(value)) } }
  }, close: async () => {} }) },
  agents: { create: async ({ sessionId }: { sessionId: string }) => {
    const agent = makeAgent(sessionId); saved.set(sessionId, agent); live.set(sessionId, agent); return handle(agent)
  }, resume, get: (id: string) => live.get(id) },
  goals: { create: (agent: ReturnType<typeof makeAgent>) => agent.goal, get: (agent: ReturnType<typeof makeAgent>) => agent.goal,
    complete, disarm: () => {} }, sessions: { flush: vi.fn(async () => true) },
  credentials: { resolve: async () => ({ value: 'test-only-secret' }), set: vi.fn() },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
  effect: () => {}, on: () => () => {}, logger: { error: vi.fn(), debug: vi.fn() },
  } as unknown as Context
  let localRepo = '/original-source'
  const deployment = (server: Parameters<Parameters<typeof ExperimentFleet.open>[1]>[0]) => ({ ...server, localRepo,
    dataRoots: [], allowedSystemPackages: [], tokenRef: 'TOKEN', agentCredentialRefs: [], controlPollIntervalMs: 1000,
    toolTimeoutMs: 30000 })
  const open = async (legacy?: Parameters<typeof ExperimentFleet.open>[2]) => { const fleet = await ExperimentFleet.open(ctx,
    deployment, legacy); fleets.push(fleet); return fleet }
  const fleet = await open()
  const a = clusterServerSchema.parse({ id: randomUUID(), name: 'Coordinator', host: 'gpu-a', username: 'trainer',
    sshPort: 22, remotePort: 43019, remoteRoot: '/runs', authMode: 'password' })
  const b = clusterServerSchema.parse({ ...a, id: randomUUID(), name: 'Node B', host: 'gpu-b' })
  await fleet.saveServer(a); await fleet.saveServer(b)
  vi.mocked(request).mockImplementation(async (_target, _token, route, _method, body) => {
    if (route.endsWith('/submit')) return { status: 200, value: receipt(body as ClusterSubmission) }
    const row = records.get((body as { experimentId: string }).experimentId)!
    return { status: 200, value: { record: receipt(row.submission!), waitingFor: [] } }
  })
  return { fleet, open, ctx, tables, records, saved, live, makeAgent, complete, resume, a, b,
    setRepo: (value: string) => { localRepo = value } }
}

it('submits consecutive Goals independently and pins server and source settings before preparation', async () => {
  const f = await fixture()
  const barrier = Promise.withResolvers<Awaited<ReturnType<typeof snapshotSource>>>()
  vi.mocked(snapshotSource).mockReturnValue(barrier.promise)
  const first = await f.fleet.create({ experimentId: randomUUID(), objective: 'train one', serverIds: [f.a.id, f.b.id] })
  const second = await f.fleet.create({ experimentId: randomUUID(), objective: 'train two', serverIds: [f.b.id] })
  await f.fleet.saveServer({ ...f.b, host: 'replacement-host' }); f.setRepo('/replacement-source')
  expect(f.fleet.list()).toHaveLength(2)
  expect(first.sessionId).not.toBe(second.sessionId)
  barrier.resolve({ digest: 'a'.repeat(64), archive: '/snapshot.tar', dispose: () => {} } as Awaited<ReturnType<typeof snapshotSource>>)
  await vi.waitFor(() => { expect(f.fleet.list().every(row => row.handoverRecorded)).toBe(true) })
  expect(vi.mocked(prepareClusterServer).mock.calls.map(([target]) => target.host)).not.toContain('replacement-host')
  expect(vi.mocked(snapshotSource).mock.calls.map(([root]) => root)).toEqual(['/original-source', '/original-source'])
  expect(f.fleet.servers().coordinatorId).toBe(f.a.id)
  expect(f.fleet.list().map(row => row.receipt?.handover)).toEqual(['本机派发完成，远端实验已接管', '本机派发完成，远端实验已接管'])
})

it('recovers a lost handover reply after reload and records the full receipt once', async () => {
  const f = await fixture()
  let accepted: ReturnType<typeof receipt> | undefined
  vi.mocked(request).mockImplementation(async (_target, _token, route, _method, body) => {
    if (route.endsWith('/submit')) { accepted = receipt(body as ClusterSubmission); throw new Error('reply lost') }
    return { status: 200, value: { record: accepted, waitingFor: [] } }
  })
  const row = await f.fleet.create({ experimentId: randomUUID(), objective: 'queued training', serverIds: [f.a.id] })
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.state).toBe('failed') })
  await f.fleet.close()
  const restored = await f.open()
  await Promise.all([restored.refresh(row.request.experimentId), restored.refresh(row.request.experimentId)])
  expect(f.resume).toHaveBeenCalledOnce()
  expect(f.saved.get(row.sessionId)!.session.append).toHaveBeenCalledOnce()
  const notice: unknown = f.saved.get(row.sessionId)!.session.append.mock.calls[0]![1]
  expect(notice).toMatchObject({ content: [{ type: 'text', text: `本机派发完成，远端实验已接管\n${JSON.stringify(accepted)}` }] })
  expect(restored.list()[0]).toMatchObject({ handoverRecorded: true, receipt: accepted, latest: { state: 'queued' } })
})

it('deduplicates a caller Goal revision and leaves an edited Goal open when its old receipt arrives', async () => {
  const f = await fixture()
  const caller = f.makeAgent('caller'); f.live.set(caller.id, caller)
  const barrier = Promise.withResolvers<Awaited<ReturnType<typeof request>>>()
  vi.mocked(request).mockImplementation(async (_target, _token, route, _method, body) => {
    if (route.endsWith('/submit')) { const result = receipt(body as ClusterSubmission); await barrier.promise; return { status: 200, value: result } }
    throw new Error('unexpected request')
  })
  const first = await f.fleet.createForGoal(caller as unknown as Agent, 'original goal', [f.a.id], [])
  const duplicate = await f.fleet.createForGoal(caller as unknown as Agent, 'original goal', [f.a.id], [])
  expect(duplicate.request.experimentId).toBe(first.request.experimentId)
  caller.goal.revision++
  barrier.resolve({ status: 200, value: {} })
  await vi.waitFor(() => { expect(f.records.get(first.request.experimentId)?.handoverRecorded).toBe(true) })
  expect(caller.goal.phase).toBe('active')
  expect(caller.session.append).not.toHaveBeenCalled()
  expect(f.complete.mock.calls.every(([agent]) => agent.id !== caller.id)).toBe(true)
})

it('rejects conflicting duplicates and keeps the coordinator identity fixed', async () => {
  const f = await fixture()
  for (const remoteRoot of ['/', '//', '/.', '/./.', '/srv/../']) {
    expect(() => f.fleet.saveServer({ ...f.b, remoteRoot })).toThrow()
  }
  await expect(f.fleet.saveServer({ ...f.a, host: 'new-coordinator' })).rejects.toThrow('fixed')
  await expect(f.fleet.removeServer(f.a.id)).rejects.toThrow('coordinator')
  const input = { experimentId: randomUUID(), objective: 'one', serverIds: [f.a.id] }
  await f.fleet.create(input)
  await expect(f.fleet.create({ ...input, objective: 'two' })).rejects.toThrow('different requirements')
})

it('retains cancellation when an older refresh response arrives later', async () => {
  const f = await fixture()
  const row = await f.fleet.create({ experimentId: randomUUID(), objective: 'train', serverIds: [f.a.id] })
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.handoverRecorded).toBe(true) })
  const accepted = f.records.get(row.request.experimentId)!.receipt!
  const delayed = Promise.withResolvers<Awaited<ReturnType<typeof request>>>()
  vi.mocked(request).mockImplementation(async (_target, _token, route) => route.endsWith('/status') ? delayed.promise
    : { status: 200, value: { ...accepted, state: 'cancelled', revision: 3 } })
  const refreshing = f.fleet.refresh(row.request.experimentId)
  await f.fleet.cancel(row.request.experimentId)
  delayed.resolve({ status: 200, value: { record: { ...accepted, revision: 2 }, waitingFor: [] } })
  await refreshing
  expect(f.fleet.list()[0]!.latest).toMatchObject({ state: 'cancelled', revision: 3 })
})

it('migrates the legacy server once and preserves its coordinator identity on reload', async () => {
  const f = await fixture()
  f.tables.delete('registry')
  const legacy = vi.fn(async () => f.a)
  const migrated = await f.open(legacy)
  expect(migrated.servers()).toEqual({ coordinatorId: f.a.id, servers: [f.a] })
  const restored = await f.open(legacy)
  expect(restored.servers()).toEqual(migrated.servers())
  expect(legacy).toHaveBeenCalledOnce()
})
