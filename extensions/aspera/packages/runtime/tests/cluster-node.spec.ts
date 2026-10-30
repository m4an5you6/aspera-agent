import { fromAny } from '@total-typescript/shoehorn'
const budget = { maxRuntimeSeconds: 3600, maxServiceSeconds: 3600, maxCommands: 100, maxGoalRounds: 100 }
const deadline = Date.now() + 3600000
/** Node ownership tests use isolated files and explicitly settled managed-process doubles. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, renameSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { resolve, posix } from 'node:path'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createClusterNode } from '../src/cluster-node.ts'
import { CommandAdmissionRejected } from '../src/command-admission.ts'
import { finalizationPolicySchema } from '../src/finalization-policy.ts'
import { clusterNodeSchema, experimentIdSchema, processLogPageSchema, experimentProcessSchema, observationPolicySchema } from '@aspera/experiments'
import type { StoragePlacement } from '@aspera/experiments'
import { placement } from '../../experiments/tests/fixtures.ts'
import { verifyStorage } from '../scripts/storage.mjs'
import { probeControllerGpu } from '../src/controller.ts'
import { controllerStatusSchema } from '@aspera/experiments'
import { ManagedEnvironments, managedEnvironmentPolicySchema, EnvironmentInspectionError } from '../src/managed-environment.ts'
import type { ManagedEnvironmentPolicy } from '../src/managed-environment.ts'
import { prepareExperimentEnvironmentSchema } from '@aspera/experiments'
import { storageToolResult, storageToolPageSchema } from '../src/storage-tool-result.ts'
import { prepareExperimentMaterialsSchema, materialOperationSchema } from '@aspera/experiments'
import { stageRegistrationSchema } from '@aspera/experiments'
import { CheckpointProtection } from '../src/checkpoint-protection.ts'
import { serverRunRoot } from '../src/storage.ts'
import { inferenceCheckpointCandidateSchema } from '@aspera/experiments'
vi.mock('../src/controller.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/controller.ts')>(),
  probeControllerGpu: vi.fn(async () => ({ gpus: [{ uuid: 'GPU-11111111-1111-1111-1111-111111111111', name: 'CPU fixture GPU', devicePath: '/dev/nvidia0' }], devicePaths: ['/dev/nvidia0'] })) }))
vi.mock('../scripts/storage.mjs', () => ({ verifyStorage: vi.fn((value: StoragePlacement) => value.candidate) }))
const cleanup: (() => Promise<void>)[] = []

it('protects approved checkpoint files from the next ordinary cleanup command', async () => {
  const f = await fixture(), id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  const root = serverRunRoot(node.server, id), workspace = resolve(root, 'workspace')
  const files = ['trainer_state.json', 'adapter_model.safetensors', 'optimizer.pt', 'scheduler.pt']
  const stage = stageRegistrationSchema.parse({ version: 1, experimentId: id, serverId: f.node.server.id,
    sessionId: 'execution', planRevision: 1, registeredAt: 1, historical: false, stageId: 'stage1', attemptId: 'a1', commandId: 'train1',
    parameters: 'args.json', trainerState: 'metrics/state.json', metrics: 'metrics/train.jsonl', requirement: {
      stageId: 'stage1', planStep: 1, title: 'Preserve saved checkpoint', framework: 'transformers', startStep: 0,
      additionalSteps: 2, endStep: 2, metricScope: 'stage', loggingSteps: 1,
      scheduler: { mode: 'fresh', type: 'linear', learningRate: 0.001, totalSteps: 2, warmupSteps: 0 },
      requiredFiles: files.map(name => 'checkpoints/protected/checkpoint-2/' + name) } })
  await new CheckpointProtection(root, workspace, id, f.node.server.id).register(stage)
  await f.handler('run', { experimentId: id, commandId: 'train1', command: 'train-fixture' })
  const checkpoint = resolve(workspace, 'checkpoints/protected/checkpoint-2')
  mkdirSync(checkpoint, { recursive: true })
  for (const name of files) writeFileSync(resolve(checkpoint, name), name === 'trainer_state.json' ? '{"global_step":2}' : 'preserved')
  f.handles[0]!.settle()
  await vi.waitFor(async () => expect(await f.handler('command-status', { experimentId: id, commandId: 'train1' })).toMatchObject({ result: { state: 'completed', released: true } }))
  await f.handler('run', { experimentId: id, commandId: 'format-evidence', command: 'rm -rf checkpoints/protected/checkpoint-2' })
  const argv = f.spawn.mock.calls.at(-1)![0].argv
  expect(argv.some((item, index) => item === '--ro-bind' && argv[index + 1] === checkpoint && argv[index + 2] === checkpoint)).toBe(true)
})
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('recovers a completed material verification after its exit settlement failed without relaunching it', async () => {
  const f = await fixture(), id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  const request = prepareExperimentMaterialsSchema.parse({ operationId: randomUUID(), materialId: 'c'.repeat(64), action: 'verify' })
  let value = materialOperationSchema.parse({ version: 1, experimentId: id, serverId: node.server.id, operationId: request.operationId,
    materialId: request.materialId, requestHash: 'd'.repeat(64), commandId: 'material-' + request.operationId, action: 'verify', state: 'requested',
    startedAt: Date.now(), deadline: Date.now() + 60000, updatedAt: Date.now(), downloadedBytes: 0, reusedBytes: 0, exitConfirmed: false, admissionReleased: false })
  let attempts = 0
  const status = vi.spyOn(ManagedEnvironments.prototype, 'materialStatus').mockImplementation(() => value)
  const original = vi.spyOn(ManagedEnvironments.prototype, 'materialOriginal').mockReturnValue(request)
  const command = vi.spyOn(ManagedEnvironments.prototype, 'materialCommand').mockReturnValue({ argv: ['fixture-material'], commandId: value.commandId!, deadline: value.deadline, registration: request })
  const governance = vi.spyOn(ManagedEnvironments.prototype, 'governance').mockImplementation(async (_binding, action) => {
    if (action === 'material-settle') {
      attempts += 1
      if (attempts === 1) throw new Error('transient settlement write failure')
      value = { ...value, exitConfirmed: true, admissionReleased: true, exitCode: 0 }; return value
    }
    return value
  })
  try {
    await f.handler('material-prepare', { experimentId: id, ...request })
    expect(await f.handler('material-prepare', { experimentId: id, ...request, action: 'recover' })).toMatchObject({ state: 'requested', admissionReleased: false })
    expect(attempts).toBe(0); expect(f.spawn).toHaveBeenCalledOnce()
    value = { ...value, state: 'completed', exitConfirmed: true }
    f.handles[0]!.settle()
    await vi.waitFor(() => { expect(attempts).toBe(1) })
    await new Promise<void>(done => setImmediate(done))
    expect(await f.handler('material-status', { experimentId: id, operationId: request.operationId })).toMatchObject({ admissionReleased: false,
      settlementError: expect.stringContaining('transient settlement write failure') })
    const failurePath = resolve(node.server.storagePlacement.runRoot, 'material-operations-v1', request.operationId, 'settlement-failure.v1.json')
    const failure = JSON.parse(readFileSync(failurePath, 'utf8'))
    writeFileSync(failurePath, JSON.stringify({ ...failure, experimentId: randomUUID() }))
    await expect(f.handler('material-status', { experimentId: id, operationId: request.operationId })).rejects.toThrow('belongs to another operation')
    writeFileSync(failurePath, JSON.stringify(failure))
    expect(await f.handler('material-prepare', { experimentId: id, ...request, action: 'recover' })).toMatchObject({ state: 'completed', exitConfirmed: true, admissionReleased: true })
    expect(attempts).toBe(2); expect(f.spawn).toHaveBeenCalledOnce()
    expect(existsSync(resolve(f.config.root, 'state/environment-fences', id + '.json'))).toBe(false)
    expect(existsSync(failurePath)).toBe(false)
  } finally { governance.mockRestore(); command.mockRestore(); original.mockRestore(); status.mockRestore() }
})
async function loopbackPort(hold = false): Promise<number> {
  const listener = createServer()
  await new Promise<void>((ready, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', ready) })
  const address = listener.address()
  if (address === null || typeof address === 'string') throw new Error('test port was not assigned')
  const close = () => new Promise<void>((done) => { listener.close(() => { done() }) })
  if (hold) cleanup.push(close)
  else await close()
  return address.port
}
async function fixture(policy: Partial<ManagedEnvironmentPolicy> = {}) {
  vi.mocked(probeControllerGpu).mockReset()
  vi.mocked(probeControllerGpu).mockResolvedValue({ gpus: [{ uuid: 'GPU-11111111-1111-1111-1111-111111111111', name: 'CPU fixture GPU', devicePath: '/dev/nvidia0' }], devicePaths: ['/dev/nvidia0'] })
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const absolute = mkdtempSync(resolve('.artifacts', 'cluster-node-'))
  const root = process.platform === 'win32' ? absolute.slice(2).replaceAll('\\', '/') : absolute
  const storageContext = new Context()
  await storageContext.plugin(Storage)
  const storageRoot = resolve(absolute, 'storage')
  const backend = new JsonStorageBackend(storageRoot)
  storageContext.effect(() => {
    const unregister = storageContext.storage.backend.register('json', backend)
    return async () => { unregister(); await backend.close() }
  })
  const facility = new DomainFacility(storageContext, { backend: 'json', routes: {} })
  storageContext.effect(() => storageContext.storage.mount('domain', facility))
  const disposers: (() => Promise<void>)[] = []
  const handles: { stdout: PassThrough; stderr: PassThrough; settle: (exitCode?: number) => void; terminate: ReturnType<typeof vi.fn>; waitForExit: ReturnType<typeof vi.fn<() => Promise<boolean>>> }[] = []
  const spawn = vi.fn((_spec: import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec) => {
    const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
    const stdout = new PassThrough(); const stderr = new PassThrough()
    const terminate = vi.fn(() => {})
    const waitForExit = vi.fn(async () => true)
    handles.push({ stdout, stderr, terminate, waitForExit, settle: (exitCode = 0) => { stdout.end(); stderr.end(); done.resolve({ exitCode, signal: null }) } })
    return { stdout, stderr, done: done.promise, terminate, waitForExit }
  })
  const confine = vi.fn(async (argv: string[], _options: unknown) => ({ argv }))
  const ctx = fromAny<Context, object>({ storage: { domain: facility }, subprocess: { spawn }, sandbox: { confine },
  effect: (setup: () => () => Promise<void>) => { disposers.push(setup()) }, logger: { error: vi.fn(), debug: vi.fn() },
  })
  const config = { root, backendPath: '/usr/bin/bwrap', hiddenPaths: [], bootId: 'boot-1', chunkBytes: 1024, fileLimit: 10, cleanupTimeoutMs: 1000,
    finalization: finalizationPolicySchema.parse({ diagnostics: { timeoutMs: 1000, logBytes: 1024 } }),
    deploymentId: 'a'.repeat(64), gpuSnapshot: { gpus: [{ uuid: 'GPU-11111111-1111-1111-1111-111111111111', name: 'CPU fixture GPU', devicePath: '/dev/nvidia0' }], devicePaths: ['/dev/nvidia0'] },
    serviceRequestTimeoutMs: 1000, serviceRequestBytes: 1024, devicePaths: ['/dev/nvidia0'],
    observations: observationPolicySchema.parse({ intervalMs: 60000 }), managedEnvironments: managedEnvironmentPolicySchema.parse(policy) }
  const restart = async (confirmed = false) => {
    const image = confirmed ? [] : ['allocations', 'commands', 'services'].flatMap(table => {
      const directory = resolve(storageRoot, 'aspera_node', table)
      return existsSync(directory) ? readdirSync(directory).map(name => {
        const path = resolve(directory, name)
        return { path, bytes: readFileSync(path) }
      }) : []
    })
    for (const handle of handles) { if (!confirmed) handle.waitForExit.mockResolvedValue(false); handle.settle() }
    for (const dispose of disposers.splice(0).reverse()) await dispose()
    // A crashed controller cannot persist acknowledgements from its test-handle teardown.
    for (const { path, bytes } of image) writeFileSync(path, bytes)
    return createClusterNode(ctx, { ...config, bootId: 'boot-2' })
  }
  cleanup.push(async () => {
    for (const handle of handles) handle.settle()
    for (const dispose of disposers.reverse()) await dispose()
    await facility.closeAll()
    await storageContext.fiber.dispose()
    rmSync(absolute, { recursive: true, force: true })
  })
  const handler = await createClusterNode(ctx, config)
  const node = clusterNodeSchema.parse({ server: { id: randomUUID(), name: 'node', username: 'trainer', host: 'gpu', sshPort: 22,
    remotePort: 43019, remoteRoot: root, authMode: 'password' }, devicePaths: ['/dev/nvidia0'],
  backendPath: '/usr/bin/bwrap', hiddenPaths: [], gpuInfo: 'GPU 0' })
  return { handler, node, handles, confine, spawn, ctx, config, storageRoot, restart }
}
it('atomically fences allocation during identity-bound idle maintenance', async () => {
  const f = await fixture(); const health = await f.handler('health', {})
  const controller = z.object({ controller: controllerStatusSchema }).parse(health).controller
  const owner = { operationId: randomUUID(), bootId: controller.bootId, policyDigest: controller.policyDigest }
  await expect(f.handler('maintenance-begin', { ...owner, bootId: 'old-controller' })).rejects.toThrow('identity changed')
  const [first, duplicate] = await Promise.all([f.handler('maintenance-begin', owner), f.handler('maintenance-begin', owner)])
  expect(first).toEqual(duplicate)
  await expect(f.handler('allocate', { experimentId: randomUUID(), deploymentId: 'a'.repeat(64), protocol: 2, node: f.node })).rejects.toThrow('maintenance')
  await expect(f.handler('maintenance-cancel', { ...owner, operationId: randomUUID() })).rejects.toThrow('another operation')
  await f.handler('maintenance-cancel', owner)
  await f.handler('allocate', { experimentId: randomUUID(), deploymentId: 'a'.repeat(64), protocol: 2, node: f.node })
  await expect(f.handler('maintenance-begin', owner)).rejects.toThrow('occupied')
})
it('refuses protocol-4 allocation after the physical GPU changes without starting a command', async () => {
  const f = await fixture(); const current = structuredClone(f.config.gpuSnapshot); const id = experimentIdSchema.parse(randomUUID())
  current.gpus[0]!.uuid = 'GPU-22222222-2222-2222-2222-222222222222'
  vi.mocked(probeControllerGpu).mockResolvedValueOnce(current)
  await expect(f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4,
    node: { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
      gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' } })).rejects.toThrow('hardware changed')
  expect(f.spawn).not.toHaveBeenCalled()
})
it('records rejected environment startup and releases its fence without inventing a process exit code', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  const request = prepareExperimentEnvironmentSchema.parse({ operationId: randomUUID(), environmentId: 'training', action: 'install' })
  const recovery = vi.spyOn(ManagedEnvironments.prototype, 'recover').mockImplementation(async (binding, original, confirmed) => {
    expect(confirmed).toBe(true)
    const receipt = { version: 1 as const, experimentId: id, serverId: f.node.server.id, operationId: original.operationId,
      environmentId: original.environmentId, requestHash: 'a'.repeat(64), action: original.action, state: 'blocked' as const,
      commandId: 'environment-' + original.operationId, startedAt: 1, updatedAt: 2, exitConfirmed: true, exitCode: null, detail: 'Rejected before process launch' }
    const path = resolve(binding.node.server.storagePlacement!.runRoot, 'environment-operations-v1', original.operationId)
    mkdirSync(path, { recursive: true }); writeFileSync(resolve(path, 'receipt.v1.json'), JSON.stringify(receipt))
    return receipt
  })
  cleanup.push(async () => { recovery.mockRestore() })
  vi.mocked(verifyStorage).mockImplementationOnce(() => { throw new Error('Storage mount changed') })
  await expect(f.handler('environment-prepare', { experimentId: id, ...request })).rejects.toThrow('Storage mount changed')
  expect(f.spawn).not.toHaveBeenCalled(); expect(recovery).toHaveBeenCalledOnce()
  expect(existsSync(resolve(f.config.root, 'state/environment-fences', id + '.json'))).toBe(false)
  await expect(f.handler('environment-prepare', { experimentId: id, ...request })).resolves.toMatchObject({ state: 'blocked', exitConfirmed: true, exitCode: null })
  const startup = JSON.parse(readFileSync(resolve(node.server.storagePlacement.runRoot, 'environment-launches-v1', request.operationId + '.json'), 'utf8'))
  expect(startup.state).toBe('not-started')
})
it('passes the actual node inspection response through the tool parser and preserves a scan failure', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  const inspect = vi.spyOn(ManagedEnvironments.prototype, 'inspect').mockResolvedValue({
    serverId: node.server.id, name: 'node', checkedAt: 123, source: 'remote', availableBytes: 17, capacityBytes: 30,
    workspaceBytes: 0, sharedBytes: 0, reclaimableBytes: 0, environments: [], legacy: [], complete: false,
  })
  cleanup.push(async () => { inspect.mockRestore() })
  const options = { runRoot: node.server.storagePlacement.runRoot, experimentId: id, serverId: node.server.id, maxBytes: 4096 }
  const value = await f.handler('environment-inspect', { experimentId: id })
  expect(await storageToolResult({ ...options, value })).toMatchObject({ availableBytes: 17, complete: false })
  inspect.mockRejectedValueOnce(new Error('Original environment reference remains unconfirmed'))
  const failed = JSON.parse(JSON.stringify(await storageToolResult({ ...options, value: await f.handler('environment-inspect', { experimentId: id }) })))
  expect(failed).not.toHaveProperty('availableBytes')
  expect(await storageToolResult({ ...options, page: storageToolPageSchema.parse(failed.sections.diagnostics.page) }))
    .toMatchObject({ rows: ['Error: Original environment reference remains unconfirmed'] })
})
it('keeps legacy missing-command operations fenced and gives pending receipts stable times', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  const manager = new ManagedEnvironments(f.ctx)
  const binding = { experimentId: id, node, deploymentId: 'a'.repeat(64), controlRoot: f.config.root, hiddenPaths: [] }
  const request = prepareExperimentEnvironmentSchema.parse({ operationId: randomUUID(), environmentId: 'training', action: 'install' })
  manager.command(binding, request)
  expect(manager.receipt(binding, request)).toEqual(manager.receipt(binding, request))
  const fence = resolve(f.config.root, 'state/environment-fences', id + '.json')
  mkdirSync(resolve(f.config.root, 'state/environment-fences'), { recursive: true })
  writeFileSync(fence, JSON.stringify({ version: 1, operationId: request.operationId, commandId: 'environment-' + request.operationId }))
  await expect(f.handler('environment-recover', { experimentId: id, operationId: request.operationId })).rejects.toThrow('startup evidence are missing')
  expect(existsSync(fence)).toBe(true); expect(f.spawn).not.toHaveBeenCalled()
  await expect(f.handler('run', { experimentId: id, commandId: 'probe', command: 'true' })).rejects.toThrow(`Environment operation ${request.operationId}`)
})
it('keeps lightweight installation status pending until the process group exits and rejects concurrent ordinary commands', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  const request = prepareExperimentEnvironmentSchema.parse({ operationId: randomUUID(), environmentId: 'training', action: 'create', requirements: ['tiny-fixture==1'] })
  await f.handler('environment-prepare', { experimentId: id, ...request })
  const running = await f.handler('environment-status', { experimentId: id, operationId: request.operationId })
  expect(running).toMatchObject({ state: 'running', admissionReleased: false, processState: 'running' })
  const manager = new ManagedEnvironments(f.ctx)
  const binding = { experimentId: id, node, deploymentId: 'a'.repeat(64), controlRoot: f.config.root, hiddenPaths: [] }
  const lifetime = manager.runtime(binding, request.operationId)!
  await f.handler('environment-prepare', { experimentId: id, ...request })
  expect(f.spawn).toHaveBeenCalledOnce(); expect(manager.runtime(binding, request.operationId)!.deadline).toBe(lifetime.deadline)
  const receipt = { ...manager.receipt(binding, request), state: 'completed', exitConfirmed: true, exitCode: 0 }
  const folder = resolve(node.server.storagePlacement.runRoot, 'environment-operations-v1', request.operationId)
  mkdirSync(folder, { recursive: true }); writeFileSync(resolve(folder, 'receipt.v1.json'), JSON.stringify(receipt))
  await expect(f.handler('run', { experimentId: id, commandId: 'premature', command: 'true' })).rejects.toThrow(request.operationId)
  const exit = Promise.withResolvers<boolean>(); f.handles[0]!.waitForExit.mockReturnValue(exit.promise); f.handles[0]!.settle()
  expect(await f.handler('environment-status', { experimentId: id, operationId: request.operationId })).toMatchObject({ state: 'running', detail: expect.stringContaining('waiting for process-group exit') })
  exit.resolve(true)
  await vi.waitFor(async () => { expect(await f.handler('environment-status', { experimentId: id, operationId: request.operationId })).toMatchObject({ state: 'completed', admissionReleased: true, processState: 'exited' }) })
  expect(manager.runtime(binding, request.operationId)).toMatchObject({ exitConfirmed: true, exitCode: 0, admissionReleased: true, deadline: lifetime.deadline })
  await expect(f.handler('environment-status', { experimentId: experimentIdSchema.parse(randomUUID()), operationId: request.operationId })).rejects.toThrow('allocation')
})
it('confirms environment failure evidence only for the bound plan and Session after process release', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  const request = prepareExperimentEnvironmentSchema.parse({ operationId: randomUUID(), environmentId: 'training', action: 'create', requirements: ['tiny-fixture==1'] })
  const evidenceContext = { sessionId: 'aspera-execution-' + id, planRevision: 1 }
  await f.handler('environment-prepare', { experimentId: id, ...request, evidenceContext })
  const savedRequest = JSON.parse(readFileSync(resolve(node.server.storagePlacement.runRoot, 'environment-requests-v1', request.operationId + '.json'), 'utf8'))
  expect(savedRequest.evidenceContext).toEqual(evidenceContext)
  await expect(f.handler('environment-prepare', { experimentId: id, ...request, evidenceContext: { ...evidenceContext, planRevision: 2 } })).rejects.toThrow('different plan or Session')
  const reference = { kind: 'environment-operation', id: request.operationId, serverId: node.server.id }
  const input = { experimentId: id, reference, evidenceContext }
  expect(await f.handler('storage-requirement-evidence', input)).toBeNull()
  await expect(f.handler('storage-requirement-evidence', { ...input, evidenceContext: { ...evidenceContext, planRevision: 2 } })).rejects.toThrow('another plan or Session')
  await expect(f.handler('storage-requirement-evidence', { ...input, evidenceContext: { ...evidenceContext, sessionId: 'foreign-session' } })).rejects.toThrow('another plan or Session')
  await expect(f.handler('storage-requirement-evidence', { ...input, reference: { ...reference, serverId: randomUUID() } })).rejects.toThrow('another node')
  const manager = new ManagedEnvironments(f.ctx)
  const binding = { experimentId: id, node, deploymentId: 'a'.repeat(64), controlRoot: f.config.root, hiddenPaths: [] }
  const folder = resolve(node.server.storagePlacement.runRoot, 'environment-operations-v1', request.operationId)
  mkdirSync(folder, { recursive: true })
  writeFileSync(resolve(folder, 'receipt.v1.json'), JSON.stringify({ ...manager.receipt(binding, request), state: 'blocked', exitConfirmed: true, exitCode: 1, detail: 'Historical distribution differs from its RECORD' }))
  expect(await f.handler('storage-requirement-evidence', input)).toBeNull()
  f.handles[0]!.settle(1)
  await vi.waitFor(async () => { expect(await f.handler('environment-status', { experimentId: id, operationId: request.operationId })).toMatchObject({ state: 'failed', admissionReleased: true }) })
  expect(await f.handler('storage-requirement-evidence', input)).toMatchObject({ experimentId: id, serverId: node.server.id,
    ...evidenceContext, reference, detail: expect.stringContaining('other repair choices are not disproved') })
})
it.each(['timeout', 'cancelled'] as const)('retains the original installer deadline and records %s separately from its actual exit', async reason => {
  const f = await fixture({ timeoutMs: reason === 'timeout' ? 1000 : 1800000, stopTimeoutMs: 2000 }); const id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  const request = prepareExperimentEnvironmentSchema.parse({ operationId: randomUUID(), environmentId: 'training', action: 'create' })
  await f.handler('environment-prepare', { experimentId: id, ...request })
  expect(f.spawn.mock.calls[0]![0].graceMs).toBe(2000)
  const manager = new ManagedEnvironments(f.ctx)
  const binding = { experimentId: id, node, deploymentId: 'a'.repeat(64), controlRoot: f.config.root, hiddenPaths: [] }
  const original = manager.runtime(binding, request.operationId)!
  const folder = resolve(node.server.storagePlacement.runRoot, 'environment-operations-v1', request.operationId); mkdirSync(folder, { recursive: true })
  writeFileSync(resolve(folder, 'receipt.v1.json'), JSON.stringify({ ...manager.receipt(binding, request), state: 'blocked', exitConfirmed: true, exitCode: 1, detail: 'Interrupted installer fixture' }))
  const release = reason === 'cancelled' ? f.handler('release', { experimentId: id }) : undefined
  await vi.waitFor(() => { expect(f.handles[0]!.terminate).toHaveBeenCalledOnce() }, { timeout: 5000 })
  expect(manager.runtime(binding, request.operationId)).toMatchObject({ stopReason: reason, deadline: original.deadline, exitConfirmed: false })
  f.handles[0]!.settle(1); if (release !== undefined) await release
  await vi.waitFor(async () => { expect(await f.handler('environment-status', { experimentId: id, operationId: request.operationId })).toMatchObject({ state: 'failed', runtime: { stopReason: reason, exitCode: 1, deadline: original.deadline }, admissionReleased: true }) })
  const saved = manager.runtime(binding, request.operationId)
  const reopened = await f.restart(true)
  expect(await reopened('environment-status', { experimentId: id, operationId: request.operationId })).toMatchObject({ state: 'failed', runtime: saved })
})
it('uses maintenance capacity checks for owned cleanup while retaining ordinary execution reserves', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  vi.mocked(verifyStorage).mockImplementationOnce(() => { throw new Error('Insufficient storage') })
  await expect(f.handler('run', { experimentId: id, commandId: 'train', command: 'true' })).rejects.toThrow('Insufficient storage')
  const receipt = JSON.parse(readFileSync(resolve(node.server.storagePlacement.runRoot, 'command-admissions-0.1.3/train.json'), 'utf8'))
  expect(receipt).toMatchObject({ experimentId: id, commandId: 'train', state: 'rejected', processState: 'not-started', requestHash: createHash('sha256').update('true').digest('hex') })
  await expect(f.handler('run', { experimentId: id, commandId: 'train', command: 'different content' })).rejects.toThrow('bound to different content')
  expect(f.spawn).not.toHaveBeenCalled()
  await f.handler('environment-cleanup', { experimentId: id, operationId: randomUUID(), nodes: [{ serverId: f.node.server.id, fingerprint: 'a'.repeat(64) }] })
  expect(verifyStorage).toHaveBeenLastCalledWith(node.server.storagePlacement, 0, true)
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('restores a released native adapter through node requests and protects the snapshot in the next command', async () => {
  const f = await fixture(), sourceId = experimentIdSchema.parse(randomUUID()), targetId = experimentIdSchema.parse(randomUUID())
  const savedNode = (id: typeof sourceId) => ({ ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' })
  const sourceNode = savedNode(sourceId)
  await f.handler('allocate', { experimentId: sourceId, deploymentId: 'a'.repeat(64), protocol: 4, node: sourceNode })
  const originalRun = serverRunRoot(sourceNode.server, sourceId), originalWorkspace = resolve(originalRun, 'workspace')
  writeFileSync(resolve(originalRun, '.aspera-owner.json'), JSON.stringify({ version: 1, experimentId: sourceId, serverId: f.node.server.id }))
  const folder = 'outputs/checkpoint-2', files = ['adapter_model.safetensors', 'adapter_config.json', 'trainer_state.json', 'optimizer.pt', 'scheduler.pt']
  mkdirSync(resolve(originalWorkspace, folder), { recursive: true })
  for (const name of files) writeFileSync(resolve(originalWorkspace, folder, name), name === 'trainer_state.json' ? '{"global_step":2}' : 'retained test bytes')
  const stage = stageRegistrationSchema.parse({ version: 1, experimentId: sourceId, serverId: f.node.server.id, sessionId: 'original', planRevision: 1,
    stageId: 'trained', attemptId: 'original', commandId: 'train', registeredAt: 1, historical: false,
    trainerState: folder + '/trainer_state.json', parameters: 'args.json', metrics: 'metrics.jsonl',
    requirement: { stageId: 'trained', title: 'Native adapter', planStep: 1, framework: 'transformers', startStep: 0, additionalSteps: 2, endStep: 2,
      metricScope: 'stage', loggingSteps: 1, scheduler: { mode: 'fresh', type: 'linear', learningRate: 0.0001, warmupSteps: 0, totalSteps: 2 }, requiredFiles: files.map(name => folder + '/' + name) } })
  const retained = new CheckpointProtection(originalRun, originalWorkspace, sourceId, f.node.server.id)
  await retained.register(stage)
  await retained.mounts('read-only-history', [{ commandId: 'train', state: 'completed', exitCode: 0, released: true }])
  expect(await f.handler('release', { experimentId: sourceId })).toEqual({ released: true })
  const wrapper = JSON.parse(readFileSync(resolve(f.storageRoot, 'aspera_node/allocations', sourceId + '.json'), 'utf8'))
  mkdirSync(resolve(f.storageRoot, 'aspera_node/commands'), { recursive: true })
  writeFileSync(resolve(f.storageRoot, 'aspera_node/commands', sourceId + '_train.json'), JSON.stringify({ ...wrapper,
    record: { experimentId: sourceId, commandId: 'train', command: 'original completed training', state: 'completed', exitCode: 0, released: true } }))
  const node = await f.restart(true), targetNode = savedNode(targetId)
  await node('allocate', { experimentId: targetId, deploymentId: 'a'.repeat(64), protocol: 4, node: targetNode })
  const targetRun = serverRunRoot(targetNode.server, targetId)
  writeFileSync(resolve(targetRun, '.aspera-owner.json'), JSON.stringify({ version: 1, experimentId: targetId, serverId: f.node.server.id }))
  const discovered = z.object({ candidates: z.array(inferenceCheckpointCandidateSchema) }).parse(await node('inference-checkpoints', { experimentId: targetId, sourceExperimentId: sourceId }))
  expect(discovered.candidates).toHaveLength(1)
  const request = { experimentId: targetId, sourceExperimentId: sourceId, checkpointId: discovered.candidates[0]!.checkpointId, operationId: randomUUID() }
  const prepared = z.object({ adapterPath: z.string(), snapshot: z.object({ state: z.literal('ready') }) }).parse(await node('inference-checkpoint-prepare', request))
  expect(await node('inference-checkpoint-prepare', request)).toMatchObject(prepared)
  await node('run', { experimentId: targetId, commandId: 'verify-snapshot', command: 'python verify.py' })
  const argv = f.spawn.mock.calls[0]![0].argv
  expect(argv.some((value, index) => value === '--ro-bind' && argv[index + 1] === prepared.adapterPath && argv[index + 2] === prepared.adapterPath)).toBe(true)
  expect(readFileSync(resolve(originalWorkspace, folder, 'adapter_model.safetensors'), 'utf8')).toBe('retained test bytes')
  f.handles[0]!.settle()
})
it('runs diagnostics with read-only mounts, bounded output and an independent lifetime', async () => {
  const f = await fixture(), id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  const input = { experimentId: id, commandId: 'diagnose', command: 'inspect current mount' }
  await f.handler('diagnostic', input)
  const argv = f.spawn.mock.calls[0]![0].argv
  expect(argv).toContain('--size'); expect(argv).not.toContain('--bind'); expect(argv).not.toContain('--dev-bind')
  f.handles[0]!.stdout.write('x'.repeat(4096))
  expect(f.handles[0]!.terminate).toHaveBeenCalled()
  f.handles[0]!.settle(143)
  await vi.waitFor(async () => { expect(await f.handler('command-status', { experimentId: id, commandId: 'diagnose' })).toMatchObject({ result: { released: true, purpose: 'diagnostic', detail: expect.stringContaining('log limit') } }) })
  await expect(f.handler('run', input)).rejects.toThrow('purpose')
  await f.handler('diagnostic', { ...input, commandId: 'timed' })
  await vi.waitFor(() => { expect(f.handles[1]!.terminate).toHaveBeenCalled() }, { timeout: 5000 })
  f.handles[1]!.settle(143)
  await vi.waitFor(async () => { expect(await f.handler('command-status', { experimentId: id, commandId: 'timed' })).toMatchObject({ result: { released: true, detail: expect.stringContaining('time limit') } }) })
})
it('does not certify a missing command when an original process identity is retained', async () => {
  const f = await fixture(), id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline: Date.now() - 1, node: f.node })
  const folder = resolve(f.config.root, 'runs', id, 'process-identities'); mkdirSync(folder, { recursive: true })
  writeFileSync(resolve(folder, 'probe.v1.json'), '{}')
  try { await f.handler('run', { experimentId: id, commandId: 'probe', command: 'true' }); expect.fail('expired command was accepted') }
  catch (error) { expect(error).not.toBeInstanceOf(CommandAdmissionRejected) }
  expect(f.spawn).not.toHaveBeenCalled()
})
it('keeps diagnostic workspace access when a saved environment grant cannot be verified', async () => {
  const f = await fixture(), id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  const folder = resolve(f.config.root, 'runs', id, 'environment-borrowings-v1'); mkdirSync(folder, { recursive: true })
  writeFileSync(resolve(folder, 'training.json'), '{}')
  const result = await f.handler('diagnostic', { experimentId: id, commandId: 'inspect-storage', command: 'df -h .' })
  expect(result).toMatchObject({ purpose: 'diagnostic', detail: expect.stringContaining('registered environment/material access is unavailable') })
  const argv = f.spawn.mock.calls[0]![0].argv
  expect(argv).not.toContain('--bind'); expect(argv).not.toContain('--dev-bind')
  f.handles[0]!.settle()
  await vi.waitFor(async () => { expect(await f.handler('command-status', { experimentId: id, commandId: 'inspect-storage' })).toMatchObject({ result: { released: true } }) })
})
it('rejects completion evidence naming an unregistered environment without launching an inspector', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4,
    node: { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
      gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' } })
  await expect(f.handler('environment-acceptance', { experimentId: id, environments: ['unmanaged-venv'] })).resolves.toMatchObject({ verified: false, detail: expect.stringContaining('not registered') })
  expect(f.spawn).not.toHaveBeenCalled()
})
it('keeps the same acceptance failure stable while retaining each diagnostic location', async () => {
  const f = await fixture(), id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  const read = vi.spyOn(ManagedEnvironments.prototype, 'governance')
    .mockRejectedValueOnce(new EnvironmentInspectionError('Environment inspection process-failed: source still occupied', 'diagnostics/first'))
    .mockRejectedValueOnce(new EnvironmentInspectionError('Environment inspection process-failed: source still occupied', 'diagnostics/second'))
  try {
    writeFileSync(resolve(node.server.storagePlacement.runRoot, 'storage-plan.v1.json'), JSON.stringify({ version: 1,
      experimentId: id, serverId: node.server.id, operationId: randomUUID(), requestHash: 'b'.repeat(64), checkedAt: 1,
      state: 'ready', environmentId: 'training', requirements: [], materialIds: [], volumes: [], detail: 'CPU fixture budget' }))
    const first = await f.handler('environment-acceptance', { experimentId: id })
    const second = await f.handler('environment-acceptance', { experimentId: id })
    expect(first).toMatchObject({ verified: false, detail: 'Error: Environment inspection process-failed: source still occupied', diagnostics: 'diagnostics/first' })
    expect(second).toMatchObject({ verified: false, detail: 'Error: Environment inspection process-failed: source still occupied', diagnostics: 'diagnostics/second' })
  } finally { read.mockRestore() }
})
it('keeps another operation fenced when an old cleanup requests recovery', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: placement(f.node.server.id, id, f.config.root) },
    gpuInfo: 'GPU 0 (UUID: GPU-11111111-1111-1111-1111-111111111111)' }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 4, node })
  const binding = { experimentId: id, node, deploymentId: 'a'.repeat(64), controlRoot: f.config.root, hiddenPaths: [] }
  const manager = new ManagedEnvironments(f.ctx); const operationId = randomUUID(); const fingerprint = 'a'.repeat(64)
  const command = manager.cleanupCommand(binding, operationId, fingerprint)
  await manager.recordLaunch(binding, operationId, 'prepared', undefined, command.commandId)
  const fence = resolve(f.config.root, 'state/environment-fences', id + '.json'); const otherId = randomUUID()
  mkdirSync(resolve(f.config.root, 'state/environment-fences'), { recursive: true })
  writeFileSync(fence, JSON.stringify({ version: 1, operationId: otherId }))
  const recovery = vi.spyOn(ManagedEnvironments.prototype, 'recoverCleanup')
  cleanup.push(async () => { recovery.mockRestore() })
  await expect(f.handler('environment-cleanup-status', { experimentId: id, operationId, nodes: [{ serverId: node.server.id, fingerprint }] })).rejects.toThrow('currently fenced')
  expect(recovery).not.toHaveBeenCalled(); expect(JSON.parse(readFileSync(fence, 'utf8')).operationId).toBe(otherId)
})
it.each([true, false])('serializes concurrent allocation and maintenance with maintenance first=%s', async maintenanceFirst => {
  const f = await fixture(); const status = z.object({ controller: controllerStatusSchema }).parse(await f.handler('health', {})).controller
  const owner = { operationId: randomUUID(), bootId: status.bootId, policyDigest: status.policyDigest }
  const allocation = { experimentId: randomUUID(), deploymentId: 'a'.repeat(64), protocol: 2, node: f.node }
  const operations = maintenanceFirst ? [['maintenance-begin', owner], ['allocate', allocation]] as const
    : [['allocate', allocation], ['maintenance-begin', owner]] as const
  const results = await Promise.allSettled(operations.map(([operation, body]) => f.handler(operation, body)))
  expect(results[0]!.status).toBe('fulfilled'); expect(results[1]!.status).toBe('rejected')
  expect(f.spawn).not.toHaveBeenCalled()
})
it('starts schema-valid run ids using the published per-record backend and isolates repeated ids across experiments', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse('2614d34b-7b4a-4d8c-9ac6-5fca6e369221')
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 2, node: f.node })
  const names = ['probe_env', 'probe-env', 'abc123', '1', 'SftSmoke01', randomUUID(), 'x'.repeat(80)]
  for (const commandId of names) {
    const request = { experimentId: id, commandId, command: 'fixture command' }
    await expect(f.handler('run', request)).resolves.toMatchObject({ commandId, state: 'running' })
    await expect(f.handler('run', request)).resolves.toMatchObject({ commandId })
    f.handles.at(-1)!.settle()
  }
  expect(f.spawn).toHaveBeenCalledTimes(names.length)
  for (const commandId of ['a/b', '..', 'x'.repeat(81)]) await expect(f.handler('run', { experimentId: id, commandId, command: 'fixture' })).rejects.toThrow()
  expect(f.spawn).toHaveBeenCalledTimes(names.length)
  await expect(f.handler('release', { experimentId: id })).resolves.toEqual({ released: true })
  const nextId = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: nextId, deploymentId: 'a'.repeat(64), protocol: 2, node: f.node })
  await expect(f.handler('run', { experimentId: nextId, commandId: 'probe_env', command: 'different experiment' })).resolves.toMatchObject({ commandId: 'probe_env' })
  const records = readdirSync(resolve(f.storageRoot, 'aspera_node/commands'))
  expect(records).toHaveLength(names.length + 1)
  expect(records.every(name => /^[a-zA-Z0-9_-]+\.json$/.test(name))).toBe(true)
  expect(records.map(name => JSON.parse(readFileSync(resolve(f.storageRoot, 'aspera_node/commands', name), 'utf8')).record.experimentId)
    .filter(experimentId => experimentId === nextId)).toHaveLength(1)
})
it('scopes command observations and verifies command contents before a group stop', async () => {
  const f = await fixture(), id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 2, node: f.node })
  await f.handler('run', { experimentId: id, commandId: 'member', command: 'group member' })
  await expect(f.handler('command-status', { experimentId: id, commandId: 'member' })).resolves.toMatchObject({ experimentId: id, serverId: f.node.server.id,
    requestHash: createHash('sha256').update('group member').digest('hex'), result: { commandId: 'member', state: 'running', released: false } })
  await expect(f.handler('command-status', { experimentId: randomUUID(), commandId: 'member' })).rejects.toThrow('absent')
  await expect(f.handler('stop-command', { experimentId: id, commandId: 'member', commandHash: 'a'.repeat(64) })).rejects.toThrow('contents differ')
  expect(f.handles[0]!.terminate).not.toHaveBeenCalled()
  f.handles[0]!.terminate.mockImplementation(() => { f.handles[0]!.settle(143) })
  await f.handler('stop-command', { experimentId: id, commandId: 'member', commandHash: createHash('sha256').update('group member').digest('hex') })
  expect(f.handles[0]!.terminate).toHaveBeenCalledOnce()
  await expect(f.handler('command-status', { experimentId: id, commandId: 'member' })).resolves.toMatchObject({ result: { released: true } })
})
it('deduplicates commands and keeps the node allocated until cancellation settles the managed range', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID()); const another = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  const command = { experimentId: id, commandId: 'training', command: 'python train.py' }
  await f.handler('run', command); await f.handler('run', command)
  expect(f.spawn).toHaveBeenCalledOnce()
  await expect(f.handler('run', { ...command, command: 'different' })).rejects.toThrow('different content')
  const stopping = f.handler('release', { experimentId: id })
  await vi.waitFor(() => { expect(f.handles[0]!.terminate).toHaveBeenCalledOnce() })
  await expect(f.handler('run', { ...command, commandId: 'late' })).rejects.toThrow('unavailable')
  await expect(f.handler('allocate', { experimentId: another, deploymentId: 'a'.repeat(64), budget, deadline,
    node: f.node })).rejects.toThrow('another experiment')
  f.handles[0]!.settle()
  expect(await stopping).toEqual({ released: true })
  expect(await f.handler('allocate', { experimentId: another, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })).toEqual({ allocated: true })
  expect(f.spawn.mock.calls[0]![0]).toMatchObject({ argv: expect.arrayContaining([f.node.backendPath, '--clearenv', '--dev-bind', '/dev/nvidia0', f.config.root]) })

})

it('separates command output streams and refuses a cursor for a different source', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  for (const commandId of ['train', 'evaluate']) await f.handler('run', { experimentId: id, commandId, command: 'python trial.py' })
  f.handles[0]!.stdout.write('step 1\n'); f.handles[0]!.stderr.write('warning\n'); f.handles[1]!.stdout.write('score\n')
  const processes = experimentProcessSchema.array().parse(await f.handler('processes', { experimentId: id }))
  expect(processes.map(row => row.commandId)).toEqual(['train', 'evaluate'])
  expect(processes[0]?.streams).toEqual(['stdout', 'stderr'])
  const request = { experimentId: id, serverId: f.node.server.id, commandId: 'train', stream: 'stdout' as const }
  const first = processLogPageSchema.parse(await f.handler('process-log', request))
  expect(Buffer.from(first.chunk.data, 'base64').toString()).toBe('step 1\n')
  const bounded = processLogPageSchema.parse(await f.handler('process-log', { ...request, limit: 3 }))
  expect(Buffer.from(bounded.chunk.data, 'base64').toString()).toBe('ste')
  expect(bounded.cursor.offset).toBe(3); expect(bounded.chunk.eof).toBe(false)
  f.handles[0]!.stdout.write('step 2\n')
  const next = processLogPageSchema.parse(await f.handler('process-log', { ...request, cursor: first.cursor }))
  expect(Buffer.from(next.chunk.data, 'base64').toString()).toBe('step 2\n')
  for (const patch of [{ stream: 'stderr' }, { commandId: 'evaluate' }, { serverId: randomUUID() }, { experimentId: randomUUID() }]) {
    await expect(f.handler('process-log', { ...request, ...patch, cursor: first.cursor })).rejects.toThrow(/another experiment/)
  }
  const file = resolve(f.config.root, 'runs', id, 'process-logs/train/stdout.log')
  renameSync(file, file + '.old'); writeFileSync(file, 'rotated\n')
  const rotated = processLogPageSchema.parse(await f.handler('process-log', { ...request, cursor: next.cursor }))
  expect(rotated.chunk.reset).toBe(true); expect(Buffer.from(rotated.chunk.data, 'base64').toString()).toBe('rotated\n')
  rmSync(file)
  expect(processLogPageSchema.parse(await f.handler('process-log', request)).missing).toBe(true)
})

it('runs beyond the released command limit without creating aggregate timers in v2', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), node: f.node, protocol: 2 })
  for (let index = 0; index < 105; index++) {
    await f.handler('run', { experimentId: id, commandId: `command-${index}`, command: 'python small_step.py' })
    f.handles.at(-1)!.settle()
  }
  expect(f.spawn).toHaveBeenCalledTimes(105)
  expect(f.handles.every(handle => handle.terminate.mock.calls.length === 0)).toBe(true)
  expect(f.spawn.mock.calls.every(([spec]) => spec.argv[0] === '/usr/bin/bwrap' && spec.argv.includes('--dev-bind'))).toBe(true)
})

it('binds v3 storage to its node, experiment and release and confines caches to the saved workspace', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const storage = placement(f.node.server.id, id, f.config.root)
  const node = { ...f.node, server: { ...f.node.server, storagePlacement: storage } }
  const request = { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 3, node }
  await expect(f.handler('allocate', { ...request, experimentId: randomUUID() })).rejects.toThrow('another node, experiment or release')
  await expect(f.handler('allocate', { ...request, deploymentId: 'b'.repeat(64) })).rejects.toThrow('another node, experiment or release')
  await f.handler('allocate', request)
  const registry = resolve(f.config.root, 'state/storage-roots/another-root')
  mkdirSync(registry, { recursive: true })
  writeFileSync(resolve(registry, '.aspera-owner.json'), JSON.stringify({ namespaceRoot: '/other-owned-storage' }))
  await f.handler('run', { experimentId: id, commandId: 'storage', command: 'python train.py' })
  expect(verifyStorage).toHaveBeenCalledWith(storage)
  const argv = f.spawn.mock.calls[0]![0].argv
  expect(argv.join('\n')).toContain('--tmpfs\n' + f.config.root)
  expect(argv.join('\n')).toContain('--tmpfs\n/other-owned-storage')
  expect(argv.slice(argv.indexOf('--bind'), argv.indexOf('--bind') + 3)).toEqual(['--bind', resolve(storage.workspaceRoot), resolve(storage.workspaceRoot)])
  expect(argv.join('\n')).toContain('HF_HOME\n' + posix.join(resolve(storage.workspaceRoot), 'cache/huggingface'))
  expect(argv.join('\n')).toContain('UV_PROJECT_ENVIRONMENT\n' + posix.join(resolve(storage.workspaceRoot), 'env'))
  for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--new-session', '--clearenv']) expect(argv).toContain(flag)
})

it('refuses an allocation that omits the policy discriminator as well as the legacy limits', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await expect(f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), node: f.node })).rejects.toThrow('policy is incomplete')
  await expect(f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), node: f.node, protocol: 2, budget, deadline })).rejects.toThrow('policy is incomplete')
  expect(f.spawn).not.toHaveBeenCalled()
})
it('holds ambiguous allocations after node restart and never launches a retry', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const allocation = { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node }
  await f.handler('allocate', allocation)
  await f.handler('run', { experimentId: id, commandId: 'training', command: 'python train.py' })
  const restarted = await f.restart()
  await expect(restarted('allocate', allocation)).rejects.toThrow('interrupted')
  expect(await restarted('release', { experimentId: id })).toMatchObject({ released: false })
  expect(f.spawn).toHaveBeenCalledOnce()
})
it('releases a restarted allocation only when every recorded process was already confirmed drained', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  await f.handler('run', { experimentId: id, commandId: 'smoke', command: 'python smoke.py' })
  f.handles[0]!.settle()
  await vi.waitFor(async () => { expect(await f.handler('status', { experimentId: id })).toMatchObject([{ released: true }]) })
  const restarted = await f.restart(true)
  expect(await restarted('release', { experimentId: id })).toEqual({ released: true })
  expect(f.spawn).toHaveBeenCalledOnce()
})
it('refuses excess GPU grants and verifies staged input content before execution', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await expect(f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: { ...f.node,
    devicePaths: ['/dev/nvidia1'] } })).rejects.toThrow('granted GPU')
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  const input = { experimentId: id, path: 'inputs/data.txt', offset: 0, data: Buffer.from('abc').toString('base64') }
  expect(await f.handler('input', input)).toEqual({ nextOffset: 3 })
  await expect(f.handler('input', { ...input, data: Buffer.from('xyz').toString('base64') })).rejects.toThrow('different bytes')
  await expect(f.handler('verify-input', { experimentId: id, name: 'data.txt', sha256: 'b'.repeat(64) })).rejects.toThrow('digest mismatch')
  const sha256 = createHash('sha256').update('abc').digest('hex')
  expect(await f.handler('verify-input', { experimentId: id, name: 'data.txt', sha256 })).toEqual({ verified: true })
  const verified = resolve(serverRunRoot(f.node.server, id), 'input-verifications-v1', createHash('sha256').update('data.txt').digest('hex') + '.json')
  expect(JSON.parse(readFileSync(verified, 'utf8'))).toMatchObject({ version: 1, experimentId: id, name: 'data.txt', sha256 })
})

it('retains a process handle after incomplete cleanup and confirms it on a later cancellation', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  await f.handler('run', { experimentId: id, commandId: 'smoke', command: 'python smoke.py' })
  f.handles[0]!.waitForExit.mockResolvedValue(false)
  f.handles[0]!.settle()
  await vi.waitFor(async () => { expect(await f.handler('status', { experimentId: id })).toMatchObject([{ state: 'failed', released: false }]) })
  expect(await f.handler('release', { experimentId: id })).toEqual({ released: false })
  f.handles[0]!.waitForExit.mockResolvedValue(true)
  expect(await f.handler('release', { experimentId: id })).toEqual({ released: true })
  expect(f.handles[0]!.terminate).toHaveBeenCalledTimes(2)
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('deduplicates service launches and ignores an old health reply after confirmed stop', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  const request = { experimentId: id, id: randomUUID(), command: 'python serve.py', modelPath: 'model', port: await loopbackPort(), healthPath: '/health' }
  await Promise.all([f.handler('register-service', request), f.handler('register-service', request)])
  expect(f.spawn).toHaveBeenCalledOnce()
  const reply = Promise.withResolvers<Response>()
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(reply.promise)
  try {
    const checking = f.handler('services', { experimentId: id })
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce() })
    const stopping = f.handler('stop-service', { experimentId: id, serviceId: request.id })
    await vi.waitFor(() => { expect(f.handles[0]!.terminate).toHaveBeenCalledOnce() })
    f.handles[0]!.settle()
    expect(await stopping).toMatchObject({ state: 'stopped', released: true })
    reply.resolve(new Response('healthy'))
    expect(await checking).toMatchObject([{ state: 'stopped', released: true }])
    await f.handler('register-service', request)
    expect(f.spawn).toHaveBeenCalledOnce()
    await expect(f.handler('register-service', { ...request, command: 'different' })).rejects.toThrow('different content')
    await expect(f.handler('stop-service', { experimentId: randomUUID(), serviceId: request.id })).rejects.toThrow('outside this experiment')
    expect(await f.handler('stop-service', { experimentId: id, serviceId: request.id })).toMatchObject({ state: 'stopped', released: true })
    expect(f.handles[0]!.terminate).toHaveBeenCalledOnce()
    expect(await f.handler('register-service', { ...request, id: randomUUID(), command: 'python repaired-serve.py' })).toMatchObject({ state: 'starting', released: false })
    expect(f.spawn).toHaveBeenCalledTimes(2)
  } finally { reply.resolve(new Response()); fetchMock.mockRestore() }
})

it('publishes only a saved mapping, returns credentials only on explicit access, and closes public access before cancellation settles', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const publicPort = await loopbackPort()
  const modelPort = await loopbackPort()
  const mapping = { url: `http://127.0.0.1:${publicPort}`, port: publicPort }
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), protocol: 2,
    node: { ...f.node, server: { ...f.node.server, inferenceMapping: mapping } } })
  const request = { experimentId: id, id: randomUUID(), command: 'python serve.py', modelPath: 'model', port: modelPort, healthPath: '/health', publish: true }
  await expect(f.handler('register-service', { ...request, external: { ...mapping, state: 'reachable' } })).rejects.toThrow()
  await expect(f.handler('register-service', { ...request, port: publicPort })).rejects.toThrow('must differ')
  const registered = await f.handler('register-service', request)
  expect(registered).toMatchObject({ external: { ...mapping, state: 'unchecked' } })
  const backend = createHttpServer((_req, res) => { res.end('ok') })
  await new Promise<void>((done, reject) => { backend.once('error', reject); backend.listen(modelPort, '127.0.0.1', done) })
  cleanup.push(() => new Promise<void>(done => { backend.closeAllConnections(); backend.close(() => { done() }) }))
  const access = await f.handler('service-access-info', { experimentId: id, serviceId: request.id })
  expect(access).toMatchObject({ url: mapping.url, token: expect.any(String) })
  expect(await f.handler('services', { experimentId: id })).toMatchObject([{ state: 'healthy', external: { state: 'reachable' } }])
  expect(JSON.stringify(registered)).not.toContain('token')
  expect((await fetch(mapping.url)).status).toBe(401)
  const stopping = f.handler('stop-service', { experimentId: id, serviceId: request.id })
  await vi.waitFor(() => { expect(f.handles[0]!.terminate).toHaveBeenCalledOnce() })
  await expect(fetch(mapping.url)).rejects.toThrow()
  await expect(f.handler('service-access-info', { experimentId: id, serviceId: request.id })).rejects.toThrow('not active')
  f.handles[0]!.settle()
  expect(await stopping).toMatchObject({ state: 'stopped', released: true, external: { state: 'stopped' } })
})

it('holds an unverified service after node restart and never restarts its command', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  const request = { experimentId: id, id: randomUUID(), command: 'python serve.py', modelPath: 'model', port: await loopbackPort(), healthPath: '/health' }
  await f.handler('register-service', request)
  const restarted = await f.restart()
  expect(await restarted('services', { experimentId: id })).toMatchObject([{ state: 'interrupted', released: false }])
  expect(await restarted('release', { experimentId: id })).toEqual(expect.objectContaining({ released: false }))
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('refuses an occupied loopback port before launching or accepting another process health', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  await expect(f.handler('register-service', { experimentId: id, id: randomUUID(), command: 'python serve.py', modelPath: 'model',
    port: await loopbackPort(true), healthPath: '/health' })).rejects.toThrow('already occupied')
  expect(f.spawn).not.toHaveBeenCalled()
})

it('rejects backend changes, exhausted command budgets and expired runtime grants before launching', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await expect(f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline,
    node: { ...f.node, backendPath: '/tmp/allow-everything' } })).rejects.toThrow('node policy')
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget: { ...budget, maxCommands: 1 }, deadline, node: f.node })
  await f.handler('run', { experimentId: id, commandId: 'first', command: 'python smoke.py' })
  await expect(f.handler('run', { experimentId: id, commandId: 'second', command: 'python train.py' })).rejects.toThrow('budget exhausted')
  f.handles[0]!.settle()
  await vi.waitFor(async () => { expect(await f.handler('release', { experimentId: id })).toEqual({ released: true }) })
  const expired = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: expired, deploymentId: 'a'.repeat(64), budget, deadline: Date.now() - 1, node: f.node })
  await expect(f.handler('run', { experimentId: expired, commandId: 'late', command: 'python train.py' })).rejects.toThrow('budget expired')
  expect(f.spawn).toHaveBeenCalledOnce()
})
