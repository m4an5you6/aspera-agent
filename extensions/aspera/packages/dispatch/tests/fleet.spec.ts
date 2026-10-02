import { fromAny } from '@total-typescript/shoehorn'
/** Independent dispatch identities, pinned destinations, and durable receipt recovery. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { clusterRecordSchema, clusterServerSchema } from '@aspera/runtime'
import type { ClusterSubmission } from '@aspera/runtime'
import { ExperimentFleet } from '../src/fleet.ts'
import type { FleetExperiment } from '../src/types.ts'
import { request } from '../src/transport.ts'
import { snapshotSource } from '../src/snapshot.ts'
import { prepareClusterServer } from '../src/cluster-deploy.ts'
import { installPrivateFile } from '../src/deploy.ts'

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
const temporary: string[] = []
const originalHome = process.env.DSH_HOME
afterEach(async () => {
  await Promise.all(fleets.splice(0).map(fleet => fleet.close()))
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
  if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome
})
beforeEach(() => {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const directory = mkdtempSync(resolve('.artifacts', 'fleet-'))
  temporary.push(directory); process.env.DSH_HOME = directory
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
  const ctx = fromAny<Context, object>({ storage: { domain: { open: async () => ({ table: (name: string) => {
    let table = tables.get(name); if (table === undefined) { table = new Map(); tables.set(name, table) }
    return { get: (id: string) => table.get(id), entries: () => table.entries(),
      put: async (id: string, value: unknown) => { table.set(id, structuredClone(value)) } }
  }, close: async () => {} }) } },
  agents: { create: async ({ sessionId }: { sessionId: string }) => {
    const agent = makeAgent(sessionId); saved.set(sessionId, agent); live.set(sessionId, agent); return handle(agent)
  }, resume, get: (id: string) => live.get(id) },
  goals: { create: (agent: ReturnType<typeof makeAgent>) => agent.goal, get: (agent: ReturnType<typeof makeAgent>) => agent.goal,
    complete, disarm: () => {} }, sessionPersistence: { flush: vi.fn(async () => {}) },
  credentials: { resolve: async () => ({ value: 'test-only-secret' }), set: vi.fn() },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
  effect: () => {}, on: () => () => {}, logger: { error: vi.fn(), debug: vi.fn() },
  })
  let localRepo = '/original-source'
  const deployment = (server: Parameters<Parameters<typeof ExperimentFleet.open>[1]>[0]) => ({ ...server, localRepo,
    dataRoots: [], allowedSystemPackages: [], tokenRef: 'TOKEN', agentCredentialRefs: [], controlPollIntervalMs: 1000,
    toolTimeoutMs: 30000 })
  const open = async () => { const fleet = await ExperimentFleet.open(ctx,
    deployment); fleets.push(fleet); return fleet }
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
  const first = await f.fleet.create({ experimentId: randomUUID(), objective: 'train one', serverIds: [f.a.id, f.b.id], mode: 'automatic' })
  const second = await f.fleet.create({ experimentId: randomUUID(), objective: 'train two', serverIds: [f.b.id], mode: 'automatic' })
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

it('keeps the selected reasoning effort when model settings change during preparation', async () => {
  const f = await fixture()
  const selection = { provider: 'test', model: 'test-model', reasoningEffort: ReasoningEffortId('high') }
  vi.spyOn(f.ctx.agentDefaultModel, 'currentSelection').mockReturnValue(selection)
  const barrier = Promise.withResolvers<Awaited<ReturnType<typeof snapshotSource>>>()
  vi.mocked(snapshotSource).mockReturnValue(barrier.promise)
  const row = await f.fleet.create({ experimentId: randomUUID(), objective: 'train with fixed effort', serverIds: [f.a.id], mode: 'automatic' })
  selection.reasoningEffort = ReasoningEffortId('low')
  barrier.resolve({ digest: 'a'.repeat(64), archive: '/snapshot.tar', dispose: () => {} } as Awaited<ReturnType<typeof snapshotSource>>)
  await vi.waitFor(() => { expect(f.fleet.list()[0]!.handoverRecorded).toBe(true) })
  expect(f.fleet.list()[0]!.agentModel.reasoningEffort).toBe('high')
  const transfer = vi.mocked(installPrivateFile).mock.calls.find(([, path]) => path.endsWith(`/secrets/${row.request.experimentId}.json`))
  expect(JSON.parse(transfer![2]).agentModel.reasoningEffort).toBe('high')
})

it('recovers a lost handover reply after reload and records the full receipt once', async () => {
  const f = await fixture()
  let accepted: ReturnType<typeof receipt> | undefined
  vi.mocked(request).mockImplementation(async (_target, _token, route, _method, body) => {
    if (route.endsWith('/submit')) { accepted = receipt(body as ClusterSubmission); throw new Error('reply lost') }
    return { status: 200, value: { record: accepted, waitingFor: [] } }
  })
  const row = await f.fleet.create({ experimentId: randomUUID(), objective: 'queued training', serverIds: [f.a.id], mode: 'automatic' as const })
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
  const first = await f.fleet.createForGoal(fromAny<Agent, typeof caller>(caller), 'original goal', [f.a.id], [], 'automatic')
  const duplicate = await f.fleet.createForGoal(fromAny<Agent, typeof caller>(caller), 'original goal', [f.a.id], [], 'automatic')
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
  const input = { experimentId: randomUUID(), objective: 'one', serverIds: [f.a.id], mode: 'automatic' as const }
  await f.fleet.create(input)
  await expect(f.fleet.create({ ...input, objective: 'two' })).rejects.toThrow('different requirements')
})

it('retains cancellation when an older refresh response arrives later', async () => {
  const f = await fixture()
  const row = await f.fleet.create({ experimentId: randomUUID(), objective: 'train', serverIds: [f.a.id], mode: 'automatic' as const })
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

it('initializes a fresh extension registry without binding historical experiments', async () => {
  const f = await fixture(); f.tables.delete('registry')
  const fresh = await f.open()
  expect(fresh.servers()).toEqual({ servers: [] })
})

it('rejects partial or oversized attachments and retains cancellation during input commit', async () => {
  const f = await fixture()
  const row = await f.fleet.create({ experimentId: randomUUID(), objective: 'with input', serverIds: [f.a.id], mode: 'semi',
    uploads: [{ name: 'data.txt', size: 6 }] })
  expect(row.state).toBe('staging')
  f.fleet.upload(row.request.experimentId, 'data.txt', 0, Buffer.from('abc').toString('base64'))
  await expect(f.fleet.commitInputs(row.request.experimentId)).rejects.toThrow('incomplete')
  expect(() => f.fleet.upload(row.request.experimentId, 'data.txt', 3, Buffer.from('too long').toString('base64'))).toThrow('declared size')
  f.fleet.upload(row.request.experimentId, 'data.txt', 3, Buffer.from('def').toString('base64'))
  await Promise.all([f.fleet.cancel(row.request.experimentId), f.fleet.commitInputs(row.request.experimentId)])
  expect(f.fleet.list()[0]?.state).toBe('cancelled')
  expect(snapshotSource).not.toHaveBeenCalled()
})

it('retries an unreceived admission with the original identity and server snapshot on refresh', async () => {
  const f = await fixture()
  vi.mocked(request).mockRejectedValue(new Error('connection lost before admission'))
  const row = await f.fleet.create({ experimentId: randomUUID(), objective: 'lost admission', serverIds: [f.b.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.fleet.list()[0]?.state).toBe('failed') })
  const pinned = f.records.get(row.request.experimentId)!.submission!
  await f.fleet.saveServer({ ...f.b, host: 'changed-settings' })
  vi.mocked(request).mockImplementation(async (_target, _token, route, _method, body) => route.endsWith('/status')
    ? { status: 404, value: { error: 'experiment not found' } }
    : { status: 200, value: receipt(body as ClusterSubmission) })
  const result = await f.fleet.refresh(row.request.experimentId)
  expect(result.receipt?.submission).toEqual(pinned)
  expect(result.receipt?.submission.nodes[0]?.server.host).toBe('gpu-b')
  expect(result.handoverRecorded).toBe(true)
})
