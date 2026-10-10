/** Real preparation providers use explicit simulated SSH replies and isolated repair receipts. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import { controllerBootIdSchema, experimentIdSchema, serverIdSchema, parseGpuInventory, normalizedSet } from '@aspera/experiments'
import { controllerPolicyDigest } from '@aspera/runtime'
import type { FleetDriver } from '../src/fleet.ts'
import type { DeploymentConfig } from '../src/deploy.ts'
import { ControllerDiagnostic, verifyController, ensureClusterRole, inspectController, SavedReleaseUnavailable } from '../src/cluster-deploy.ts'
import { ControllerRepair } from '../src/controller-repair.ts'
import { controllerFixture, preparedFixture, fixtureGpu } from './controller-fixture.ts'
import { placement } from '../../experiments/tests/fixtures.ts'
import { request, remote } from '../src/transport.ts'
vi.mock('../src/transport.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/transport.ts')>(), request: vi.fn(), remote: vi.fn() }))
const roots: string[] = []; const originalHome = process.env.DSH_HOME
afterEach(() => { vi.resetAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome })
const target: DeploymentConfig = { host: 'cpu-only.invalid', sshPort: 22, remotePort: 43019, remoteRoot: '/runs', localRepo: '/sealed',
  dataRoots: [], agentCredentialRefs: [], tokenRef: 'private-ref', toolTimeoutMs: 1000, controlPollIntervalMs: 100 }
function fixture(maxAttempts = 2) {
  mkdirSync(resolve('.artifacts'), { recursive: true }); const root = mkdtempSync(resolve('.artifacts', 'controller-repair-')); roots.push(root); process.env.DSH_HOME = root
  let status = controllerFixture(target); const prepared = preparedFixture()
  status.policy = { ...status.policy, devicePaths: ['/dev/nvidia2'] }; status.policyDigest = controllerPolicyDigest(status.policy)
  const pending: string[] = []; let stopped = false
  const inspectController = vi.fn(async () => structuredClone(status))
  const ensure = vi.fn(async () => { status = { ...controllerFixture(target), bootId: controllerBootIdSchema.parse('cpu-replacement') } })
  const run = vi.fn(async (_target, script: string) => {
    if (script.includes('pidfd_send_signal')) { stopped = true; return '' }
    if (script.includes('stopped.json')) return stopped ? JSON.stringify({ operationId: status.maintenance, exited: true }) : '{}'
    return '0'
  })
  const request = vi.fn(async (_target, _token, _route, _method, body): Promise<Awaited<ReturnType<FleetDriver['request']>>> => {
    status.maintenance = body.operationId
    return { status: 200, value: { maintenance: body.operationId, bootId: status.bootId, policyDigest: status.policyDigest } }
  })
  const driver = fromAny<FleetDriver, object>({ inspectController, prepareClusterServer: vi.fn(async () => prepared), ensureClusterRole: ensure, remote: run, request })
  const input = { experimentId: experimentIdSchema.parse(randomUUID()), serverId: serverIdSchema.parse(randomUUID()), role: 'node' as const,
    target, prepared, token: 'private-control-token', password: 'private-password', maxAttempts }
  const repair = new ControllerRepair(input, driver)
  return { repair, driver, inspectController, ensure, run, request, pending, input,
    runRepair: () => repair.repair(AbortSignal.timeout(1000), async directory => { pending.push(directory) }),
    get status() { return status }, set status(value) { status = value } }
}

it('rejects a healthy control process with the old nvidia2 grant before its reuse', async () => {
  const status = controllerFixture(target); status.policy.devicePaths = ['/dev/nvidia2']; status.policyDigest = controllerPolicyDigest(status.policy)
  const prepared = preparedFixture(); const current = structuredClone(prepared.gpu)
  current.gpus[0]!.uuid = 'GPU-22222222-2222-2222-2222-222222222222'; current.gpus[0]!.devicePath = '/dev/nvidia5'; current.devicePaths = ['/dev/nvidia5']
  status.actualGpu = current
  vi.mocked(request).mockResolvedValue({ status: 200, value: { protocol: 4, role: 'node', deploymentId: status.deploymentId, features: ['public-inference-v1'], controller: status } })
  await expect(ensureClusterRole(target, { ...prepared, devicePaths: current.devicePaths, gpu: current }, 'node', 'private-token', undefined, AbortSignal.timeout(1000))).rejects.toMatchObject({
    diagnostic: { code: 'configuration-outdated', expected: { devicePaths: ['/dev/nvidia5'] }, controller: { policy: { devicePaths: ['/dev/nvidia2'] } } },
  })
  expect(remote).not.toHaveBeenCalled()
})
it('accepts reordered authorization but distinguishes UUID, device mapping and access changes', () => {
  const prepared = preparedFixture(); prepared.gpu.devicePaths.push('/dev/nvidiactl'); const status = controllerFixture(target)
  status.policy.gpu = structuredClone(prepared.gpu); status.actualGpu = structuredClone(prepared.gpu)
  status.policy.gpu.devicePaths.reverse(); status.actualGpu.devicePaths.reverse()
  expect(verifyController(status, target, prepared, 'node')).toBe(status)
  status.actualGpu.gpus[0]!.uuid = 'GPU-22222222-2222-2222-2222-222222222222'
  expect(() => verifyController(status, target, prepared, 'node')).toThrow('hardware-changed')
  status.actualGpu = undefined; status.gpuError = 'CUDA device permission denied'
  expect(() => verifyController(status, target, prepared, 'node')).toThrow('unavailable')
})
it('maps NVIDIA UUIDs to accessible minor numbers and refuses missing identities', () => {
  expect(parseGpuInventory(`${fixtureGpu.gpus[0]!.uuid}, NVIDIA RTX 4090, 5`, ['/dev/nvidia5', '/dev/nvidiactl']).gpus[0]?.devicePath).toBe('/dev/nvidia5')
  expect(() => parseGpuInventory('unknown, RTX 4090, 5', ['/dev/nvidia5'])).toThrow()
  expect(() => parseGpuInventory(`${fixtureGpu.gpus[0]!.uuid}, RTX 4090, 5`, ['/dev/nvidia2'])).toThrow()
  expect(normalizedSet(['/dev/nvidia2', '/dev/nvidia2'])).toEqual(['/dev/nvidia2'])
  expect(() => parseGpuInventory(`${fixtureGpu.gpus[0]!.uuid}, First, 5\nGPU-22222222-2222-2222-2222-222222222222, Second, 5`, ['/dev/nvidia5'])).toThrow('does not match')
  expect(() => parseGpuInventory(`${fixtureGpu.gpus[0]!.uuid}, First, 5`, ['/dev/nvidia5', '/dev/nvidia-caps/../../token'])).toThrow()
})
it('distinguishes unchanged UUIDs with a different device path and missing auxiliary devices', () => {
  const status = controllerFixture(target); const prepared = preparedFixture()
  status.actualGpu!.gpus[0]!.devicePath = '/dev/nvidia5'; status.actualGpu!.devicePaths = ['/dev/nvidia5']
  expect(() => verifyController(status, target, prepared, 'node')).toThrow('hardware-changed')
  status.actualGpu = structuredClone(prepared.gpu)
  prepared.gpu.devicePaths.push('/dev/nvidiactl'); status.policy.gpu = structuredClone(prepared.gpu)
  expect(() => verifyController(status, target, prepared, 'node')).toThrow('hardware-changed')
})
it('records ownership, fences admission and restarts only the identity-matched idle process', async () => {
  const f = fixture(); const result = await f.runRepair()
  expect(result).toMatchObject({ repaired: true, verificationRequired: true })
  expect(f.pending).toHaveLength(1); expect(f.request).toHaveBeenCalledOnce(); expect(f.ensure).toHaveBeenCalledOnce()
  expect(f.run.mock.calls.some(([, script]) => script.includes('pidfd_send_signal') && script.includes('expected_start'))).toBe(true)
  expect(JSON.stringify(result)).not.toContain(f.input.password); expect(JSON.stringify(result)).not.toContain(f.input.token)
  await expect(f.runRepair()).resolves.toMatchObject({ repaired: false, ready: true })
  expect(f.ensure).toHaveBeenCalledOnce()
})
it.each(['experiments', 'allocations', 'commands', 'services'] as const)('does not begin maintenance with unconfirmed %s', async kind => {
  const f = fixture(); f.status.occupied[kind].push('owned-resource')
  await expect(f.runRepair()).rejects.toBeInstanceOf(ControllerDiagnostic)
  expect(f.pending).toEqual([]); expect(f.request).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled()
})
it('holds an ambiguous stop across recovery and never launches or kills twice', async () => {
  const f = fixture(); f.run.mockImplementation(async (_target, script: string) => { if (script.includes('pidfd_send_signal')) throw new Error('SSH cancelled before exit receipt'); return '{}' })
  await expect(f.runRepair()).rejects.toThrow('SSH cancelled')
  const resumed = new ControllerRepair(f.input, f.driver)
  await expect(resumed.reconcile(f.pending[0]!, AbortSignal.timeout(1000))).rejects.toThrow('unconfirmed')
  expect(f.ensure).not.toHaveBeenCalled(); expect(f.run.mock.calls.filter(([, script]) => script.includes('pidfd_send_signal'))).toHaveLength(1)
})
it('refuses the configured attempt limit and stale handover acceptance', async () => {
  const f = fixture(0); await expect(f.runRepair()).rejects.toThrow('attempt limit'); expect(f.request).not.toHaveBeenCalled()
  f.status = controllerFixture(target); await f.repair.verify(AbortSignal.timeout(1000)); f.status.bootId = controllerBootIdSchema.parse('another-controller')
  await expect(f.repair.verifyAcceptance(AbortSignal.timeout(1000))).rejects.toThrow('changed after acceptance')
})
it('saves accepted process identity without counting a restart', async () => {
  const f = fixture(); f.status = controllerFixture(target)
  const accepted = await f.repair.verify(AbortSignal.timeout(1000))
  expect(accepted.controller?.bootId).toBe(f.status.bootId)
  const journal = JSON.parse(readFileSync(resolve(process.env.DSH_HOME!, 'aspera-controller-repairs', f.input.experimentId, `${f.input.serverId}-node.v1.json`), 'utf8'))
  expect(journal.attempts).toEqual([]); expect(journal.acceptance.controller.policyDigest).toBe(f.status.policyDigest)
  expect(JSON.stringify(journal)).not.toContain(f.input.password)
})
it('puts remote stop receipts in separately selected experiment storage for owned cleanup', async () => {
  const f = fixture(); const assigned = placement(f.input.serverId, f.input.experimentId, '/runs')
  const runRoot = `/data/.aspera/${f.input.serverId}/runs/${f.input.experimentId}`
  const repair = new ControllerRepair({ ...f.input, target: { ...f.input.target, storagePlacement: {
    ...assigned, layout: 'separated', namespaceRoot: `/data/.aspera/${f.input.serverId}`, runRoot, workspaceRoot: runRoot + '/workspace',
  } } }, f.driver)
  await repair.repair(AbortSignal.timeout(1000), async directory => { f.pending.push(directory) })
  expect(f.pending[0]).toMatch(new RegExp('^' + runRoot + '/controller-repairs/node/'))
  expect(f.run.mock.calls.some(([, script]) => script.includes(runRoot + '/controller-repairs/node/') && script.includes('stopped.json'))).toBe(true)
})
it('retains the two-attempt policy across recovery without restarting a refused operation', async () => {
  const f = fixture(); f.request.mockResolvedValue({ status: 400, value: { error: 'New work occupied the controller' } })
  await expect(f.runRepair()).rejects.toThrow('refused maintenance')
  await expect(f.runRepair()).rejects.toThrow('refused maintenance')
  const resumed = new ControllerRepair({ ...f.input, maxAttempts: 10 }, f.driver)
  await expect(resumed.repair(AbortSignal.timeout(1000), async () => {})).rejects.toThrow('attempt limit')
  expect(f.pending).toHaveLength(2); expect(f.request).toHaveBeenCalledTimes(2); expect(f.ensure).not.toHaveBeenCalled()
})
it('refuses automatic maintenance when a readiness-capable controller lacks the maintenance capability', async () => {
  vi.mocked(request).mockResolvedValue({ status: 200, value: { controller: controllerFixture(target), features: ['controller-readiness-v1'] } })
  expect((await inspectController(target, 'node', 'private-token', undefined, AbortSignal.timeout(1000))).legacy).toBe(true)
  expect(remote).not.toHaveBeenCalled()
  const f = fixture(); f.status.legacy = true
  await expect(f.runRepair()).rejects.toThrow('no safe maintenance')
  expect(f.request).not.toHaveBeenCalled(); expect(f.ensure).not.toHaveBeenCalled()
})
it('keeps the original release when its saved material is unavailable', async () => {
  const f = fixture(); vi.mocked(f.driver.prepareClusterServer).mockRejectedValue(new SavedReleaseUnavailable('copy this experiment'))
  await expect(f.runRepair()).rejects.toThrow('copy this experiment')
  expect(f.request).not.toHaveBeenCalled(); expect(f.run).not.toHaveBeenCalled()
})
it('recovers a confirmed stop without repeating the stop or resetting the attempt', async () => {
  const f = fixture(); f.ensure.mockRejectedValueOnce(new Error('SSH lost during startup'))
  await expect(f.runRepair()).rejects.toThrow('SSH lost')
  f.inspectController.mockRejectedValueOnce(new Error('control port is closed'))
  f.run.mockImplementation(async (_target, script: string) => script.includes('/exited') ? 'unknown' : JSON.stringify({ operationId: f.status.maintenance, exited: true }))
  const resumed = new ControllerRepair(f.input, f.driver)
  await resumed.reconcile(f.pending[0]!, AbortSignal.timeout(1000))
  expect(f.ensure).toHaveBeenCalledTimes(2)
  expect(f.run.mock.calls.filter(([, script]) => script.includes('pidfd_send_signal'))).toHaveLength(1)
})
it('only reads whitelisted startup settings from a legacy controller and refuses unknown GPU identity', async () => {
  vi.mocked(request).mockResolvedValue({ status: 200, value: { protocol: 4, role: 'node', features: ['public-inference-v1'] } })
  vi.mocked(remote).mockResolvedValue(JSON.stringify({ running: true, pid: 1000, processStart: '123', hostBootId: 'legacy-host',
    devices: ['/dev/nvidia0'], query: `${fixtureGpu.gpus[0]!.uuid}, CPU fixture GPU, 0`, configuration: {
      DSH_EXPERIMENT_ROLE: 'node', DSH_CLUSTER_ROOT: '/runs', DSH_EXPERIMENT_DEPLOYMENT_ID: 'a'.repeat(64),
      DSH_EXPERIMENT_DEVICES: '/dev/nvidia0', DSH_EXPERIMENT_BWRAP: '/usr/bin/bwrap', DSH_EXPERIMENT_HIDDEN_PATHS_JSON: '[]', DSH_EXPERIMENT_GPU_SNAPSHOT: JSON.stringify(fixtureGpu),
    } }))
  const status = await inspectController(target, 'node', 'private-token', undefined, AbortSignal.timeout(1000))
  expect(status.legacy).toBe(true); expect(verifyController(status, target, preparedFixture(), 'node')).toBe(status)
  expect(vi.mocked(remote).mock.calls[0]?.[1]).not.toContain('kill(')
  vi.mocked(remote).mockResolvedValue('{}')
  await expect(inspectController(target, 'node', 'private-token', undefined, AbortSignal.timeout(1000))).rejects.toMatchObject({ diagnostic: { code: 'unknown' } })
})
