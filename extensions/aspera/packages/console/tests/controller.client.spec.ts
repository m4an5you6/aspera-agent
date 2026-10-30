import { modelSelections } from '../../experiments/tests/fixtures.ts'
import { fromAny } from '@total-typescript/shoehorn'
const budget = { maxRuntimeSeconds: 3600, maxServiceSeconds: 3600, maxCommands: 100, maxGoalRounds: 100 }
/** Cursor isolation and late-reply handling at the browser RPC boundary. */
import { expect, it, vi } from 'vitest'
import type { FleetExperiment, FleetRegistry, ServerConnectionCheck, PreparationRetryResult, InstallationProgress } from '@aspera/dispatch/types'
import { ExperimentsController } from '../src/client/controller.ts'
import { experimentProgress } from '../src/client/experiment-progress.ts'
import { interruptionView, blockedPreparationTasks } from '../src/client/interruption-view.ts'
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
  const remote = { experimentExecutionProgress: vi.fn(async () => ok<import('@aspera/experiments/types').ExecutionProgressRead>({ supported: false })), validateExperimentModels: vi.fn(async () => ok(modelSelections)), servers: vi.fn(async () => ok({ servers: [] })), experiments: vi.fn(async () => ok(rows)),
    refreshExperiment: vi.fn(async (id: string) => ok(rows.find(row => row.request.experimentId === id)!)),
    experimentFiles: vi.fn(async () => ok({ files: [], truncated: false })),
    readExperiment: vi.fn(async (_id: string, _kind: string, offset: number) => ok({ data: '', offset, nextOffset: offset,
      generation: 'one', eof: true, reset: false })),
    createExperiment: vi.fn(async () => ok(record('third'))), cancelExperiment: vi.fn(async () => ok(rows[0]!)),
    interruptExperiment: vi.fn(async (id: string) => ok(fromAny<import('@aspera/experiments/types').ExperimentInterruptionStatus, object>({ version: 1, experimentId: id,
      operationId: 'operation', submissionHash: 'a'.repeat(64), reason: 'user', stopRequested: true, phase: 'requested', startedAt: 1, updatedAt: 1, nodes: [] }))),
    retryPreparation: vi.fn(async (_id: string) => ok<PreparationRetryResult>({ record: rows[0]!, installations: [] })),
    saveServer: vi.fn(async () => ok<FleetRegistry>({ servers: [] })), setPassword: vi.fn(async () => ok(undefined)),
    removeServer: vi.fn(async () => ok<FleetRegistry>({ servers: [] })),
    reviewExperimentCompletion: vi.fn(async (id: string) => ok(fromAny<import('@aspera/experiments/types').CompletionReview, object>({ experimentId: id,
      operationId: 'review-operation', originalRevision: 1, phase: 'collecting', revision: 1 }))),
    reconcileRemovedWork: vi.fn(async (_id: string) => ok([])),
    settleRemoteTask: vi.fn(async (input: { taskId: string; mode: 'reconcile' | 'interrupt' }) => ok(fromAny<import('@aspera/dispatch/types').RemoteTaskStatus, object>({
      experimentId: input.taskId, name: 'Deleted task', serverIds: [], deleted: true, released: false, recoveryAvailable: true, updatedAt: 2 }))),
    claimErrorNotice: vi.fn(async (_scope: { identity: string }) => ok(true)),
    experimentStorageUsage: vi.fn(async (_id: string) => ok<import('@aspera/experiments/types').ExperimentStorageUsage>({ version: 1, experimentId: rows[0]!.request.experimentId, nodes: [], updatedAt: 1 })),
    probeServer: vi.fn(async () => ok<ServerConnectionCheck>({ status: 'passed', configuration: 'test', result: { gpuInfo: 'GPU fixture', allocations: [] } })),
  }
  const completeRemote = { ...remote, experimentSnapshot: async () => { const registry = await remote.servers(); const experiments = await remote.experiments(); return ok({ registry: registry.value, experiments: experiments.value, deletedIds: [], deletions: [], removedServerIds: [], unconfirmedWork: [], interruptions: [], installations: [] }) } }
  const controller = new ExperimentsController(fromAny<ConstructorParameters<typeof ExperimentsController>[0], typeof completeRemote>(completeRemote),
    { pollIntervalMs: 3000, retainedTextChars: 1000, defaultControlPort: 43019 })
  return { controller, remote, rows }
}

function executionFixture() {
  const f = fixture()
  const row = f.rows[0]!
  row.latest = { ...row.latest!, plan: { revision: 1, summary: 'Actual plan', steps: ['Prepare', 'Verify'], frameworks: [], createdAt: 1 }, sessionId: 'execution-session' }
  const value: import('@aspera/experiments/types').ExecutionProgressRead = { supported: true, progress: { version: 1,
    experimentId: row.request.experimentId, planRevision: 1, sessionId: 'execution-session', revision: 1,
    steps: [{ step: 1, state: 'running' }, { step: 2, state: 'pending' }], updatedAt: 2 } }
  f.remote.experimentExecutionProgress.mockResolvedValue(ok(value))
  return { ...f, value }
}

it('claims applied storage fallback events durably and opens their owning node without repeating notifications', async () => {
  const claimed = new Set<string>()
  const usage = fromAny<import('@aspera/experiments/types').ExperimentStorageUsage, object>({ version: 1, experimentId: 'first', updatedAt: 1,
    nodes: [{ serverId: 'node', arrangement: { eventId: 'a'.repeat(64), estimatedPeakBytes: 100, reason: 'Data storage insufficient' } }] })
  const exercise = async (first: boolean) => {
    const f = fixture()
    f.remote.experimentStorageUsage.mockResolvedValue(ok(usage))
    f.remote.claimErrorNotice.mockImplementation(async scope => { const key = JSON.stringify(scope); const fresh = !claimed.has(key); claimed.add(key); return ok(fresh) })
    try {
      await f.controller.storageUsage('first')
      await vi.waitFor(() => { expect(f.remote.claimErrorNotice).toHaveBeenCalledTimes(1) })
      if (first) await vi.waitFor(() => { expect(f.controller.store.getSnapshot().toast?.key).toBe('storageFallbackApplied') })
      else expect(f.controller.store.getSnapshot().toast).toBeNull()
      f.controller.clearToast()
      await f.controller.storageUsage('first')
      expect(f.remote.claimErrorNotice).toHaveBeenCalledTimes(1)
      expect(f.controller.store.getSnapshot().toast).toBeNull()
      f.controller.openStorageDetails('first', 'node')
      expect(f.controller.store.getSnapshot()).toMatchObject({ selectedId: 'first', storageFocus: { experimentId: 'first', serverId: 'node' } })
    } finally { f.controller.dispose() }
  }
  await exercise(true)
  await exercise(false)
})

it('coalesces deleted-task verification and ignores its late reply after the pending notice disappears', async () => {
  const f = fixture(); const id = f.rows[0]!.request.experimentId
  const task: import('@aspera/dispatch/types').RemoteTaskStatus = { experimentId: id, name: 'Deleted task', serverIds: [],
    deleted: true, released: false, recoveryAvailable: true, updatedAt: 1 }
  const snapshot = { registry: { servers: [] }, experiments: [], deletedIds: [id], deletions: [], removedServerIds: [],
    unconfirmedWork: [task], interruptions: [], installations: [] }
  f.controller.receive(snapshot)
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof f.remote.settleRemoteTask>>>()
  f.remote.settleRemoteTask.mockReturnValueOnce(gate.promise)
  try {
    const first = f.controller.settleRemoteTask(id, 'reconcile')
    expect(f.controller.settleRemoteTask(id, 'reconcile')).toBe(first)
    await vi.waitFor(() => { expect(f.remote.settleRemoteTask).toHaveBeenCalledOnce() })
    expect(f.controller.store.getSnapshot().settlingTasks).toEqual([id])
    f.controller.receive({ ...snapshot, unconfirmedWork: [] })
    gate.resolve(ok({ ...task, updatedAt: 2 })); await first
    expect(f.controller.store.getSnapshot().unconfirmedWork).toEqual([])
    expect(f.controller.store.getSnapshot().experiments).toEqual([])
    expect(f.controller.store.getSnapshot().settlingTasks).toEqual([])
  } finally { gate.resolve(ok(task)); f.controller.dispose() }
})

it('keeps the last step report after a failed refresh and rejects a mismatched plan response', async () => {
  const f = executionFixture()
  try {
    f.controller.select('first'); f.controller.setVisible(true); await f.controller.refresh()
    expect(f.controller.store.getSnapshot().executionReads.first?.value).toEqual(f.value)
    f.remote.experimentExecutionProgress.mockRejectedValueOnce(new Error('SSH disconnected'))
    await f.controller.refresh()
    expect(f.controller.store.getSnapshot().executionReads.first).toMatchObject({ value: f.value, error: expect.stringContaining('SSH disconnected') })
    f.remote.experimentExecutionProgress.mockResolvedValueOnce(ok({ ...f.value, progress: { ...f.value.progress!, planRevision: 2 } }))
    await f.controller.refresh()
    expect(f.controller.store.getSnapshot().executionReads.first).toMatchObject({ value: f.value, error: expect.stringContaining('another experiment, plan or Session') })
  } finally { f.controller.dispose() }
})

it('ignores step replies after switching away and back, deletion or disposal', async () => {
  for (const change of ['selection', 'deletion', 'disposal'] as const) {
    const f = executionFixture()
    const read = Promise.withResolvers<ReturnType<typeof ok<import('@aspera/experiments/types').ExecutionProgressRead>>>()
    f.remote.experimentExecutionProgress.mockReturnValueOnce(read.promise)
    try {
      f.controller.select('first'); f.controller.setVisible(true)
      await vi.waitFor(() => { expect(f.remote.experimentExecutionProgress).toHaveBeenCalledOnce() })
      const running = f.controller.refresh()
      if (change === 'selection') { f.controller.select('second'); f.controller.select('first') }
      else if (change === 'deletion') f.controller.receive({ registry: { servers: [] }, experiments: f.rows, deletedIds: [f.rows[0]!.request.experimentId], deletions: [], removedServerIds: [], unconfirmedWork: [], interruptions: [], installations: [] })
      else f.controller.dispose()
      read.resolve(ok(f.value)); await running
      expect(f.controller.store.getSnapshot().executionReads.first).toBeUndefined()
    } finally { f.controller.dispose() }
  }
})

it('announces an applied source change once across snapshots, close and application restart', async () => {
  const claims = new Set<string>()
  const first = fixture(), restarted = fixture()
  const installation = fromAny<InstallationProgress, object>({ experimentId: first.rows[0]!.request.experimentId,
    serverId: first.rows[0]!.servers[0]!.id, policy: { installationTotalTimeoutMs: 1800000, installationIdleTimeoutMs: 300000, installationMaxRetries: 2 }, history: [],
    round: { id: 'round', state: 'installing', startedAt: 1, deadline: 1800001, attempts: [], probes: [],
      sources: { npm: 'https://mirror.example.test/', nodeHeaders: 'https://nodejs.org/download/release' },
      changes: [{ id: 'unique-source-change', applied: true, changedAt: 100, reason: 'Measured mirror succeeds',
        previous: { npm: 'https://registry.npmjs.org/' }, next: { npm: 'https://mirror.example.test/' },
        probe: { kind: 'npm', detail: '65536 bytes downloaded over HTTPS' } }] } })
  const snapshot = { registry: { servers: [] }, experiments: first.rows, deletedIds: [], deletions: [], removedServerIds: [], unconfirmedWork: [], interruptions: [], installations: [installation] }
  for (const f of [first, restarted]) f.remote.claimErrorNotice.mockImplementation(async ({ identity }) => {
    const seen = claims.has(identity); claims.add(identity); return ok(!seen)
  })
  try {
    first.controller.receive(snapshot)
    await vi.waitFor(() => { expect(first.controller.store.getSnapshot().toast?.key).toBe('installationSourceChanged') })
    expect(first.controller.store.getSnapshot().toast?.detail).toContain('Measured mirror succeeds')
    first.controller.clearToast(); first.controller.receive(snapshot)
    expect(first.remote.claimErrorNotice).toHaveBeenCalledOnce()
    expect(first.controller.store.getSnapshot().toast).toBeNull()
    restarted.controller.receive(snapshot)
    await vi.waitFor(() => { expect(restarted.remote.claimErrorNotice).toHaveBeenCalledOnce() })
    await Promise.resolve()
    expect(restarted.controller.store.getSnapshot().toast).toBeNull()
    const different = structuredClone(installation)
    different.round.changes[0]!.id = fromAny<InstallationProgress['round']['changes'][number]['id'], string>('different-source-change')
    restarted.controller.receive({ ...snapshot, installations: [different] })
    await vi.waitFor(() => { expect(restarted.controller.store.getSnapshot().toast?.key).toBe('installationSourceChanged') })
  } finally { first.controller.dispose(); restarted.controller.dispose() }
})

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
  controller.receive({ deletedIds: [], deletions: [], removedServerIds: [], unconfirmedWork: [], interruptions: [], installations: [], registry: { servers: [server], coordinatorId: server.id }, experiments: [] })
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
  const result = Promise.withResolvers<ReturnType<typeof ok<PreparationRetryResult>>>()
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
    remote.retryPreparation.mockResolvedValue(ok({ record: record('first'), installations: [] }))
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


it('suppresses late operation failures after the experiment or server was removed', async () => {
  const { controller, remote, rows } = fixture()
  try {
    await controller.refresh()
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.refreshExperiment>>>()
    remote.refreshExperiment.mockImplementationOnce(() => response.promise)
    const loading = controller.refresh()
    await vi.waitFor(() => { expect(remote.refreshExperiment.mock.calls.length).toBeGreaterThan(2) })
    controller.receive({ registry: { servers: [] }, experiments: [], deletedIds: [rows[0]!.request.experimentId], deletions: [], removedServerIds: [rows[0]!.servers[0]!.id], unconfirmedWork: [], interruptions: [], installations: [] })
    response.reject(new Error('The operation was aborted due to timeout'))
    await loading
    controller.report(new Error('ECONNREFUSED'), { serverId: 'node', operation: 'probe' })
    await Promise.resolve()
    expect(controller.store.getSnapshot().errorNotice).toBeNull()
    expect(controller.store.getSnapshot().sourceErrors).toEqual({})
    controller.receive({ registry: { servers: rows[0]!.servers }, experiments: rows, deletedIds: [], deletions: [], removedServerIds: [], unconfirmedWork: [], interruptions: [], installations: [] })
    expect(controller.store.getSnapshot().registry.servers).toEqual([])
  } finally { controller.dispose() }
})

it('does not restore deleted experiments from a late refresh, stream reply or stale snapshot', async () => {
  const { controller, remote, rows } = fixture()
  try {
    controller.setVisible(true); controller.select('first'); await controller.refresh()
    const response = Promise.withResolvers<Awaited<ReturnType<typeof remote.refreshExperiment>>>()
    remote.refreshExperiment.mockImplementationOnce(() => response.promise)
    const loading = controller.refresh()
    await vi.waitFor(() => { expect(remote.refreshExperiment.mock.calls.length).toBeGreaterThan(2) })
    controller.receive({ registry: { servers: [] }, experiments: [], deletedIds: [rows[0]!.request.experimentId], deletions: [], removedServerIds: [], unconfirmedWork: [], interruptions: [], installations: [] })
    response.resolve(ok(rows[0]!)); await loading
    controller.receive({ registry: { servers: [] }, experiments: rows, deletedIds: [], deletions: [], removedServerIds: [], unconfirmedWork: [], interruptions: [], installations: [] })
    expect(controller.store.getSnapshot().experiments.map(row => row.request.experimentId)).toEqual(['second'])
    expect(controller.store.getSnapshot().selectedId).toBeNull()
    expect(Object.keys(controller.store.getSnapshot().streams).some(key => key.startsWith('first/'))).toBe(false)
  } finally { controller.dispose() }
})

it('shares one interruption request and retains Host progress after selection changes', async () => {
  const { controller, remote } = fixture()
  try {
    await controller.refresh()
    const reply = Promise.withResolvers<Awaited<ReturnType<typeof remote.interruptExperiment>>>()
    remote.interruptExperiment.mockImplementationOnce(() => reply.promise)
    const first = controller.interrupt('first'); const duplicate = controller.interrupt('first')
    expect(first).toBe(duplicate)
    await vi.waitFor(() => { expect(remote.interruptExperiment).toHaveBeenCalledTimes(1) })
    controller.select('second')
    expect(controller.store.getSnapshot().interrupting).toEqual(['first'])
    const status = (await remote.interruptExperiment.getMockImplementation()!('first')).value
    reply.resolve(ok(status)); await first
    expect(controller.store.getSnapshot().selectedId).toBe('second')
    expect(controller.store.getSnapshot().interruptions[0]?.experimentId).toBe('first')
    expect(controller.store.getSnapshot().interrupting).toEqual([])
  } finally { controller.dispose() }
})

it('retains confirmed interruption against stale snapshots and drops late acknowledgements after deletion', async () => {
  const { controller, remote, rows } = fixture()
  try {
    await controller.refresh()
    const original = (await remote.interruptExperiment('first')).value
    const released = { ...original, phase: 'released' as const, updatedAt: 3 }
    const ended = { ...rows[0]!, latest: { ...rows[0]!.latest!, state: 'cancelled' as const, resourcesReleased: true, revision: 2 } }
    const snapshot = { registry: { servers: [] }, experiments: [ended], deletedIds: [], deletions: [], removedServerIds: [], unconfirmedWork: [], interruptions: [released], installations: [] }
    controller.receive(snapshot)
    controller.receive({ ...snapshot, experiments: rows, interruptions: [{ ...original, updatedAt: 4 }] })
    expect(controller.store.getSnapshot().interruptions[0]?.phase).toBe('released')
    expect(controller.store.getSnapshot().experiments.find(row => row.request.experimentId === 'first')?.latest?.state).toBe('cancelled')
    const reply = Promise.withResolvers<Awaited<ReturnType<typeof remote.interruptExperiment>>>()
    remote.interruptExperiment.mockImplementationOnce(() => reply.promise)
    const stopping = controller.interrupt('second')
    await vi.waitFor(() => { expect(remote.interruptExperiment).toHaveBeenCalledWith('second') })
    controller.receive({ ...snapshot, experiments: [ended], deletedIds: [rows[1]!.request.experimentId] })
    reply.resolve(ok({ ...original, experimentId: rows[1]!.request.experimentId })); await stopping
    expect(controller.store.getSnapshot().interruptions.some(value => value.experimentId === 'second')).toBe(false)
  } finally { controller.dispose() }
})

it('offers interruption for started work, cancellation for pending work and retry for unconfirmed exit', () => {
  const row = record('first')
  expect(interruptionView(row)).toMatchObject({ available: true, action: 'interruptExperiment', busy: false })
  expect(interruptionView({ ...row, latest: { ...row.latest!, state: 'awaiting-approval' } }).action).toBe('cancel')
  const journal = fromAny<import('@aspera/experiments/types').ExperimentInterruptionStatus, object>({ phase: 'blocked', stopRequested: true, operationId: 'operation' })
  expect(interruptionView(row, journal)).toMatchObject({ available: true, action: 'retryInterruption', busy: false, blocked: true })
  expect(interruptionView(row, { ...journal, phase: 'verifying' }).busy).toBe(true)
  const cancelled = { ...row, latest: { ...row.latest!, state: 'cancelled' as const, resourcesReleased: true } }
  expect(interruptionView(cancelled, { ...journal, phase: 'released' })).toMatchObject({ available: false, busy: false, userInterrupted: true })
})

it('links program-observed old task blockers to their original experiment without changing its plan', () => {
  const old = record('first'); const second = record('second'); const { submission: _submission, ...local } = second
  const preparation = { ...local, state: 'failed' as const }
  const journal = fromAny<import('@aspera/experiments/types').ExperimentInterruptionStatus, object>({ experimentId: old.request.experimentId,
    reason: 'controller-recovery', phase: 'blocked' })
  expect(blockedPreparationTasks(preparation, [old, second], [journal])).toEqual([{ experimentId: old.request.experimentId, name: 'first' }])
  expect(blockedPreparationTasks(preparation, [second], [journal])).toEqual([])
  expect(blockedPreparationTasks(preparation, [old, second], [{ ...journal, phase: 'released' }])).toEqual([])
  expect(blockedPreparationTasks(second, [old, second], [journal])).toEqual([])
})

it('projects revalidation only from a committed assessment of the current original result', () => {
  const row = record('first'), failed = { ...row, latest: { ...row.latest!, state: 'failed' as const, resourcesReleased: true } }
  const review = fromAny<import('@aspera/experiments/types').CompletionReview, object>({ originalRevision: failed.latest.revision,
    phase: 'passed', remoteCommitted: true, check: { ready: true } })
  expect(experimentProgress({ ...failed, completionReview: review })).toMatchObject({ status: 'revalidated', phase: 3, issue: false, busy: false })
  expect(failed.latest.state).toBe('failed')
  for (const invalid of [{ ...review, remoteCommitted: false }, { ...review, check: { ...review.check!, ready: false } }, { ...review, originalRevision: review.originalRevision + 1 }]) {
    expect(experimentProgress({ ...failed, completionReview: invalid }).status).toBe('failed')
  }
  expect(experimentProgress({ ...failed, completionReview: { ...review, phase: 'collecting' } })).toMatchObject({ busy: true, status: 'reviewing' })
  expect(experimentProgress({ ...failed, completionReview: { ...review, phase: 'blocked' } })).toMatchObject({ busy: false, attention: true, status: 'review-blocked' })
})
it('shows associated inference recovery on the original task without changing its retained result or training measurements', () => {
  const row = record('first'), original = JSON.stringify(row.latest)
  row.acceptanceRecovery = fromAny<NonNullable<FleetExperiment['acceptanceRecovery']>, object>({ phase: 'recovering' })
  expect(experimentProgress(row)).toMatchObject({ status: 'reviewing', busy: true, phase: 3 })
  row.acceptanceRecovery.phase = 'blocked'
  expect(experimentProgress(row)).toMatchObject({ status: 'review-blocked', busy: false, issue: true })
  expect(JSON.stringify(row.latest)).toBe(original)
})

it('shares supplementary requests across navigation and ignores acknowledgements after deletion', async () => {
  const { controller, remote, rows } = fixture()
  try {
    await controller.refresh()
    const reply = Promise.withResolvers<Awaited<ReturnType<typeof remote.reviewExperimentCompletion>>>()
    remote.reviewExperimentCompletion.mockImplementationOnce(() => reply.promise)
    const first = controller.reviewCompletion('first'), duplicate = controller.reviewCompletion('first')
    expect(first).toBe(duplicate); controller.select('second')
    const review = (await remote.reviewExperimentCompletion.getMockImplementation()!('first')).value
    controller.receive({ registry: { servers: [] }, experiments: [rows[1]!], deletedIds: [rows[0]!.request.experimentId], deletions: [], removedServerIds: [],
      unconfirmedWork: [], interruptions: [], installations: [] })
    reply.resolve(ok(review)); await first
    expect(controller.store.getSnapshot().selectedId).toBe('second')
    expect(controller.store.getSnapshot().experiments.some(row => row.request.experimentId === 'first')).toBe(false)
  } finally { controller.dispose() }
})
