import { modelSelections } from '../../experiments/tests/fixtures.ts'
import { fromAny } from '@total-typescript/shoehorn'
const budget = { maxRuntimeSeconds: 3600, maxServiceSeconds: 3600, maxCommands: 100, maxGoalRounds: 100 }
/** Cursor isolation and late-reply handling at the browser RPC boundary. */
import { expect, it, vi } from 'vitest'
import type { FleetExperiment, FleetRegistry, ServerConnectionCheck } from '@aspera/dispatch/types'
import { ExperimentsController } from '../src/client/controller.ts'
import { experimentProgress } from '../src/client/experiment-progress.ts'
const ok = <T>(value: T) => ({ ok: true as const, value })
function record(id: string): FleetExperiment {
  const experimentId = id as FleetExperiment['request']['experimentId']
  const serverId = 'node' as FleetExperiment['request']['serverIds'][number]
  const server = { id: serverId, name: 'Node', host: 'gpu.example.test', username: 'trainer', sshPort: 22, remotePort: 43019,
    remoteRoot: '/runs', authMode: 'password' as const }
  const target = { ...server, localRepo: '/source', dataRoots: [], preparationOutputChars: 65536, agentCredentialRefs: [],
    tokenRef: 'TEST', controlPollIntervalMs: 1000, toolTimeoutMs: 30000 }
  const submission = { protocol: 1 as const, experimentId, objective: id, deploymentId: 'a'.repeat(64), coordinator: server,
    nodes: [{ server, devicePaths: ['/dev/nvidia0'], backendPath: '/usr/bin/bwrap', hiddenPaths: [], gpuInfo: 'GPU 0' }],
    inputs: [], createdAt: 1, strategy: { mode: 'automatic' as const, coordinator: 'single-agent' as const, budget }, versions: { dsh: '0.2.0-rc.2' as const, extension: '0.1.0' as const, harness: 'a'.repeat(64), data: [] } }
  const receipt = { submission, payloadHash: 'b'.repeat(64), sequence: 1, revision: 1, state: 'running' as const, resourcesReleased: false,
    updatedAt: 1, handover: '本机派发完成，远端实验已接管' as const, executions: [], services: [] }
  return { request: { experimentId, objective: id, serverIds: [serverId], files: [], uploads: [], mode: 'automatic', budget }, coordinator: server,
    coordinatorTarget: target, targets: [target],
    servers: [server], createdAt: 1, state: 'submitted', sessionId: id, waitingFor: [], handoverRecorded: true, agentModel: { provider: 'test', model: 'test' }, receipt,
    submission, latest: receipt }
}
function fixture() {
  const rows = [record('first'), record('second')]
  const remote = { validateExperimentModels: vi.fn(async () => ok(modelSelections)), servers: vi.fn(async () => ok({ servers: [] })), experiments: vi.fn(async () => ok(rows)),
    refreshExperiment: vi.fn(async (id: string) => ok(rows.find(row => row.request.experimentId === id)!)),
    experimentFiles: vi.fn(async () => ok({ files: [], truncated: false })),
    readExperiment: vi.fn(async (_id: string, _kind: string, offset: number) => ok({ data: '', offset, nextOffset: offset,
      generation: 'one', eof: true, reset: false })),
    createExperiment: vi.fn(async () => ok(record('third'))), cancelExperiment: vi.fn(async () => ok(rows[0]!)),
    retryPreparation: vi.fn(async (_id: string) => ok(rows[0]!)),
    saveServer: vi.fn(async () => ok<FleetRegistry>({ servers: [] })), setPassword: vi.fn(async () => ok(undefined)),
    removeServer: vi.fn(async () => ok<FleetRegistry>({ servers: [] })),
    probeServer: vi.fn(async () => ok<ServerConnectionCheck>({ status: 'passed', configuration: 'test', result: { gpuInfo: 'GPU fixture', allocations: [] } })),
  }
  const completeRemote = { ...remote, experimentSnapshot: async () => { const registry = await remote.servers(); const experiments = await remote.experiments(); return ok({ registry: registry.value, experiments: experiments.value, deletedIds: [], deletions: [] }) } }
  const controller = new ExperimentsController(fromAny<ConstructorParameters<typeof ExperimentsController>[0], typeof completeRemote>(completeRemote),
    { pollIntervalMs: 3000, retainedTextChars: 1000, defaultControlPort: 43019 })
  return { controller, remote, rows }
}

it('coalesces a connection check and retains its busy state until the request settles', async () => {
  const { controller, remote } = fixture()
  const result = Promise.withResolvers<ReturnType<typeof ok<ServerConnectionCheck>>>()
  remote.probeServer.mockReturnValue(result.promise)
  try {
    const check = controller.probe('node')
    const rejected = expect(check).rejects.toThrow('host key changed')
    expect(controller.probe('node')).toBe(check)
    controller.select('second')
    expect(controller.store.getSnapshot().probing).toEqual(['node'])
    await Promise.resolve()
    expect(remote.probeServer).toHaveBeenCalledTimes(1)
    result.reject(new Error('host key changed'))
    await rejected
    expect(controller.store.getSnapshot()).toMatchObject({ probing: [], probeErrors: { node: expect.stringContaining('host key changed') } })
    remote.probeServer.mockResolvedValue(ok({ status: 'passed', configuration: 'test', result: { gpuInfo: 'GPU fixture', allocations: [] } }))
    await controller.probe('node')
    expect(controller.store.getSnapshot().probeErrors).toEqual({})
  } finally { controller.dispose() }
})

it('discards a connection result for a removed registration and retains rows after failed removal', async () => {
  const { controller, remote, rows } = fixture()
  const server = rows[0]!.servers[0]!
  controller.receive({ deletedIds: [], deletions: [], registry: { servers: [server], coordinatorId: server.id }, experiments: [] })
  const result = Promise.withResolvers<ReturnType<typeof ok<ServerConnectionCheck>>>()
  remote.probeServer.mockReturnValue(result.promise)
  try {
    remote.removeServer.mockRejectedValueOnce(new Error('pending work'))
    await expect(controller.removeServer(server.id)).rejects.toThrow('pending work')
    expect(controller.store.getSnapshot().registry.servers).toEqual([server])
    expect(controller.store.getSnapshot().removingServers).toEqual([])
    const check = controller.probe(server.id)
    const remove = controller.removeServer(server.id)
    expect(controller.removeServer(server.id)).toBe(remove)
    expect(controller.store.getSnapshot().removingServers).toEqual([server.id])
    await remove
    result.resolve(ok({ status: 'passed', configuration: 'test', result: { gpuInfo: 'stale GPU', allocations: [] } }))
    await check
    expect(controller.store.getSnapshot()).toMatchObject({ registry: { servers: [] }, probes: {}, probeErrors: {}, removingServers: [], probing: [] })
  } finally { controller.dispose() }
})
it('retains one pending retry across navigation and clears it after a rejected request', async () => {
  const { controller, remote } = fixture()
  const result = Promise.withResolvers<ReturnType<typeof ok<FleetExperiment>>>()
  remote.retryPreparation.mockReturnValue(result.promise)
  try {
    const retry = controller.retry('first')
    const rejected = expect(retry).rejects.toThrow('release unavailable')
    expect(controller.store.getSnapshot().retrying).toEqual(['first'])
    controller.select('second')
    expect(controller.retry('first')).toBe(retry)
    await Promise.resolve()
    expect(remote.retryPreparation).toHaveBeenCalledTimes(1)
    result.reject(new Error('release unavailable'))
    await rejected
    expect(controller.store.getSnapshot().retrying).toEqual([])
    remote.retryPreparation.mockResolvedValue(ok(record('first')))
    await controller.retry('first')
    expect(remote.retryPreparation).toHaveBeenCalledTimes(2)
    expect(controller.store.getSnapshot().selectedId).toBe('second')
  } finally { controller.dispose() }
})

it.each([
  ['preparing', 1, true], ['planning', 1, true], ['awaiting-approval', 1, false],
  ['queued', 2, false], ['starting', 2, true], ['running', 2, true], ['serving', 2, true], ['completed', 3, false],
] as const)('projects remote %s into its phase without animating a human or resource wait', (state, phase, busy) => {
  const row = record('stages')
  row.latest = { ...row.latest!, state }
  expect(experimentProgress(row)).toMatchObject({ phase, busy, local: false, status: state })
})

it('retains the failed or paused phase from execution evidence and treats local failure as preparation', () => {
  const row = record('stopped')
  row.latest = { ...row.latest!, state: 'blocked' }
  expect(experimentProgress(row)).toMatchObject({ phase: 1, busy: false, issue: true })
  row.latest = { ...row.latest, sessionId: 'execution', progress: { phase: 'custom model text', metrics: {}, updatedAt: 1 } }
  expect(experimentProgress(row)).toMatchObject({ phase: 2, busy: false, issue: true })
  row.latest = { ...row.latest, state: 'waiting-reply', questions: [fromAny<NonNullable<NonNullable<FleetExperiment['latest']>['questions']>[number], { state: 'open'; stage: 'planning' }>({ state: 'open', stage: 'planning' })] }
  expect(experimentProgress(row)).toMatchObject({ phase: 1, busy: false, attention: true })
  row.latest = undefined; row.receipt = undefined; row.state = 'failed'
  expect(experimentProgress(row)).toMatchObject({ phase: 0, busy: false, local: true })
})
it('leaves log polling to the mounted monitor instead of reading unused sources', async () => {
  const { controller, remote } = fixture()
  remote.readExperiment.mockImplementation(async (id, kind, offset) => {
    const bytes = new TextEncoder().encode(id === 'first' ? '训练' : '另一个')
    const part = kind === 'log' ? bytes.slice(offset, offset + 2) : new Uint8Array()
    return ok({ data: btoa(String.fromCharCode(...part)), offset, nextOffset: offset + part.length, generation: 'one',
      eof: false, reset: false })
  })
  try {
    controller.setVisible(true)
    controller.select('first'); await controller.refresh(); await controller.refresh(); await controller.refresh()
    expect(controller.store.getSnapshot().streams).toEqual({})
    controller.select('second'); await controller.refresh()
    expect(controller.store.getSnapshot().streams).toEqual({})
    expect(remote.readExperiment).not.toHaveBeenCalled()
  } finally { controller.dispose() }
})
it('retains rows and remote errors when a local snapshot succeeds', async () => {
  const { controller, remote } = fixture()
  try {
    controller.setVisible(true)
    controller.select('first'); await controller.refresh()
    remote.experiments.mockRejectedValueOnce(new Error('connection lost'))
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({ error: 'connection lost', experiments: [expect.anything(), expect.anything()] })
    remote.readExperiment.mockResolvedValue({ ok: true, value: { data: btoa('restarted'), offset: 0, nextOffset: 9,
      generation: 'two', eof: true, reset: true } })
    await controller.refresh()
    expect(controller.store.getSnapshot().error).toBe('connection lost')
    expect(controller.store.getSnapshot().experiments).toHaveLength(2)
  } finally { controller.dispose() }
})
it('does not erase a newly submitted Goal when an older list reply arrives', async () => {
  const { controller, remote } = fixture()
  const reply = Promise.withResolvers<Awaited<ReturnType<typeof remote.experiments>>>()
  remote.experiments.mockReturnValueOnce(reply.promise)
  const loading = controller.refresh()
  try {
    await controller.create('third', ['node'], 'node', [], [], 'third', 'automatic', 'Third', modelSelections)
    reply.resolve(ok([])); await loading
    expect(controller.store.getSnapshot().experiments.map(row => row.request.experimentId)).toEqual(['third'])
  } finally { reply.resolve(ok([])); await loading; controller.dispose() }
})
it('disposal ignores an in-flight reply and stops follow-up reads', async () => {
  const { controller, remote } = fixture()
  const reply = Promise.withResolvers<Awaited<ReturnType<typeof remote.experiments>>>()
  remote.experiments.mockReturnValueOnce(reply.promise)
  const loading = controller.refresh(); controller.dispose(); reply.resolve(ok([record('late')]))
  await loading
  expect(controller.store.getSnapshot().experiments).toEqual([])
  expect(remote.refreshExperiment).not.toHaveBeenCalled()
})

it('refreshes a background plan while another Goal is being created and stops polling released terminal tasks', async () => {
  const { controller, remote, rows } = fixture()
  rows[0]!.latest = { ...rows[0]!.latest!, state: 'planning', resourcesReleased: true }
  rows[1]!.latest = { ...rows[1]!.latest!, state: 'completed', resourcesReleased: true }
  try {
    await controller.refresh()
    expect(remote.refreshExperiment.mock.calls.map(([id]) => id)).toEqual(['first'])
  } finally { controller.dispose() }
})

it('refreshes pending receipts off-page without reading logs or artifacts', async () => {
  const { controller, remote, rows } = fixture()
  rows[0]!.latest = { ...rows[0]!.latest!, state: 'awaiting-approval', resourcesReleased: true }
  try {
    controller.select('first'); await controller.refresh()
    controller.tick(); await controller.refresh()
    expect(remote.refreshExperiment).toHaveBeenCalled()
    expect(remote.readExperiment).not.toHaveBeenCalled()
    expect(remote.experimentFiles).not.toHaveBeenCalled()
  } finally { controller.dispose() }
})


it('queues distinct errors while repeated reports preserve source health without another toast', async () => {
  const { controller } = fixture()
  try {
    const scope = { operation: 'logs' }
    controller.report(new Error('The operation was aborted due to timeout'), scope)
    await vi.waitFor(() => { expect(controller.store.getSnapshot().errorNotice?.identity).toBe('timeout') })
    controller.report(new Error('ECONNREFUSED'), scope)
    controller.report(new Error('The operation was aborted due to timeout'), scope)
    await vi.waitFor(() => { expect(controller.store.getSnapshot().error).toContain('timeout') })
    await new Promise<void>(resolve => { queueMicrotask(resolve) })
    controller.dismissErrorNotice()
    await vi.waitFor(() => { expect(controller.store.getSnapshot().errorNotice?.identity).toBe('ECONNREFUSED') })
    controller.dismissErrorNotice()
    expect(controller.store.getSnapshot().errorNotice).toBeNull()
    expect(Object.values(controller.store.getSnapshot().sourceErrors)).toHaveLength(1)
  } finally { controller.dispose() }
})

it('persists dismissed revision reminders and group folding without resolving pending work', async () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } })
  const f = fixture()
  const plan = { revision: 1, summary: 'Review this plan', steps: ['Trial'], frameworks: [], createdAt: 1 }
  f.rows[0]!.latest = { ...f.rows[0]!.latest!, state: 'awaiting-approval', resourcesReleased: true, plan }
  const { experimentTodos, experimentAttentionCount } = await import('../src/client/attention.ts')
  try {
    await f.controller.refresh(); f.controller.dismissTodos(); f.controller.toggleGroup()
    expect(experimentAttentionCount(f.controller.store.getSnapshot().experiments)).toBe(1)
    const restored = fixture()
    try {
      restored.rows[0] = f.rows[0]!
      await restored.controller.refresh()
      const state = restored.controller.store.getSnapshot()
      expect(state.preferences.collapsed).toBe(true)
      expect(experimentTodos(state.experiments).filter(todo => !state.preferences.dismissed.includes(todo.key))).toEqual([])
      restored.rows[0] = { ...restored.rows[0]!, latest: { ...restored.rows[0]!.latest!, plan: { ...plan, revision: 2 } } }
      await restored.controller.refresh()
      expect(experimentTodos(restored.controller.store.getSnapshot().experiments).filter(todo => !state.preferences.dismissed.includes(todo.key))).toHaveLength(1)
      restored.rows[0] = { ...restored.rows[0]!, latest: { ...restored.rows[0]!.latest!, state: 'queued' } }
      await restored.controller.refresh()
      expect(experimentTodos(restored.controller.store.getSnapshot().experiments)).toEqual([])
    } finally { restored.controller.dispose() }
  } finally { f.controller.dispose(); vi.unstubAllGlobals() }
})


it('does not restore deleted experiments from a late refresh, stream reply or stale snapshot', async () => {
  const { controller, remote, rows } = fixture()
  try {
    controller.setVisible(true); controller.select('first'); await controller.refresh()
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.refreshExperiment>>>()
    remote.refreshExperiment.mockImplementationOnce(() => response.promise)
    const loading = controller.refresh()
    await vi.waitFor(() => { expect(remote.refreshExperiment.mock.calls.length).toBeGreaterThan(2) })
    controller.receive({ registry: { servers: [] }, experiments: [], deletedIds: [rows[0]!.request.experimentId], deletions: [] })
    response.resolve(ok(rows[0]!)); await loading
    controller.receive({ registry: { servers: [] }, experiments: rows, deletedIds: [], deletions: [] })
    expect(controller.store.getSnapshot().experiments.map(row => row.request.experimentId)).toEqual(['second'])
    expect(controller.store.getSnapshot().selectedId).toBeNull()
    expect(Object.keys(controller.store.getSnapshot().streams).some(key => key.startsWith('first/'))).toBe(false)
  } finally { controller.dispose() }
})
