import { fromAny } from '@total-typescript/shoehorn'
/** Independent dispatch identities, pinned destinations, and durable receipt recovery. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CLUSTER_HANDOVER, clusterRecordSchema, clusterServerSchema, inspectServerStorage, prepareServerStorage, cleanupServerStorage, readClusterChunk } from '@aspera/runtime'
import type { ClusterSubmission } from '@aspera/runtime'
import { ExperimentFleet } from '../src/fleet.ts'
import { fleetExperimentV5Schema } from '../src/fleet-schema-v5.ts'
import { preparationRecordSchema } from '../src/installation-model.ts'
import type { FleetExperiment } from '../src/types.ts'
import { request, remote, prepareSshHostKey } from '../src/transport.ts'
import { snapshotSource } from '../src/snapshot.ts'
import { prepareClusterServer } from '../src/cluster-deploy.ts'
import { installPrivateFile } from '../src/deploy.ts'
import { inventory } from '../../experiments/tests/fixtures.ts'
import type { NetworkParticipant } from '../src/network-selection.ts'
import { modelSelections } from '../../experiments/tests/fixtures.ts'
import { readyEnvironment } from './environment-fixture.ts'
import { inspectEnvironment } from '../src/environment.ts'
vi.mock('../src/environment.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/environment.ts')>(),
  environmentRequirements: () => ({ node: '^22.19.0 || >=24.0.0', pnpm: '11.7.0' }),
  installedEnvironmentRequirements: vi.fn(async () => ({ node: '^22.19.0 || >=24.0.0', pnpm: '11.7.0' })),
  inspectEnvironment: vi.fn(async () => readyEnvironment()),
}))
vi.mock('../../runtime/src/phase-model.ts', async importOriginal => ({ ...await importOriginal<typeof import('../../runtime/src/phase-model.ts')>(), openPhaseModelContext: vi.fn(async (context: Context) => ({ context, dispose: async () => {} })) }))

vi.mock('../../runtime/src/storage.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../../runtime/src/storage.ts')>(),
  inspectServerStorage: vi.fn(async (_target, directory) => inventory(directory)),
  prepareServerStorage: vi.fn(async (_target, placement) => placement.candidate),
  cleanupServerStorage: vi.fn(async () => {}),
  verifyServerStorage: vi.fn(async (_target, placement) => placement.candidate),
}))
vi.mock('../src/network-selection.ts', () => ({ resolveTrainingNetwork: vi.fn(async (_id: string, participants: NetworkParticipant[]) => participants.map(participant => participant.node)) }))
vi.mock('../src/transport.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/transport.ts')>(), request: vi.fn(), remote: vi.fn(async () => ''), remoteResult: vi.fn(), copy: vi.fn(),
  prepareSshHostKey: vi.fn(async () => {}),
  shellQuote: (value: string) => value }))
vi.mock('../src/deploy.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/deploy.ts')>(), installPrivateFile: vi.fn() }))
vi.mock('../src/snapshot.ts', () => ({ snapshotSource: vi.fn() }))
vi.mock('../src/cluster-deploy.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/cluster-deploy.ts')>(), prepareClusterServer: vi.fn(), ensureClusterRole: vi.fn(),
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
  const archive = resolve(directory, 'snapshot.tar')
  writeFileSync(archive, 'CPU fixture immutable material')
  vi.mocked(snapshotSource).mockResolvedValue({ digest: 'a'.repeat(64), archive, directory,
    archiveHash: createHash('sha256').update('CPU fixture immutable material').digest('hex'), dispose: () => {} })
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
  const failingLocalTables = new Set<string>()
  tables.set('experiments', records)
  const live = new Map<string, ReturnType<typeof makeAgent>>()
  const saved = new Map<string, ReturnType<typeof makeAgent>>()
  function makeAgent(id: string) {
    return { id, goal: { id: `goal-${id}`, revision: 1, phase: 'active' },
      session: { append: vi.fn() }, inject: vi.fn(), followup: vi.fn(), whenIdle: async () => {}, status: 'idle', cancel: vi.fn() }
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
  const secrets = new Map<string, string>([['TEST_API_KEY', 'test-only-secret']])
  const ctx = fromAny<Context, object>({ storage: { domain: { open: async () => ({ table: (name: string) => {
    let table = tables.get(name); if (table === undefined) { table = new Map(); tables.set(name, table) }
    return { get: (id: string) => table.get(id), entries: () => table.entries(), delete: async (id: string) => { if (failingLocalTables.has(name)) throw new Error('CPU fixture local cleanup unavailable'); table.delete(id) },
      put: async (id: string, value: unknown) => { table.set(id, structuredClone(value)) } }
  }, close: async () => {} }) } },
  agents: { create: async ({ sessionId }: { sessionId: string }) => {
    const agent = makeAgent(sessionId); saved.set(sessionId, agent); live.set(sessionId, agent); return handle(agent)
  }, resume, get: (id: string) => live.get(id) },
  goals: { create: (agent: ReturnType<typeof makeAgent>) => agent.goal, get: (agent: ReturnType<typeof makeAgent>) => agent.goal,
    complete, disarm: () => {} }, sessionPersistence: { flush: vi.fn(async () => {}), stat: async (id: string) => saved.has(id) ? { revision: 1 } : undefined },
  credentials: { describe: async () => ({ writable: true }), unset: vi.fn(async (ref: string) => { secrets.delete(ref) }), resolve: async (ref: string) => ({ value: secrets.get(ref) ?? 'test-only-secret' }), set: vi.fn(async (ref: string, value: string) => { secrets.set(ref, value) }) },
  settings: { describe: () => [{ ns: 'models', value: { providers: { test: { api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'TEST_API_KEY', models: [{ id: 'test-model' }] } } } }] },
  llm: { listConfigurableProviders: () => [{ provider: 'test', settingsNs: 'models', settingsPath: ['providers', 'test'] }], listModels: async () => [{ id: 'test-model' }], resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'high' }, { id: 'low' }] } }) },
  agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test-model' }) },
  effect: () => {}, on: () => () => {}, logger: { error: vi.fn(), debug: vi.fn() },
  })
  let localRepo = '/original-source'
  const deployment = (server: Parameters<Parameters<typeof ExperimentFleet.open>[1]>[0]) => ({ ...server, localRepo,
    dataRoots: [], preparationOutputChars: 65536, tokenRef: 'TOKEN', agentCredentialRefs: [], controlPollIntervalMs: 1000,
    toolTimeoutMs: 30000, minimumFreeBytes: 1024 })
  const open = async () => { const fleet = await ExperimentFleet.open(ctx,
    deployment, 20000); fleets.push(fleet); return fleet }
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
  return { fleet, open, ctx, tables, records, saved, live, makeAgent, complete, resume, a, b, failingLocalTables,
    source: { directory: process.env.DSH_HOME!, archive: resolve(process.env.DSH_HOME!, 'snapshot.tar'),
      digest: 'a'.repeat(64), archiveHash: createHash('sha256').update('CPU fixture immutable material').digest('hex'), dispose: () => {} },
    setRepo: (value: string) => { localRepo = value } }
}

it('removes unused peer registrations without assigning a permanent coordinator', async () => {
  const f = await fixture()
  const next = await f.fleet.removeServer(f.a.id)
  expect(next).toMatchObject({ servers: [f.b] })
  expect(f.fleet.list()).toEqual([])
  expect(vi.mocked(remote)).not.toHaveBeenCalled()
  expect(vi.mocked(request)).not.toHaveBeenCalled()
  expect(f.ctx.credentials.set).not.toHaveBeenCalled()
  const empty = await f.fleet.removeServer(f.b.id)
  expect(empty.servers).toEqual([])
  expect(empty.coordinatorId).toBeUndefined()
  await expect(f.fleet.saveServer(f.a)).rejects.toThrow('was removed')
  await f.fleet.saveServer({ ...f.a, id: randomUUID() })
  expect(f.fleet.servers().coordinatorId).toBeUndefined()
})

it('registers a selected server host key before a model-free connection check', async () => {
  const f = await fixture()
  const trusted = new Set<string>()
  vi.mocked(prepareSshHostKey).mockImplementation(async target => { trusted.add(target.host) })
  vi.mocked(inspectEnvironment).mockImplementation(async target => {
    if (!trusted.has(target.host)) throw new Error('SSH host key is unavailable; verify this server with OpenSSH before dispatching')
    return readyEnvironment()
  })
  const result = await f.fleet.probe(f.b.id)
  expect(result.result?.environmentReady).toBe(true)
  expect(trusted).toEqual(new Set([f.b.host]))
  expect(vi.mocked(prepareSshHostKey)).toHaveBeenCalledOnce()
  expect(f.fleet.list()).toEqual([])
  expect(f.saved.size).toBe(0)
})

it('keeps failed experiment destinations when removing their unused coordinator registration', async () => {
  const f = await fixture()
  vi.mocked(inspectEnvironment).mockRejectedValueOnce(new Error('SSH connection unavailable'))
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'unavailable server', coordinatorId: f.a.id, serverIds: [f.a.id, f.b.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.state).toBe('failed') })
  const failed = structuredClone(f.records.get(row.request.experimentId)!)
  await f.fleet.removeServer(f.a.id)
  expect(f.records.get(row.request.experimentId)).toEqual(failed)
  expect(f.fleet.servers().coordinatorId).toBeUndefined()
  expect(f.fleet.list()[0]!.coordinator.id).toBe(f.a.id)
})

it('protects a selected coordinator and retains unconfirmed cleanup', async () => {
  const f = await fixture()
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'other node', coordinatorId: f.a.id, serverIds: [f.a.id, f.b.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.handoverRecorded).toBe(true) })
  const saved = f.records.get(row.request.experimentId)!
  expect(saved.latest).toMatchObject({ state: 'queued', resourcesReleased: true })
  await expect(f.fleet.removeServer(f.a.id)).rejects.toThrow('pending work')
  f.records.set(row.request.experimentId, { ...saved, latest: undefined, receipt: undefined, state: 'failed' })
  await expect(f.fleet.removeServer(f.a.id)).rejects.toThrow('pending work')
  f.records.set(row.request.experimentId, { ...saved, state: 'cancelled', submission: undefined, latest: undefined, receipt: undefined,
    preparation: { ...saved.preparation!, environments: [{ serverId: f.a.id, phase: 'repairing-environment', pendingCommand: { directory: '/runs/unconfirmed' } }] } })
  await expect(f.fleet.removeServer(f.a.id)).rejects.toThrow('unconfirmed cleanup')
})

it('pins public inference mappings and rejects control-port collisions before preparing', async () => {
  const f = await fixture()
  const mapping = { url: 'https://inference.example.test:8443', port: 17000 }
  await f.fleet.saveServer({ ...f.b, inferenceMapping: mapping })
  const barrier = Promise.withResolvers<Awaited<ReturnType<typeof snapshotSource>>>()
  vi.mocked(snapshotSource).mockReturnValue(barrier.promise)
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'serve a model', coordinatorId: f.b.id, serverIds: [f.b.id], mode: 'semi' })
  await f.fleet.saveServer({ ...f.b, inferenceMapping: { url: 'https://replacement.test', port: 18000 } })
  expect(row.servers[0]!.inferenceMapping).toEqual(mapping)
  expect(row.targets[0]!.inferenceMapping).toEqual(mapping)
  expect(() => f.fleet.saveServer({ ...f.b, inferenceMapping: { ...mapping, port: f.b.remotePort } })).toThrow('control ports')
  barrier.resolve(f.source)
  await vi.waitFor(() => {
    const submission = f.records.get(row.request.experimentId)?.submission
    expect(submission?.protocol === 4 && submission.nodes[0]?.server.inferenceMapping).toEqual(mapping)
  })
})

it('submits consecutive Goals independently and pins server and source settings before preparation', async () => {
  const f = await fixture()
  const barrier = Promise.withResolvers<Awaited<ReturnType<typeof snapshotSource>>>()
  vi.mocked(snapshotSource).mockReturnValue(barrier.promise)
  const first = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'train one', coordinatorId: f.a.id, serverIds: [f.a.id, f.b.id], mode: 'automatic' })
  const second = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'train two', coordinatorId: f.a.id, serverIds: [f.a.id, f.b.id], mode: 'automatic' })
  await f.fleet.saveServer({ ...f.b, host: 'replacement-host' }); f.setRepo('/replacement-source')
  expect(f.fleet.list()).toHaveLength(2)
  expect(first.sessionId).not.toBe(second.sessionId)
  barrier.resolve(f.source)
  await vi.waitFor(() => { expect(f.fleet.list().every(row => row.handoverRecorded)).toBe(true) })
  expect(vi.mocked(prepareClusterServer).mock.calls.map(([target]) => target.host)).not.toContain('replacement-host')
  expect(vi.mocked(snapshotSource).mock.calls.map(([root]) => root)).toEqual(['/original-source', '/original-source'])
  expect(f.fleet.servers().coordinatorId).toBeUndefined()
  await f.fleet.saveServer({ ...f.a, username: 'another-user' })
  expect(first.coordinator.username).toBe('trainer')
  expect(f.fleet.list().map(row => row.receipt?.handover)).toEqual(['本机派发完成，远端实验已接管', '本机派发完成，远端实验已接管'])
})

it('keeps the selected reasoning effort when model settings change during preparation', async () => {
  const f = await fixture()
  const selection = { provider: 'test', model: 'test-model', reasoningEffort: ReasoningEffortId('high') }
  vi.spyOn(f.ctx.agentDefaultModel, 'currentSelection').mockReturnValue(selection)
  const barrier = Promise.withResolvers<Awaited<ReturnType<typeof snapshotSource>>>()
  vi.mocked(snapshotSource).mockReturnValue(barrier.promise)
  const row = await f.fleet.create({ models: { preparation: selection, planning: selection, execution: selection }, experimentId: randomUUID(), objective: 'train with fixed effort', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' })
  selection.reasoningEffort = ReasoningEffortId('low')
  barrier.resolve(f.source)
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
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'queued training', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' as const })
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.state).toBe('failed') })
  await f.fleet.close()
  const restored = await f.open()
  await Promise.all([restored.refresh(row.request.experimentId), restored.refresh(row.request.experimentId)])
  expect(f.resume).toHaveBeenCalledOnce()
  expect(f.saved.get(row.sessionId)!.session.append.mock.calls.filter(([, message]) => JSON.stringify(message).includes(CLUSTER_HANDOVER))).toHaveLength(1)
  const notice: unknown = f.saved.get(row.sessionId)!.session.append.mock.calls.at(-1)![1]
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
  const first = await f.fleet.createForGoal(fromAny<Agent, typeof caller>(caller), 'original goal', [f.a.id], f.a.id, [], 'automatic', modelSelections)
  const duplicate = await f.fleet.createForGoal(fromAny<Agent, typeof caller>(caller), 'original goal', [f.a.id], f.a.id, [], 'automatic', modelSelections)
  expect(duplicate.request.experimentId).toBe(first.request.experimentId)
  caller.goal.revision++
  barrier.resolve({ status: 200, value: {} })
  await vi.waitFor(() => { expect(f.records.get(first.request.experimentId)?.handoverRecorded).toBe(true) })
  expect(caller.goal.phase).toBe('active')
  expect(caller.session.append).not.toHaveBeenCalled()
  expect(f.complete.mock.calls.every(([agent]) => agent.id !== caller.id)).toBe(true)
})

it('rejects conflicting duplicate experiments and protects a coordinator with pending work', async () => {
  const f = await fixture()
  for (const remoteRoot of ['/', '//', '/.', '/./.', '/srv/../']) {
    expect(() => f.fleet.saveServer({ ...f.b, remoteRoot })).toThrow()
  }
  await f.fleet.saveServer({ ...f.a, host: 'new-coordinator' })
  const input = { models: modelSelections, experimentId: randomUUID(), objective: 'one', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' as const }
  await f.fleet.create(input)
  await expect(f.fleet.removeServer(f.a.id)).rejects.toThrow('pending work')
  await expect(f.fleet.create({ ...input, objective: 'two' })).rejects.toThrow('different requirements')
})

it('retains cancellation when an older refresh response arrives later', async () => {
  const f = await fixture()
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'train', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' as const })
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
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'with input', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'semi',
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
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'lost admission', coordinatorId: f.b.id, serverIds: [f.b.id], mode: 'automatic' })

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

it('resumes a failed directory creation with the same experiment, release, Session and saved paths', async () => {
  const f = await fixture()
  vi.mocked(prepareServerStorage).mockRejectedValueOnce(new Error('temporary disk failure'))
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'retry preparation', coordinatorId: f.b.id, serverIds: [f.b.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.state).toBe('failed'); expect(f.live.size).toBe(0) })
  const saved = f.records.get(row.request.experimentId)!
  await f.fleet.saveServer({ ...f.b, host: 'different-host', remoteRoot: '/different-root' })
  await f.fleet.close()
  const resumed = await f.open()
  await Promise.all([resumed.retry(row.request.experimentId), resumed.retry(row.request.experimentId)])
  await vi.waitFor(() => { expect(resumed.list()[0]?.handoverRecorded).toBe(true) })
  expect(resumed.list()[0]?.preparation?.placements).toEqual(saved.preparation?.placements)
  expect(resumed.list()[0]?.sessionId).toBe(saved.sessionId)
  expect(resumed.list()[0]?.goalId).toBe(saved.goalId)
  expect(inspectServerStorage).toHaveBeenCalledTimes(1)
  expect(vi.mocked(prepareServerStorage).mock.calls.some(([target]) => target.host === 'different-host')).toBe(false)
})

it('reuses the saved remote release when the local application changes before retry', async () => {
  const f = await fixture()
  vi.mocked(prepareServerStorage).mockRejectedValueOnce(new Error('temporary disk failure'))
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'fixed build', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.state).toBe('failed'); expect(f.live.size).toBe(0) })
  vi.mocked(snapshotSource).mockResolvedValue({ digest: 'c'.repeat(64), archive: '/snapshot.tar', dispose() {} } as Awaited<ReturnType<typeof snapshotSource>>)
  await f.fleet.retry(row.request.experimentId)
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.handoverRecorded).toBe(true) })
  expect(snapshotSource).toHaveBeenCalledOnce()
  expect(prepareClusterServer).toHaveBeenLastCalledWith(expect.anything(), { digest: 'a'.repeat(64), reuse: true }, expect.anything(), expect.anything())
})

it('saves SSH-only settings and probes disks without creating a dispatch Agent', async () => {
  const f = await fixture()
  await f.fleet.saveServer({ id: randomUUID(), name: 'auto', host: 'new-host', sshPort: 22, username: 'trainer', remotePort: 43019, authMode: 'password' })
  const server = f.fleet.servers().servers.at(-1)!
  expect(server).toMatchObject({ storagePreference: { mode: 'auto' } })
  expect(inspectServerStorage).not.toHaveBeenCalled()
  const result = await f.fleet.probe(server.id)
  expect(result.result?.inventory?.candidates).not.toHaveLength(0)
  expect(f.saved.size).toBe(0)
  expect(snapshotSource).not.toHaveBeenCalled()
})

it('reports connected servers with missing prerequisites without creating a preparation Agent', async () => {
  const f = await fixture()
  const observation = readyEnvironment()
  observation.programs = []; observation.sandboxExitCode = 127
  vi.mocked(inspectEnvironment).mockResolvedValue(observation)
  vi.mocked(inspectServerStorage).mockRejectedValue(new Error('node is unavailable'))
  const result = await f.fleet.probe(f.a.id)
  expect(result.result).toMatchObject({ environmentReady: false, environment: observation })
  expect(result.result?.inventory).toBeUndefined()
  expect(result.result?.detail).toContain('node is missing')
  expect(f.saved.size).toBe(0)
})

it.each(['Sandbox allowed an outside write', 'CUDA initialization failed'])('never hands over after failed isolation or GPU verification: %s', async diagnostic => {
  const f = await fixture()
  vi.mocked(prepareClusterServer).mockRejectedValue(new Error(diagnostic))
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'must verify every node', coordinatorId: f.a.id, serverIds: [f.a.id, f.b.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.state).toBe('failed') })
  expect(f.records.get(row.request.experimentId)?.submission).toBeUndefined()
  expect(f.complete).not.toHaveBeenCalled()
  expect(JSON.stringify(f.saved.get(row.sessionId)?.followup.mock.calls)).toContain(diagnostic)
})

it('keeps a failed protocol-4 experiment intact when its retained original material is missing', async () => {
  const f = await fixture()
  vi.mocked(prepareServerStorage).mockRejectedValueOnce(new Error('temporary disk failure'))
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'keep original release', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.state).toBe('failed'); expect(f.live.size).toBe(0) })
  const original = structuredClone(f.records.get(row.request.experimentId)!)
  const material = preparationRecordSchema.parse(f.tables.get('installations')!.get(row.request.experimentId)).material!
  rmSync(material.archive)
  await f.fleet.retry(row.request.experimentId)
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.detail).toContain('Original material is missing') })
  const failed = f.records.get(row.request.experimentId)!
  expect(failed.sessionId).toBe(original.sessionId)
  expect(failed.models).toEqual(original.models)
  expect(failed.preparation?.placements).toEqual(original.preparation?.placements)
  expect(snapshotSource).toHaveBeenCalledOnce()
  expect(f.complete).not.toHaveBeenCalled()
})

it('blocks legacy preparation with neither original directories nor a retained archive', async () => {
  const f = await fixture()
  vi.mocked(inspectEnvironment).mockRejectedValue(new Error('SSH connection failed'))
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'missing saved deployment', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(row.request.experimentId)?.state).toBe('failed'); expect(f.live.size).toBe(0) })
  f.tables.get('installations')!.delete(row.request.experimentId)
  await expect(f.fleet.retry(row.request.experimentId)).rejects.toThrow('copy this experiment')
  expect(snapshotSource).toHaveBeenCalledOnce()
  expect(f.records.get(row.request.experimentId)?.sessionId).toBe(row.sessionId)
})

it('reuses verified executable directories for another experiment on the same account', async () => {
  const f = await fixture()
  const observed = readyEnvironment()
  observed.programs[0]!.path = '/opt/aspera/node/bin/node'
  vi.mocked(inspectEnvironment).mockResolvedValue(observed)
  const first = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'prepare shared environment', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(first.request.experimentId)?.handoverRecorded).toBe(true) })
  vi.mocked(inspectEnvironment).mockClear()
  const second = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'reuse shared environment', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(second.request.experimentId)?.handoverRecorded).toBe(true) })
  expect(vi.mocked(inspectEnvironment).mock.calls[0]?.[0].pathEntries).toContain('/opt/aspera/node/bin')
  expect(f.saved.get(second.sessionId)?.followup).not.toHaveBeenCalled()
})

it('blocks another experiment while a previous command on that server has no confirmed exit', async () => {
  const f = await fixture()
  vi.mocked(prepareServerStorage).mockRejectedValueOnce(new Error('interrupted preparation'))
  const first = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'interrupted installation', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(first.request.experimentId)?.state).toBe('failed'); expect(f.live.size).toBe(0) })
  const saved = f.records.get(first.request.experimentId)!
  if (saved.preparation === undefined) throw new Error('fixture preparation is absent')
  saved.preparation.environments = [{ serverId: f.a.id, phase: 'configuring-environment', pendingCommand: { directory: '/private/pending-command' } }]
  vi.mocked(remote).mockResolvedValue('unknown')
  const second = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'wait for prior command', coordinatorId: f.a.id, serverIds: [f.a.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(second.request.experimentId)?.state).toBe('failed') })
  expect(f.records.get(second.request.experimentId)?.detail).toContain('still unconfirmed')
  expect(prepareServerStorage).toHaveBeenCalledOnce()
  expect(f.complete).not.toHaveBeenCalled()
})


it('serializes conflicting coordinators, permits one-coordinator queues and disjoint coordinators', async () => {
  const f = await fixture()
  const staged = (serverIds: string[], coordinatorId: string) => ({ models: modelSelections, experimentId: randomUUID(), objective: 'coordinator assignment',
    serverIds, coordinatorId, mode: 'semi' as const, uploads: [{ name: 'pending.txt', size: 1 }] })
  const results = await Promise.allSettled([f.fleet.create(staged([f.a.id, f.b.id], f.a.id)), f.fleet.create(staged([f.a.id, f.b.id], f.b.id))])
  expect(results.map(value => value.status)).toEqual(['fulfilled', 'rejected'])
  expect(String(results[1].status === 'rejected' && results[1].reason)).toContain('another coordinator')
  const first = f.fleet.list()[0]!
  await f.fleet.create(staged([f.a.id, f.b.id], f.a.id))
  await expect(f.fleet.create(staged([f.a.id], f.b.id))).rejects.toThrow('selected execution node')
  await Promise.all(f.fleet.list().map(row => f.fleet.cancel(row.request.experimentId)))
  await f.fleet.create(staged([f.a.id], f.a.id))
  await f.fleet.create(staged([f.b.id], f.b.id))
  expect(first.coordinator.id).toBe(f.a.id)
  expect(f.fleet.servers().coordinatorId).toBeUndefined()
})

it('retains dated hardware after a failed check and suppresses results from replaced settings', async () => {
  const f = await fixture()
  vi.mocked(remote).mockResolvedValue('GPU 0: CPU fixture')
  const passed = await f.fleet.probe(f.a.id)
  expect(passed).toMatchObject({ status: 'passed', result: { gpuInfo: 'GPU 0: CPU fixture' } })
  vi.mocked(inspectEnvironment).mockRejectedValueOnce(new Error('Timed out while waiting for handshake'))
  const failed = await f.fleet.probe(f.a.id)
  expect(failed).toMatchObject({ status: 'failed', lastSuccess: passed.lastSuccess })
  expect(failed.result).toBeUndefined()
  const barrier = Promise.withResolvers<ReturnType<typeof readyEnvironment>>()
  vi.mocked(inspectEnvironment).mockReturnValueOnce(barrier.promise)
  const pending = f.fleet.probe(f.a.id)
  expect(f.fleet.probe(f.a.id)).toBe(pending)
  await vi.waitFor(() => { expect(f.fleet.servers().checks?.[f.a.id]?.status).toBe('checking') })
  await f.fleet.saveServer({ ...f.a, host: 'replacement.test' })
  barrier.resolve(readyEnvironment())
  expect((await pending).status).toBe('unchecked')
  expect(f.fleet.servers().checks?.[f.a.id]?.lastSuccess).toEqual(passed.lastSuccess)
  expect(f.saved.size).toBe(0)
})

it('marks a persisted connection check as interrupted after restart', async () => {
  const f = await fixture()
  f.tables.get('registry')!.set('servers', { ...f.fleet.servers(), checks: { [f.a.id]: { status: 'checking', configuration: 'saved', startedAt: 1 } } })
  const reopened = await f.open()
  expect(reopened.servers().checks?.[f.a.id]).toMatchObject({ status: 'interrupted', startedAt: 1 })
})

it.each(['host key', 'environment', 'observations'])('ends a stalled %s check at the shared 20-second deadline and permits retry', async stage => {
  const f = await fixture()
  vi.mocked(remote).mockResolvedValue('GPU 0: CPU fixture')
  const passed = await f.fleet.probe(f.a.id)
  const entered = Promise.withResolvers<void>()
  const signals: AbortSignal[] = []
  const waitForAbort = (signal: AbortSignal | undefined): Promise<never> => {
    if (signal === undefined) throw new Error('Check did not pass its deadline')
    signals.push(signal)
    entered.resolve()
    return new Promise((_resolve, reject) => {
      signal.throwIfAborted()
      signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
    })
  }
  vi.mocked(prepareSshHostKey).mockImplementationOnce(async (_target, signal) => {
    if (stage === 'host key') return waitForAbort(signal)
    await new Promise<void>(resolve => { setTimeout(resolve, 8000) })
  })
  if (stage === 'environment') vi.mocked(inspectEnvironment).mockImplementationOnce((_target, _password, signal) => waitForAbort(signal))
  if (stage === 'observations') {
    vi.mocked(inspectServerStorage).mockImplementationOnce((_target, _directory, _password, signal) => waitForAbort(signal))
    vi.mocked(remote).mockImplementationOnce((_target, _command, signal) => waitForAbort(signal))
    vi.mocked(request).mockImplementationOnce((_target, _token, _path, _method, _body, signal) => waitForAbort(signal))
  }
  vi.useFakeTimers()
  try {
    const pending = f.fleet.probe(f.a.id)
    expect(f.fleet.probe(f.a.id)).toBe(pending)
    await vi.advanceTimersByTimeAsync(stage === 'host key' ? 0 : 8000)
    await entered.promise
    await vi.advanceTimersByTimeAsync(stage === 'host key' ? 19999 : 11999)
    expect(f.fleet.servers().checks?.[f.a.id]?.status).toBe('checking')
    expect(signals.every(signal => !signal.aborted)).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    const failed = await pending
    expect(failed).toMatchObject({ status: 'failed', error: 'Error: Connection check timed out after 20 seconds', lastSuccess: passed.lastSuccess })
    expect(failed.result).toBeUndefined()
    expect(signals).toHaveLength(stage === 'observations' ? 3 : 1)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(f.fleet.servers().checks?.[f.a.id]).toEqual(failed)
    expect(await f.fleet.probe(f.a.id)).toMatchObject({ status: 'passed' })
    expect(vi.getTimerCount()).toBe(0)
    expect(vi.mocked(prepareSshHostKey).mock.lastCall?.[0].toolTimeoutMs).toBe(20000)
    expect(f.fleet.list()).toEqual([])
  } finally { await vi.runAllTimersAsync(); vi.useRealTimers() }
})

it('reveals a saved password explicitly while snapshots exclude credential values', async () => {
  const f = await fixture()
  expect(await f.fleet.revealPassword(f.a.id)).toBe('test-only-secret')
  await f.fleet.probe(f.a.id)
  expect(JSON.stringify(f.fleet.snapshot())).not.toContain('test-only-secret')
  const server = f.fleet.servers().servers[0]!
  const { sshPasswordRef } = await import('../src/ssh-account.ts')
  await f.fleet.invalidatePassword(sshPasswordRef(server))
  expect(f.fleet.servers().checks?.[server.id]?.status).toBe('unchecked')
})

async function finished(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'cleanup fixture',
    coordinatorId: f.a.id, serverIds: [f.a.id, f.b.id], mode: 'automatic' })
  await vi.waitFor(() => { expect(f.records.get(created.request.experimentId)?.handoverRecorded).toBe(true) })
  const row = f.records.get(created.request.experimentId)!
  const completed: FleetExperiment = { ...row, latest: { ...row.latest!, state: 'completed', resourcesReleased: true } }
  f.records.set(created.request.experimentId, completed)
  return completed
}

it('reads exact-plan steps, identifies an old release and rejects foreign progress without changing its saved release', async () => {
  const f = await fixture(); const row = await finished(f)
  const latest = { ...row.latest!, sessionId: 'execution-session', plan: { revision: 1, summary: 'Plan', steps: ['Prepare'], frameworks: [], createdAt: 1 } }
  f.records.set(row.request.experimentId, { ...row, latest })
  const progress = { version: 1, experimentId: row.request.experimentId, planRevision: 1, sessionId: 'execution-session', revision: 1,
    steps: [{ step: 1, state: 'completed', updatedAt: 2 }], updatedAt: 2 }
  vi.mocked(request).mockResolvedValue({ status: 200, value: { supported: true, progress } })
  expect(await f.fleet.executionProgress(row.request.experimentId)).toEqual({ supported: true, progress })
  for (const changed of [{ experimentId: randomUUID() }, { planRevision: 2 }, { sessionId: 'another-session' }]) {
    vi.mocked(request).mockResolvedValue({ status: 200, value: { supported: true, progress: { ...progress, ...changed } } })
    await expect(f.fleet.executionProgress(row.request.experimentId)).rejects.toThrow('another experiment, plan or Session')
  }
  vi.mocked(request).mockResolvedValue({ status: 404, value: { error: 'experiment not found' } })
  await expect(f.fleet.executionProgress(row.request.experimentId)).rejects.toThrow('experiment not found')
  vi.mocked(request).mockResolvedValue({ status: 404, value: { error: 'cluster route not found' } })
  expect(await f.fleet.executionProgress(row.request.experimentId)).toEqual({ supported: false })
  expect(f.records.get(row.request.experimentId)?.submission?.deploymentId).toBe(row.submission?.deploymentId)
})

it('reads legacy UTF-8 history without overlap, removes saved secrets and rejects foreign cursors and metrics', async () => {
  const f = await fixture(); const row = await finished(f)
  const splitSecret = 'x'.repeat(1017) + 'test-only-secret\n'
  const text = splitSecret + '准备🙂\n'.repeat(400) + 'Authorization: Bearer hidden-key\npassword=test-only-secret\n'
  const bytes = Buffer.from(text)
  vi.mocked(request).mockImplementation(async (_target, _token, route, _method, body) => {
    if (route.endsWith('observation-metrics')) return { status: 200, value: [{ experimentId: randomUUID(), serverId: f.a.id, time: 1, gpus: [] }] }
    const { offset } = z.object({ offset: z.number() }).parse(body)
    const nextOffset = Math.min(bytes.length, offset + 4103)
    return { status: 200, value: { generation: 'fixture', offset, nextOffset, data: bytes.subarray(offset, nextOffset).toString('base64'), reset: false, eof: nextOffset === bytes.length } }
  })
  const input = { experimentId: row.request.experimentId, serverId: f.a.id, sourceId: 'legacy-node', stream: 'all' as const, limit: 1024 }
  let page = await f.fleet.logRead(input); let content = page.lines.map(line => line.text).join('')
  while (page.hasMore) { page = await f.fleet.logRead({ ...input, cursor: page.cursor }); content += page.lines.map(line => line.text).join('') }
  expect(content).toBe('x'.repeat(1017) + '*'.repeat(16) + '\n' + '准备🙂\n'.repeat(400) + 'Authorization: [redacted]\npassword=[redacted]\n')
  let before = page.before; const history: string[] = []
  while (before.offset > 0) {
    const previous = await f.fleet.logRead({ ...input, before }); expect(previous.before.offset).toBeLessThan(before.offset)
    history.unshift(...previous.lines.map(line => line.text)); before = previous.before
  }
  expect(history.join('') + page.lines.map(line => line.text).join('')).toBe(content)
  await expect(f.fleet.logRead({ ...input, cursor: { ...page.cursor, experimentId: randomUUID() } })).rejects.toThrow('another source')
  await expect(f.fleet.metrics({ experimentId: row.request.experimentId, serverId: f.a.id })).rejects.toThrow('another experiment')
})

it.each(['cursor', 'before'] as const)('detects a truncated legacy file while reading %s with redaction context', async direction => {
  const f = await fixture(); const row = await finished(f)
  const path = resolve(temporary.at(-1)!, 'legacy.log')
  writeFileSync(path, '历史日志🙂\n'.repeat(40))
  vi.mocked(request).mockImplementation(async (_target, _token, _route, _method, body) => {
    const input = z.object({ offset: z.number(), generation: z.string().optional() }).parse(body)
    return { status: 200, value: readClusterChunk(path, input.offset, input.generation, 5) }
  })
  const input = { experimentId: row.request.experimentId, serverId: f.a.id, sourceId: 'legacy-node', stream: 'all' as const, limit: 1024 }
  const original = await f.fleet.logRead(input)
  writeFileSync(path, '轮转后的输出\n')
  const replaced = await f.fleet.logRead({ ...input, [direction]: original.cursor })
  expect(replaced.reset).toBe(true)
  expect(replaced.lines.map(line => line.text).join('')).toBe('轮转后的输出\n')
  expect(replaced.cursor.offset).toBe(Buffer.byteLength('轮转后的输出\n'))
})

it('reads a generation-5 request without rewriting its coordinator or remote receipt', async () => {
  const f = await fixture()
  const row = await finished(f)
  const { coordinatorId: _selection, ...request } = row.request
  const legacy = fleetExperimentV5Schema.parse({ ...row, request })
  f.records.set(row.request.experimentId, legacy)
  f.tables.get('registry')!.set('servers', { ...f.fleet.servers(), coordinatorId: f.b.id })
  const reopened = await f.open()
  expect(reopened.list()).toEqual([legacy])
  expect(reopened.list()[0]!.coordinator.id).toBe(f.a.id)
  expect(reopened.list()[0]!.request.coordinatorId).toBeUndefined()
})

it('allows server removal after a deleted terminal allocation was reconciled', async () => {
  const f = await fixture()
  const row = await finished(f)
  f.tables.get('registry')!.set('servers', { ...f.fleet.servers(), probes: { [f.a.id]: {
    connected: true, gpuInfo: 'CPU fixture', allocations: [row.request.experimentId],
  } } })
  await f.fleet.deleteExperiments({ experimentIds: [row.request.experimentId], cleanupRemote: false, operationId: randomUUID() })
  expect((await f.fleet.removeServer(f.a.id)).servers.map(server => server.id)).toEqual([f.b.id])
})

it('deletes only released records and prevents delayed replies or reused identities from restoring them', async () => {
  const f = await fixture()
  const row = await finished(f)
  const id = row.request.experimentId
  const pendingReply = Promise.withResolvers<Awaited<ReturnType<typeof request>>>()
  vi.mocked(request).mockReturnValueOnce(pendingReply.promise)
  const refresh = f.fleet.refresh(id)
  const rejected = expect(refresh).rejects.toThrow('experiment not found')
  await vi.waitFor(() => { expect(request).toHaveBeenCalled() })
  const input = { experimentIds: [id], cleanupRemote: false, operationId: randomUUID() }
  expect((await f.fleet.deleteExperiments(input))[0]?.state).toBe('deleted')
  pendingReply.resolve({ status: 200, value: { record: row.latest, waitingFor: [] } })
  await rejected
  expect(f.fleet.snapshot().deletedIds).toContain(id)
  expect(f.fleet.list()).toEqual([])
  expect(cleanupServerStorage).not.toHaveBeenCalled()
  await vi.waitFor(() => { expect(f.ctx.credentials.unset).toHaveBeenCalled() })
  expect((await f.fleet.deleteExperiments(input))[0]?.state).toBe('deleted')
  await expect(f.fleet.create({ ...row.request, coordinatorId: f.a.id })).rejects.toThrow('deleted')
  const reopened = await f.open()
  expect(reopened.list()).toEqual([])
  expect(reopened.snapshot().deletedIds).toContain(id)
})

it('retains partial cleanup across restart, reuses successful nodes and permits explicit record-only deletion', async () => {
  const f = await fixture()
  const row = await finished(f)
  const input = { experimentIds: [row.request.experimentId], cleanupRemote: true, operationId: randomUUID() }
  vi.mocked(cleanupServerStorage).mockResolvedValueOnce().mockRejectedValueOnce(new Error('node unavailable'))
  const failed = (await f.fleet.deleteExperiments(input))[0]!
  expect(failed.state).toBe('failed')
  expect(failed.nodes.map(node => node.state)).toEqual(['cleaned', 'pending'])
  expect(f.fleet.list()).toHaveLength(1)
  const reopened = await f.open()
  expect((await reopened.deleteExperiments(input))[0]?.state).toBe('deleted')
  expect(cleanupServerStorage).toHaveBeenCalledTimes(3)
  const second = await finished(f)
  vi.mocked(cleanupServerStorage).mockRejectedValueOnce(new Error('unreachable'))
  expect((await f.fleet.deleteExperiments({ ...input, experimentIds: [second.request.experimentId], operationId: randomUUID() }))[0]?.state).toBe('failed')
  const calls = vi.mocked(cleanupServerStorage).mock.calls.length
  expect((await f.fleet.deleteExperiments({ experimentIds: [second.request.experimentId], cleanupRemote: false, operationId: randomUUID() }))[0]?.state).toBe('deleted')
  expect(cleanupServerStorage).toHaveBeenCalledTimes(calls)
})

it('skips active and unconfirmed records in a batch and permits record-only deletion without historical ownership', async () => {
  const f = await fixture()
  const active = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), objective: 'still preparing', coordinatorId: f.a.id,
    serverIds: [f.a.id], mode: 'semi', uploads: [{ name: 'input.txt', size: 1 }] })
  const ended = await finished(f)
  const results = await f.fleet.deleteExperiments({ experimentIds: [active.request.experimentId, ended.request.experimentId], cleanupRemote: false, operationId: randomUUID() })
  expect(results.map(row => row.state)).toEqual(['failed', 'deleted'])
  expect(f.fleet.list()).toHaveLength(1)
  await f.fleet.cancel(active.request.experimentId)
  expect(f.fleet.previewDeletion([active.request.experimentId])[0]).toMatchObject({ eligible: true, cleanupAvailable: false })
  expect((await f.fleet.deleteExperiments({ experimentIds: [active.request.experimentId], cleanupRemote: true, operationId: randomUUID() }))[0]?.state).toBe('failed')
  expect((await f.fleet.deleteExperiments({ experimentIds: [active.request.experimentId], cleanupRemote: false, operationId: randomUUID() }))[0]?.state).toBe('deleted')
})

it('blocks deletion with unconfirmed managed processes and exposes interrupted cleanup for retry', async () => {
  const f = await fixture()
  const row = await finished(f)
  f.records.set(row.request.experimentId, { ...row, latest: { ...row.latest!, resourcesReleased: false } })
  expect(f.fleet.previewDeletion([row.request.experimentId])[0]).toMatchObject({ eligible: false, reason: 'cleanup-unconfirmed' })
  f.tables.get('deletions')!.set(row.request.experimentId, { experimentId: row.request.experimentId, operationId: randomUUID(), cleanupRemote: true,
    started: true, state: 'deleting', updatedAt: 1, nodes: [] })
  const reopened = await f.open()
  expect(reopened.snapshot().deletions[0]).toMatchObject({ state: 'failed', detail: expect.stringContaining('interrupted') })
})

it('removes an unreachable experiment locally without claiming its resources are released', async () => {
  const f = await fixture(); const row = await finished(f); const id = row.request.experimentId
  f.records.set(id, { ...row, latest: { ...row.latest!, state: 'failed', resourcesReleased: false } })
  vi.mocked(request).mockClear(); vi.mocked(remote).mockClear()
  const input = { experimentIds: [id], operationId: randomUUID(), cleanupRemote: false, allowUnconfirmed: true }
  expect((await f.fleet.deleteExperiments(input))[0]?.state).toBe('deleted')
  expect(f.fleet.list()).toEqual([])
  expect(request).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled()
  expect(cleanupServerStorage).not.toHaveBeenCalled()
  const reopened = await f.open()
  expect(reopened.list()).toEqual([])
  await expect(reopened.create({ ...row.request, experimentId: randomUUID(), coordinatorId: f.a.id })).rejects.toThrow('unconfirmed')
})

it('deletes a server configuration with acknowledged linked work and retains the experiment snapshot', async () => {
  const f = await fixture(); const row = await finished(f)
  f.records.set(row.request.experimentId, { ...row, latest: { ...row.latest!, state: 'running', resourcesReleased: false } })
  const saved = structuredClone(f.records.get(row.request.experimentId)!)
  vi.mocked(request).mockClear(); vi.mocked(remote).mockClear()
  expect((await f.fleet.removeServer(f.a.id, true)).servers.map(server => server.id)).toEqual([f.b.id])
  expect(f.fleet.list()).toEqual([saved])
  expect(request).not.toHaveBeenCalled(); expect(remote).not.toHaveBeenCalled()
})

it('switches to local deletion while an unreachable cleanup request is pending', async () => {
  const f = await fixture(); const row = await finished(f); const id = row.request.experimentId
  const gate = Promise.withResolvers<void>()
  vi.mocked(cleanupServerStorage).mockImplementationOnce(() => gate.promise)
  const cleaning = f.fleet.deleteExperiments({ experimentIds: [id], operationId: randomUUID(), cleanupRemote: true })
  await vi.waitFor(() => { expect(cleanupServerStorage).toHaveBeenCalledTimes(1) })
  try {
    const removed = await f.fleet.deleteExperiments({ experimentIds: [id], operationId: randomUUID(), cleanupRemote: false, allowUnconfirmed: true })
    expect(removed[0]?.state).toBe('deleted'); expect(f.fleet.list()).toEqual([])
    expect(vi.mocked(cleanupServerStorage).mock.calls[0]![4]?.aborted).toBe(true)
  } finally { gate.resolve(); await cleaning }
  expect(cleanupServerStorage).toHaveBeenCalledTimes(1)
  expect(f.fleet.snapshot().deletions[0]?.state).toBe('deleted')
})

it('retains unknown ownership across new server IDs and only clears matching terminal release evidence', async () => {
  const f = await fixture(); const row = await finished(f); const id = row.request.experimentId
  f.records.set(id, { ...row, latest: { ...row.latest!, state: 'running', resourcesReleased: false } })
  await f.fleet.deleteExperiments({ experimentIds: [id], operationId: randomUUID(), cleanupRemote: false, allowUnconfirmed: true })
  await vi.waitFor(() => { expect(f.tables.get('removals')?.get(id)).toMatchObject({ localCleanup: 'complete' }) })
  await f.fleet.removeServer(f.a.id, true)
  const replacement = clusterServerSchema.parse({ ...f.a, id: randomUUID(), username: 'another-user' })
  await f.fleet.saveServer(replacement)
  expect(f.fleet.snapshot().unconfirmedWork[0]?.serverIds).toContain(replacement.id)
  await expect(f.fleet.create({ ...row.request, experimentId: randomUUID(), serverIds: [replacement.id], coordinatorId: replacement.id })).rejects.toThrow('unconfirmed')
  vi.mocked(request).mockResolvedValueOnce({ status: 404, value: { error: 'not found' } })
  expect(await f.fleet.reconcileRemovedWork(replacement.id)).toEqual([id])
  vi.mocked(request).mockResolvedValueOnce({ status: 200, value: { record: { ...row.latest!, state: 'completed', resourcesReleased: false } } })
  expect(await f.fleet.reconcileRemovedWork(replacement.id)).toEqual([id])
  vi.mocked(request).mockResolvedValueOnce({ status: 200, value: { record: row.latest } })
  expect(await f.fleet.reconcileRemovedWork(replacement.id)).toEqual([])
  expect(f.fleet.snapshot().unconfirmedWork).toEqual([])
  expect(JSON.stringify(f.fleet.snapshot())).not.toContain('test-only-secret')
})

it('does not use local deletion authorization to clean files of unreleased work', async () => {
  const f = await fixture(); const row = await finished(f)
  f.records.set(row.request.experimentId, { ...row, latest: { ...row.latest!, resourcesReleased: false } })
  const result = await f.fleet.deleteExperiments({ experimentIds: [row.request.experimentId], operationId: randomUUID(), cleanupRemote: true, allowUnconfirmed: true })
  expect(result[0]?.state).toBe('failed'); expect(f.fleet.list()).toHaveLength(1)
  expect(cleanupServerStorage).not.toHaveBeenCalled()
})

it('keeps deletion authoritative when local cleanup fails and resumes it after restart', async () => {
  const f = await fixture(); const row = await finished(f); const id = row.request.experimentId
  f.failingLocalTables.add('experiments')
  await f.fleet.deleteExperiments({ experimentIds: [id], operationId: randomUUID(), cleanupRemote: false })
  await vi.waitFor(() => { expect(f.tables.get('removals')?.get(id)).toMatchObject({ localCleanup: 'pending', error: expect.stringContaining('local cleanup unavailable') }) })
  expect(f.fleet.list()).toEqual([])
  expect(f.records.has(id)).toBe(true)
  await expect(f.fleet.refresh(id)).rejects.toThrow('not found')
  f.failingLocalTables.clear()
  const reopened = await f.open()
  await vi.waitFor(() => { expect(f.tables.get('removals')?.get(id)).toMatchObject({ localCleanup: 'complete' }) })
  expect(f.records.has(id)).toBe(false)
  expect(reopened.snapshot().deletedIds).toContain(id)
  expect(reopened.list()).toEqual([])
})

it('removes a staging record and prevents pending input commits from dispatching it', async () => {
  const f = await fixture()
  const row = await f.fleet.create({ models: modelSelections, experimentId: randomUUID(), coordinatorId: f.a.id, serverIds: [f.a.id],
    objective: 'pending upload', uploads: [{ name: 'data.txt', size: 1 }], mode: 'automatic' })
  const input = { experimentIds: [row.request.experimentId], operationId: randomUUID(), cleanupRemote: false, allowUnconfirmed: true }
  expect((await f.fleet.deleteExperiments(input))[0]?.state).toBe('deleted')
  expect((await f.fleet.deleteExperiments(input))[0]?.state).toBe('deleted')
  await expect(f.fleet.commitInputs(row.request.experimentId)).rejects.toThrow('not found')
  await vi.waitFor(() => { expect(f.fleet.snapshot().unconfirmedWork).toEqual([]) })
})
