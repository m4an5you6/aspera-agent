import { modelSelections } from '../../experiments/tests/fixtures.ts'
import { fromAny } from '@total-typescript/shoehorn'
const budget = { maxRuntimeSeconds: 3600, maxServiceSeconds: 3600, maxCommands: 100, maxGoalRounds: 100 }
/** Cursor isolation and late-reply handling at the browser RPC boundary. */
import { expect, it, vi } from 'vitest'
import type { FleetExperiment } from '@aspera/dispatch/types'
import { ExperimentsController } from '../src/client/controller.ts'
const ok = <T>(value: T) => ({ ok: true as const, value })
function record(id: string): FleetExperiment {
  const experimentId = id as FleetExperiment['request']['experimentId']
  const serverId = 'node' as FleetExperiment['request']['serverIds'][number]
  const server = { id: serverId, name: 'Node', host: 'gpu.example.test', username: 'trainer', sshPort: 22, remotePort: 43019,
    remoteRoot: '/runs', authMode: 'password' as const }
  const target = { ...server, localRepo: '/source', dataRoots: [], allowedSystemPackages: [], agentCredentialRefs: [],
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
    saveServer: vi.fn(async () => ok({ servers: [] })), setPassword: vi.fn(async () => ok(undefined)),
  }
  const controller = new ExperimentsController(fromAny<ConstructorParameters<typeof ExperimentsController>[0], typeof remote>(remote),
    { pollIntervalMs: 3000, retainedTextChars: 1000, defaultControlPort: 43019 })
  return { controller, remote, rows }
}
it('continues UTF-8 byte cursors independently for each experiment and node', async () => {
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
    expect(controller.store.getSnapshot().streams['first/node']!.text).toBe('训练')
    controller.select('second'); await controller.refresh()
    expect(controller.store.getSnapshot().streams['second/node']!.offset).toBe(2)
    expect(controller.store.getSnapshot().streams['first/node']!.text).toBe('训练')
    expect(remote.readExperiment.mock.calls.filter(([id, kind]) => id === 'first' && kind === 'log').map(([, ,
      offset]) => offset)).toEqual([0, 2, 4])
  } finally { controller.dispose() }
})
it('retains rows when a request fails and shows a rotation warning after recovery', async () => {
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
    expect(controller.store.getSnapshot().streams['first/node']).toMatchObject({ text: 'restarted', reset: true, offset: 9 })
  } finally { controller.dispose() }
})
it('does not erase a newly submitted Goal when an older list reply arrives', async () => {
  const { controller, remote } = fixture()
  const reply = Promise.withResolvers<Awaited<ReturnType<typeof remote.experiments>>>()
  remote.experiments.mockReturnValueOnce(reply.promise)
  const loading = controller.refresh()
  try {
    await controller.create('third', ['node'], [], [], 'third', 'automatic', 'Third', modelSelections)
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
