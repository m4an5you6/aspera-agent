/** A node owns one experiment allocation and confined process ranges independently of SSH connections. */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, readdirSync, readFileSync, unlinkSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { createServer, connect } from 'node:net'
import type { AddressInfo, Server } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { budgetSchema, clusterCommandResultSchema, clusterCommandSchema, clusterNodeSchema, legacyClusterNodeSchema, deploymentIdSchema, experimentIdSchema, serviceSchema, serviceIdSchema } from '@aspera/experiments'
import type { ClusterCommandResult, ClusterNode, ExperimentId, InferenceService } from '@aspera/experiments'
import { clusterFiles, clusterPath, readClusterChunk } from '@aspera/experiments'
import { clusterFileHash } from './cluster-runtime.ts'
import { serverRunRoot } from './storage.ts'
import { experimentSandboxArgv } from './experiment-sandbox.ts'
import { ownedCommandArgv } from './owned-command.ts'
import { inspectCompletionFile } from '../scripts/completion-files.mjs'
import { verifyStorage } from '../scripts/storage.mjs'
import { NetworkProbes } from './network-probes.ts'
import { openInferenceGateway } from './inference-gateway.ts'
import type { InferenceGateway } from './inference-gateway.ts'
import { processLogRequestSchema } from '@aspera/experiments'
import { controllerBootIdSchema, controllerMaintenanceSchema, gpuIdentities, normalizedSet, normalizedGpuInventory } from '@aspera/experiments'
import type { ControllerStatus, ControllerRepairId, GpuInventory } from '@aspera/experiments'
import { probeControllerGpu, controllerPolicyDigest, controllerProcessIdentity } from './controller.ts'
import { ManagedEnvironments, managedEnvironmentMounts } from './managed-environment.ts'
import type { ManagedEnvironmentPolicy, ManagedEnvironmentBinding } from './managed-environment.ts'
import { prepareExperimentEnvironmentSchema, experimentCacheCleanupSchema, environmentOperationIdSchema } from '@aspera/experiments'
import type { EnvironmentOperationStatus, EnvironmentRuntime } from '@aspera/experiments'
import { assessExperimentStorageSchema, inspectExperimentMaterialsSchema, prepareExperimentMaterialsSchema, storageOperationIdSchema, experimentStoragePlanSchema } from '@aspera/experiments'
import { assertStorageSourceAvailable, materialReadonlyPaths } from './storage-governance.ts'
import { finalizationPolicySchema } from './finalization-policy.ts'
import type { FinalizationPolicy } from './finalization-policy.ts'

const allocationObject = z.object({ experimentId: experimentIdSchema, deploymentId: deploymentIdSchema,
  node: z.union([clusterNodeSchema, legacyClusterNodeSchema]).transform((node): ClusterNode => node), protocol: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(), budget: budgetSchema.optional(), deadline: z.number().int().optional(), released: z.boolean(), releasing: z.boolean().default(false), bootId: z.string() }).strict()
const allocationPolicy = (value: Pick<z.infer<typeof allocationObject>, 'protocol' | 'budget' | 'deadline'>) =>
  value.protocol === 2 || value.protocol === 3 || value.protocol === 4 ? value.budget === undefined && value.deadline === undefined : value.budget !== undefined && value.deadline !== undefined
const allocationSchema = allocationObject.refine(allocationPolicy, 'allocation execution policy is incomplete')
const allocationRequestSchema = allocationObject.omit({ released: true, releasing: true, bootId: true }).refine(allocationPolicy, 'allocation execution policy is incomplete')
const commandSchema = clusterCommandResultSchema.extend({ experimentId: experimentIdSchema, command: z.string() })
function commandView(row: z.infer<typeof commandSchema>): ClusterCommandResult {
  return { commandId: row.commandId, state: row.state, exitCode: row.exitCode, released: row.released,
    ...(row.detail === undefined ? {} : { detail: row.detail }) }
}
/** A UUID prefix scopes the validated command id to one path-safe record filename. */
function commandKey(id: ExperimentId, commandId: string): string {
  return `${id}_${commandId}`
}
const storeSpec = defineDomain({ name: 'aspera_node', version: 4, compatibleVersions: [1, 2, 3], layout: 'per-record', tables: {
  allocations: domainTable<ExperimentId, z.infer<typeof allocationSchema>>(allocationSchema),
  commands: domainTable<string, z.infer<typeof commandSchema>>(commandSchema),
  services: domainTable<string, InferenceService>(serviceSchema),
} })

import { observationPolicySchema, observationReadSchema, observationSourceIdSchema, metricReadSchema } from '@aspera/experiments'
import type { ObservationPolicy } from '@aspera/experiments'
import { ObservationWriter, observationSources, readObservation } from './observations.ts'
import { NodeMetricSampler, saveMetricSample, readMetricSamples } from './metrics.ts'

/** Configured bounds for a node control process. */
export interface ClusterNodeConfig {
  root: string
  bootId: string
  deploymentId: string
  gpuSnapshot?: GpuInventory
  backendPath: string
  hiddenPaths: string[]
  chunkBytes: number
  fileLimit: number
  cleanupTimeoutMs: number
  serviceRequestTimeoutMs: number
  serviceRequestBytes: number
  devicePaths: readonly string[]
  networkProbeLifetimeMs?: number
  observations?: ObservationPolicy
  managedEnvironments?: ManagedEnvironmentPolicy
  finalization?: FinalizationPolicy
}

/**
 * Own durable node allocations and confined managed processes.
 * @param ctx - confined subprocess provider.
 * @param config - node-owned paths and limits.
 * @returns effect-owned node request handler.
 */
export async function createClusterNode(ctx: Context, config: ClusterNodeConfig): Promise<(operation: string,
  raw: unknown) => Promise<unknown>> {
  const store = await ctx.storage.domain.open(storeSpec)
  const allocations = store.table('allocations')
  const commands = store.table('commands')
  const services = store.table('services')
  const environments = new ManagedEnvironments(ctx, config.managedEnvironments)
  let maintenance: ControllerRepairId | undefined
  const policy: ControllerStatus['policy'] = { backendPath: config.backendPath, hiddenPaths: normalizedSet(config.hiddenPaths),
    devicePaths: normalizedSet(config.devicePaths), ...(config.gpuSnapshot === undefined ? {} : { gpu: config.gpuSnapshot }) }
  const policyDigest = controllerPolicyDigest(policy)
  const occupied = (): ControllerStatus['occupied'] => ({ experiments: [],
    allocations: [...allocations.entries()].filter(([, row]) => !row.released).map(([id]) => id),
    commands: [...commands.entries()].filter(([, row]) => !row.released).map(([id]) => id),
    services: [...services.entries()].filter(([, row]) => !row.released).map(([id]) => id) })
  const observationPolicy = observationPolicySchema.parse(config.observations)
  const gateways = new Map<string, InferenceGateway>()
  const stopGateway = async (id: string) => {
    const gateway = gateways.get(id)
    if (gateway !== undefined) { await gateway.close(); gateways.delete(id) }
  }
  const stoppedExposure = (service: InferenceService) => service.external === undefined ? {} : {
    external: { ...service.external, state: 'stopped' as const, checkedAt: Date.now(), detail: undefined },
  }
  const handles = new Map<string, SubprocessHandle>()
  const settlements = new Map<string, Promise<void>>()
  let chain: Promise<void> = Promise.resolve()
  let closing = false
  const netServers = new Map<ExperimentId, Server>()
  const network = new NetworkProbes(config.networkProbeLifetimeMs ?? config.cleanupTimeoutMs, config.cleanupTimeoutMs)
  const deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  const environmentFence = (id: ExperimentId) => resolve(config.root, 'state/environment-fences', id + '.json')
  const clearEnvironmentFence = (id: ExperimentId, operationId: string) => {
    const path = environmentFence(id)
    if (existsSync(path) && z.object({ operationId: z.string() }).parse(JSON.parse(readFileSync(path, 'utf8'))).operationId === operationId) unlinkSync(path)
  }
  const environmentBinding = (id: ExperimentId): ManagedEnvironmentBinding => {
    const saved = allocations.get(id)
    if (saved === undefined || saved.protocol !== 4) throw new Error('Managed environments require a protocol-4 allocation and capable fixed release')
    if (saved.node.server.storagePlacement === undefined) throw new Error('Managed environment storage placement is missing')
    return { experimentId: id, node: saved.node, deploymentId: saved.deploymentId, controlRoot: config.root,
      hiddenPaths: [...config.hiddenPaths, ...saved.node.hiddenPaths, config.root, saved.node.server.storagePlacement.namespaceRoot] }
  }
  const environmentIdle = (id: ExperimentId, originalCommand?: string) => {
    assertStorageSourceAvailable(config.root, id)
    if (maintenance !== undefined || closing) throw new Error('Controller is stopping or in maintenance')
    if ([...commands.entries()].some(([, row]) => row.experimentId === id && row.commandId !== originalCommand && !row.released)
      || [...services.entries()].some(([, row]) => row.experimentId === id && !row.released)) throw new Error('Environment changes require confirmed exit of every command and inference service')
  }
  const environmentRecoveryIdle = (id: ExperimentId, operationId: string, commandId: string) => {
    environmentIdle(id, commandId)
    const fence = environmentFence(id)
    if (existsSync(fence) && z.object({ operationId: environmentOperationIdSchema }).parse(JSON.parse(readFileSync(fence, 'utf8'))).operationId !== operationId) throw new Error('Recover the currently fenced environment operation before another operation')
  }
  const environmentStatus = (id: ExperimentId, operationId: string): EnvironmentOperationStatus => {
    const binding = environmentBinding(id)
    const request = environments.originalRequest(binding, operationId)
    const receipt = environments.receipt(binding, request)
    const runtime = environments.runtime(binding, operationId)
    const launch = environments.launch(binding, operationId)
    const reusePlan = environments.reusePlan(binding, operationId)
    const key = commandKey(id, 'environment-' + operationId)
    const command = commands.get(key)
    const admissionReleased = !existsSync(environmentFence(id)) && !handles.has(key) && !settlements.has(key)
    const notStarted = launch?.state === 'not-started' && command === undefined
    const exited = (command?.released === true || notStarted) && runtime?.exitConfirmed === true
    const settled = exited && admissionReleased && receipt.exitConfirmed && runtime.admissionReleased
    const running = handles.has(key) || settlements.has(key)
    const state = settled ? receipt.state === 'completed' && command?.exitCode === 0 && runtime.stopReason === undefined ? 'completed' : 'failed'
      : running ? 'running' : 'unknown'
    const checkedAt = Date.now()
    return { experimentId: id, serverId: binding.node.server.id, operationId: request.operationId, state, operation: receipt,
      ...(runtime === undefined ? {} : { runtime }), ...(launch === undefined ? {} : { launch }), ...(reusePlan === undefined ? {} : { reusePlan }),
      checkedAt, elapsedMs: Math.max(0, (settled ? runtime.updatedAt : checkedAt) - (runtime?.startedAt ?? receipt.startedAt)),
      processState: notStarted ? 'not-started' : exited ? 'exited' : handles.has(key) ? 'running' : 'unknown', admissionReleased,
      ...(state === 'unknown' ? { detail: 'Original process exit, receipt or admission release is unconfirmed; recover this operation before another mutation' }
        : receipt.exitConfirmed && !settled ? { detail: 'Installer receipt saved; waiting for process-group exit and admission release' }
        : runtime?.stopReason !== undefined ? { detail: 'Installation stopped: ' + runtime.stopReason + (receipt.detail === undefined ? '' : '; ' + receipt.detail) }
        : receipt.detail === undefined ? {} : { detail: receipt.detail }) }
  }
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = chain.then(operation)
    chain = pending.then(() => {}, () => {})
    return pending
  }
  const runRoot = (id: ExperimentId) => {
    const saved = allocations.get(id)
    if (saved === undefined) throw new Error('Experiment has no saved directory assignment')
    return serverRunRoot(saved.node.server, id)
  }
  const workspace = (id: ExperimentId) => resolve(runRoot(id), 'workspace')
  const logPath = (id: ExperimentId) => resolve(runRoot(id), 'node.log')
  const processLogPath = (id: ExperimentId, commandId: string, stream: 'stdout' | 'stderr') => resolve(runRoot(id), 'process-logs', commandId, `${stream}.log`)
  const sampler = new NodeMetricSampler(ctx, observationPolicy)
  const samplingLifetime = new AbortController()
  let sampling: Promise<void> | undefined
  const sample = () => {
    if (sampling !== undefined || samplingLifetime.signal.aborted) return
    const active = [...allocations.entries()].filter(([, row]) => !row.released && row.bootId === config.bootId)
    if (active.length === 0) return
    sampling = sampler.sample(samplingLifetime.signal).then(value => {
      for (const [experimentId, allocation] of active) saveMetricSample(runRoot(experimentId), { ...value, experimentId, serverId: allocation.node.server.id }, observationPolicy)
    }).catch((error: unknown) => { if (!samplingLifetime.signal.aborted) ctx.logger.warn(`Resource sampling failed: ${String(error)}`) }).finally(() => { sampling = undefined })
  }
  ctx.effect(() => {
    const timer = setInterval(sample, observationPolicy.intervalMs)
    return async () => { clearInterval(timer); samplingLifetime.abort(); await sampling }
  }, 'Aspera: node resource samples')
  const allocation = (id: ExperimentId) => {
    if (existsSync(resolve(config.root, 'state/interruption-fences', `${id}.json`))) throw new Error('Experiment interruption is fencing new commands')
    const saved = allocations.get(id)
    if (saved === undefined || saved.released || saved.releasing || saved.bootId !== config.bootId) throw new Error('node allocation is unavailable or interrupted')
    return saved
  }
  const finish = async (key: string, handle: SubprocessHandle, exitTimeoutMs = config.cleanupTimeoutMs): Promise<void> => {
    let patch: Partial<ClusterCommandResult>
    try {
      const outcome = await handle.done
      const released = await handle.waitForExit(AbortSignal.timeout(exitTimeoutMs))
      patch = { exitCode: outcome.exitCode, released, state: outcome.exitCode === 0 && released ? 'completed' : 'failed' }
    } catch (error) { patch = { state: 'failed', released: false, detail: String(error) } }
    await serial(async () => {
      const current = commands.get(key)
      if (current === undefined) throw new Error('managed command record is missing')
      await commands.put(key, { ...current, ...patch })
      for (const [serviceId, service] of services.entries()) {
        if (commandKey(service.experimentId, service.commandId) !== key) continue
        await stopGateway(serviceId)
        await services.put(serviceId, { ...service, updatedAt: Date.now(), released: patch.released === true,
          ...stoppedExposure(service),
          state: service.state === 'stopping' && patch.released ? 'stopped' : 'failed',
          detail: service.state === 'stopping' && patch.released ? undefined : 'Inference process exited; it is not restarted automatically.' })
      }
      if (patch.released) handles.delete(key)
    })
    if (patch.released) { clearTimeout(deadlines.get(key)); deadlines.delete(key) }
  }
  ctx.effect(() => async () => {
    closing = true
    await network.close()
    await chain
    await Promise.all([...gateways.keys()].map(stopGateway))
    for (const [key, handle] of handles) { await recordEnvironmentStop(key, 'controller-stopping'); handle.terminate() }
    for (const timer of deadlines.values()) clearTimeout(timer)
    await Promise.all([...netServers.values()].map(server => new Promise<void>((done) => { server.close(() => { done() }) })))
    await Promise.all(settlements.values())
    await chain
    await store.close()
  }, 'experiment node: processes and allocation records')

  return async (operation: string, raw: unknown): Promise<unknown> => {
    if (operation.startsWith('probe-network-')) return network.request(operation, raw)
    if (operation === 'health') {
      let actualGpu: GpuInventory | undefined; let gpuError: string | undefined
      try { actualGpu = await probeControllerGpu(ctx, config.root, config.cleanupTimeoutMs) }
      catch (error) { gpuError = String(error) }
      const controller: ControllerStatus = { version: 1, role: 'node', bootId: controllerBootIdSchema.parse(config.bootId),
        deploymentId: config.deploymentId, root: config.root, ...controllerProcessIdentity(), policy, policyDigest,
        occupied: occupied(), ...(maintenance === undefined ? {} : { maintenance }),
        ...(actualGpu === undefined ? { gpuError } : { actualGpu }) }
      return { allocations: controller.occupied.allocations, controller }
    }
    if (operation === 'maintenance-begin' || operation === 'maintenance-cancel') return serial(async () => {
      const request = controllerMaintenanceSchema.parse(raw)
      if (request.bootId !== config.bootId || request.policyDigest !== policyDigest) throw new Error('Controller identity changed; inspect before repairing')
      if (maintenance !== undefined && maintenance !== request.operationId) throw new Error('Controller maintenance belongs to another operation')
      if (operation === 'maintenance-cancel') { maintenance = undefined; return { cancelled: true } }
      const busy = occupied()
      if (Object.values(busy).some(ids => ids.length !== 0) || handles.size !== 0) throw new Error(`Controller is occupied: ${JSON.stringify(busy)}`)
      maintenance = request.operationId
      return { maintenance, bootId: config.bootId, policyDigest }
    })
    const input = z.object({ experimentId: experimentIdSchema }).loose().parse(raw)
    const id = input.experimentId
    if (operation === 'command-status' || operation === 'stop-command') {
      const query = z.object({ commandId: clusterCommandSchema.shape.commandId, commandHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(raw)
      const key = commandKey(id, query.commandId), row = commands.get(key), allocationRow = allocations.get(id)
      if (row === undefined || allocationRow === undefined || row.experimentId !== id) throw new Error('Original command is absent from this allocation')
      if (operation === 'stop-command') {
        if (query.commandHash === undefined || query.commandHash !== createHash('sha256').update(row.command).digest('hex')) throw new Error('Command contents differ from the owned stop request')
        if ([...services.entries()].some(([, service]) => service.experimentId === id && service.commandId === query.commandId)) throw new Error('Registered services must use their dedicated stop operation')
        await serial(async () => { handles.get(key)?.terminate() })
        await verifyCleanup(key)
      }
      return { experimentId: id, serverId: allocationRow.node.server.id, result: commandView(commands.get(key)!), checkedAt: Date.now() }
    }
    if (operation === 'stage-source') {
      const source = z.object({ path: z.string().min(1).max(2048), metadataOnly: z.boolean().optional() }).parse(raw)
      const owner = allocations.get(id)
      if (owner === undefined) throw new Error('Stage evidence has no original allocation')
      return inspectCompletionFile({ runRoot: runRoot(id), experimentId: id, serverId: owner.node.server.id,
        path: source.path, metadataOnly: source.metadataOnly, maxBytes: finalizationPolicySchema.parse(config.finalization ?? {}).evidenceBytes })
    }
    if (operation === 'completion-source') {
      const source = z.object({ path: z.string().min(1).max(2048) }).parse(raw)
      return inspectCompletionFile({ runRoot: runRoot(id), experimentId: id, serverId: allocations.get(id)!.node.server.id,
        path: source.path, maxBytes: config.chunkBytes })
    }
    if (operation === 'environment-acceptance') {
      const required = z.object({ environments: z.array(z.string().min(1).max(2048)).max(512).optional() }).parse(raw).environments ?? []
      if (existsSync(environmentFence(id))) return { verified: false, detail: 'Environment operation exit or publication remains unconfirmed' }
      try {
        const mounts = managedEnvironmentMounts(runRoot(id), workspace(id), config.root)
          materialReadonlyPaths(runRoot(id), config.root)
          const planPath = resolve(runRoot(id), 'storage-plan.v1.json')
          if (existsSync(planPath)) {
            const plan = experimentStoragePlanSchema.parse(JSON.parse(readFileSync(planPath, 'utf8')))
            if (plan.state !== 'ready' || plan.experimentId !== id || plan.serverId !== allocation(id).node.server.id
              || plan.materialIds.some(material => !existsSync(resolve(runRoot(id), 'material-bindings-v1', material + '.json')))) throw new Error('Declared storage/material plan is not verified for this experiment')
          }
        return mounts.readonlyPaths.length === 0 ? required.length > 0
          ? { verified: false, detail: 'Recorded execution environment is not registered; prepare and verify the training environment before completion' }
          : { verified: true, environments: 0 } : await environments.acceptance(environmentBinding(id), required)
      }
      catch (error) { return { verified: false, detail: String(error) } }
    }
    if (operation === 'environment-storage') {
      const binding = environmentBinding(id)
      return { ...await environments.inspect(binding), operations: environments.operations(binding).map(row => environmentStatus(id, row.operationId)) }
    }
    if (operation === 'environment-preview') {
      const preview = await environments.preview(environmentBinding(id))
      try { environmentIdle(id); return preview }
      catch (error) { return { ...preview, eligible: false, detail: String(error) } }
    }
    if (operation === 'environment-inspect') {
      const binding = environmentBinding(id)
      const operations = environments.operations(binding)
      const launches = operations.map(receipt => environments.launch(binding, receipt.operationId)).filter(value => value !== undefined)
      try { return { operations, launches, storage: { ...await environments.inspect(binding), operations: operations.map(row => environmentStatus(id, row.operationId)) } } }
      catch (error) { return { operations, launches, error: String(error) } }
    }
    if (operation === 'environment-status') {
      const request = z.object({ operationId: environmentOperationIdSchema }).parse(raw)
      return environmentStatus(id, request.operationId)
    }
    if (operation === 'environment-recover') return serial(async () => {
      const request = z.object({ operationId: environmentOperationIdSchema }).parse(raw)
      const binding = environmentBinding(id)
      const original = environments.originalRequest(binding, request.operationId)
      const commandId = 'environment-' + request.operationId; const key = commandKey(id, commandId)
      if (handles.has(key)) return { ...environments.receipt(binding, original), detail: 'Original environment process is still managed and running; wait for its command exit' }
      environmentRecoveryIdle(id, request.operationId, commandId)
      const command = commands.get(key); const launch = environments.launch(binding, request.operationId)
      const rejected = launch?.state === 'prepared' || launch?.state === 'not-started'
      if (command === undefined && !rejected) throw new Error('Original command and verifiable startup evidence are missing; preserve the environment fence and inspect original release, failure logs and process identity')
      const result = await environments.recover(binding, original, rejected || command?.state === 'failed' && command.released)
      if (result.exitConfirmed) {
        if (command !== undefined && !command.released) await commands.put(key, { ...command, released: true, state: 'interrupted', exitCode: null, detail: result.detail })
        if (launch !== undefined && !rejected) await environments.recordLaunch(binding, request.operationId, 'exited', result.detail)
        clearEnvironmentFence(id, request.operationId)
        if (environments.runtime(binding, request.operationId) !== undefined) await environments.recordRuntime(binding, original,
          { exitConfirmed: true, exitCode: command?.exitCode ?? null, admissionReleased: true })
      }
      return result
    })
    if (operation === 'storage-inspect') {
      const request = z.object({ refresh: z.boolean().optional(), cursor: z.string().optional() }).parse(raw)
      return environments.governance(environmentBinding(id), 'storage-inspect', request)
    }
    if (operation === 'storage-assess') return serial(async () => {
      allocation(id); environmentIdle(id)
      const { experimentId: _id, ...request } = z.object({ experimentId: experimentIdSchema }).loose().parse(raw)
      return environments.governance(environmentBinding(id), 'storage-assess', { request: assessExperimentStorageSchema.parse(request) })
    })
    if (operation === 'storage-plan') return environments.governance(environmentBinding(id), 'storage-plan')
    if (operation === 'material-metadata-pending') return environments.governance(environmentBinding(id), 'material-metadata-pending')
    if (operation === 'material-metadata-error') {
      const request = z.object({ experimentId: experimentIdSchema, requestId: z.string().regex(/^[a-f0-9]{64}$/), detail: z.string().max(16384) }).strict().parse(raw)
      return environments.governance(environmentBinding(id), 'material-metadata-error', request)
    }
    if (operation === 'material-inspect' || operation === 'material-manifest-import') {
      const { experimentId: _id, canonical, ...input } = z.object({ experimentId: experimentIdSchema, canonical: z.unknown().optional() }).loose().parse(raw)
      if (operation === 'material-inspect' && canonical !== undefined) throw new Error('Canonical manifest import is a program-owned operation')
      return environments.governance(environmentBinding(id), 'material-inspect', { request: inspectExperimentMaterialsSchema.parse(input),
        ...(canonical === undefined ? {} : { canonical }) })
    }
    if (operation === 'material-status') {
      const request = z.object({ operationId: storageOperationIdSchema }).parse(raw)
      const status = environments.materialStatus(environmentBinding(id), request.operationId)
      if (status === undefined) return null
      const key = commandKey(id, status.commandId ?? 'material-' + request.operationId)
      const command = commands.get(key)
      const released = (command?.released === true || status.processState === 'not-started') && !handles.has(key) && !settlements.has(key)
      return { ...status, ...(status.state === 'completed' && !released ? { stage: 'waiting-exit' } : {}), exitConfirmed: status.exitConfirmed && released, admissionReleased: status.admissionReleased && released }
    }
    if (operation === 'material-prepare') return serial(async () => {
      const { experimentId: _id, ...input } = z.object({ experimentId: experimentIdSchema }).loose().parse(raw)
      const request = prepareExperimentMaterialsSchema.parse(input)
      const binding = environmentBinding(id)
      const previous = environments.materialStatus(binding, request.operationId)
      if (previous !== undefined) {
        const original = environments.materialOriginal(binding, request.operationId)
        if (original.materialId !== request.materialId || original.budgetId !== request.budgetId || request.action !== 'recover' && original.action !== request.action) throw new Error('Material operation identity is bound to different content')
      }
      if (request.action === 'recover' && previous === undefined) throw new Error('Original material receipt is missing; inspect startup and exit evidence before resubmitting this operation')
      const key = commandKey(id, previous?.commandId ?? 'material-' + request.operationId)
      if (previous?.state === 'completed' || handles.has(key) || settlements.has(key)) return previous ?? null
      allocation(id)
      if (request.action === 'recover' && previous !== undefined) {
        environmentRecoveryIdle(id, request.operationId, previous.commandId ?? 'material-' + request.operationId)
        await environments.governance(binding, 'material-settle', { operationId: request.operationId, launchFailureConfirmed: previous.processState === 'not-started' })
        const original = commands.get(key)
        if (original !== undefined && !original.released) await commands.put(key, { ...original, released: true, state: 'failed', detail: 'Original material process exit confirmed; recover the same acquisition without repeating training' })
        clearEnvironmentFence(id, request.operationId)
      }
      environmentIdle(id)
      const command = environments.materialCommand(binding, request)
      await environments.governance(binding, 'material-register', command.registration)
      if (existsSync(environmentFence(id))) throw new Error('Recover the fenced operation before material acquisition')
      await writeFileAtomic(environmentFence(id), JSON.stringify({ version: 1, operationId: request.operationId, commandId: command.commandId }), { mode: 0o600 })
      try {
        await launchOwned(id, { commandId: command.commandId, command: `[managed materials] ${request.action} ${request.materialId}` }, command.deadline,
          { argv: command.argv, operationId: request.operationId, material: true })
      } catch (error) {
        const row = commands.get(commandKey(id, command.commandId))
        if (row === undefined || row.released) {
          await environments.governance(binding, 'material-settle', { operationId: request.operationId, launchFailureConfirmed: true, notStarted: row === undefined })
          clearEnvironmentFence(id, request.operationId)
        }
        throw error
      }
      return environments.materialStatus(binding, request.operationId) ?? null
    })
    if (operation === 'environment-prepare') return serial(async () => {
      const { experimentId: _id, ...body } = z.object({ experimentId: experimentIdSchema }).loose().parse(raw)
      const request = prepareExperimentEnvironmentSchema.parse(body)
      const binding = environmentBinding(id)
      const previous = environments.operations(binding).find(row => row.operationId === request.operationId)
      if (previous !== undefined) {
        environments.command(binding, request)
        return previous
      }
      allocation(id); environmentIdle(id)
      if (existsSync(environmentFence(id))) throw new Error('Original environment operation requires recovery before another operation')
      const command = environments.command(binding, request)
      const lifetime = await environments.recordRuntime(binding, request)
      await environments.recordLaunch(binding, request.operationId, 'prepared')
      await writeFileAtomic(environmentFence(id), JSON.stringify({ version: 1, operationId: request.operationId, commandId: command.commandId }), { mode: 0o600 })
      try {
        await launchOwned(id, { commandId: command.commandId, command: `[managed environment] ${request.action} ${request.environmentId}` },
          lifetime.deadline, { argv: command.argv, operationId: request.operationId })
      } catch (error) {
        const evidence = environments.launch(binding, request.operationId)
        const row = commands.get(commandKey(id, command.commandId))
        if (evidence?.state === 'prepared' || row?.state === 'failed' && row.released) {
          await environments.recordLaunch(binding, request.operationId, 'not-started', String(error))
          const outcome = await environments.recover(binding, request, true)
          if (outcome.exitConfirmed) {
            clearEnvironmentFence(id, request.operationId)
            await environments.recordRuntime(binding, request, { exitConfirmed: true, exitCode: null, admissionReleased: true, detail: String(error) })
          }
        }
        throw error
      }
      return environments.receipt(binding, request)
    })
    if (operation === 'environment-cleanup-status') return serial(async () => {
      const request = experimentCacheCleanupSchema.parse(raw); const binding = environmentBinding(id)
      if (request.nodes.length !== 1 || request.nodes[0]!.serverId !== binding.node.server.id) throw new Error('Cleanup status has an unassigned node')
      const key = commandKey(id, 'environment-cleanup-' + request.operationId); const original = commands.get(key)
      if (original === undefined) {
        const launch = environments.launch(binding, request.operationId)
        if (launch?.state === 'prepared' || launch?.state === 'not-started') {
          if (environments.cleanupFingerprint(binding, request.operationId) !== request.nodes[0]!.fingerprint) throw new Error('Cleanup status differs from the original preview')
          environmentRecoveryIdle(id, request.operationId, 'environment-cleanup-' + request.operationId)
          const result = await environments.recoverCleanup(binding, request.operationId, request.nodes[0]!.fingerprint, true)
          clearEnvironmentFence(id, request.operationId); return { state: 'settled', result }
        }
        return launch === undefined && !existsSync(environmentFence(id)) ? { state: 'not-started' }
          : { state: 'unknown', detail: 'Original cleanup startup cannot be confirmed; preserve the fence and inspect its original receipt and process identity' }
      }
      if (environments.cleanupFingerprint(binding, request.operationId) !== request.nodes[0]!.fingerprint) throw new Error('Cleanup status differs from the original preview')
      if (handles.has(key)) return { state: 'running' }
      environmentRecoveryIdle(id, request.operationId, original.commandId)
      const result = await environments.recoverCleanup(binding, request.operationId, request.nodes[0]!.fingerprint, original.released)
      if (!original.released) await commands.put(key, { ...original, released: true, state: 'interrupted', exitCode: null, detail: result.detail })
      clearEnvironmentFence(id, request.operationId); return { state: 'settled', result }
    })
    if (operation === 'environment-cleanup') return serial(async () => {
      const request = experimentCacheCleanupSchema.parse(raw)
      if (request.experimentId !== id || request.nodes.length !== 1) throw new Error('Node cleanup requires exactly its original server')
      const binding = environmentBinding(id); const node = request.nodes[0]!
      if (node.serverId !== binding.node.server.id) throw new Error('Cleanup node is outside this experiment')
      const previous = environments.cleanupResult(binding, request.operationId)
      const command = environments.cleanupCommand(binding, request.operationId, node.fingerprint, node.candidateIds)
      const original = commands.get(commandKey(id, command.commandId))
      if (previous !== undefined && (original?.released === true || environments.launch(binding, request.operationId)?.state === 'not-started')) { clearEnvironmentFence(id, request.operationId); return previous }
      if (original !== undefined && !handles.has(commandKey(id, command.commandId))) {
        environmentRecoveryIdle(id, request.operationId, command.commandId)
        const result = await environments.recoverCleanup(binding, request.operationId, node.fingerprint, original.released)
        if (!original.released) await commands.put(commandKey(id, command.commandId), { ...original, released: true, state: 'interrupted', exitCode: null, detail: result.detail })
        clearEnvironmentFence(id, request.operationId); return result
      }
      if (original !== undefined) return { serverId: node.serverId, state: 'blocked', reclaimedBytes: 0, checkedAt: Date.now(),
        detail: original.released ? 'Cleanup exited without a committed result; inspect the original receipt and command. ' + (original.detail ?? '') : 'Cleanup remains pending; inspect its original command before retrying' }
      environmentIdle(id)
      if (existsSync(environmentFence(id))) throw new Error('Environment outcome requires recovery before cleanup')
      await environments.recordLaunch(binding, request.operationId, 'prepared', undefined, command.commandId)
      await writeFileAtomic(environmentFence(id), JSON.stringify({ version: 1, operationId: request.operationId, commandId: command.commandId }), { mode: 0o600 })
      try {
        await launchOwned(id, { commandId: command.commandId, command: '[managed environment] cache cleanup' },
          Date.now() + environments.policy.timeoutMs, { argv: command.argv, operationId: request.operationId, cleanup: true })
      } catch (error) {
        const evidence = environments.launch(binding, request.operationId); const row = commands.get(commandKey(id, command.commandId))
        if (evidence?.state === 'prepared' || row?.state === 'failed' && row.released) {
          await environments.recordLaunch(binding, request.operationId, 'not-started', String(error), command.commandId)
          await environments.recoverCleanup(binding, request.operationId, node.fingerprint, true)
          clearEnvironmentFence(id, request.operationId)
        }
        throw error
      }
      return { serverId: node.serverId, state: 'blocked', reclaimedBytes: 0, checkedAt: Date.now(), detail: 'Cleanup started; repeat the same operation to read its committed result' }
    })
    if (operation === 'observation-sources') {
      if (allocations.get(id) === undefined) return []
      return observationSources(runRoot(id)).filter(source => source.experimentId === id)
    }
    if (operation === 'observation-read') {
      const query = observationReadSchema.parse(raw)
      return readObservation(runRoot(id), { ...query, limit: Math.min(query.limit, observationPolicy.readBytes) })
    }
    if (operation === 'observation-metrics') {
      const query = metricReadSchema.parse(raw)
      if (allocations.get(id) === undefined) return []
      if (allocations.get(id)?.node.server.id !== query.serverId) throw new Error('Metric node is outside the experiment')
      return readMetricSamples(runRoot(id), query)
    }
    if (operation === 'allocate') return serial(async () => {
      if (closing) throw new Error('node is stopping')
      if (maintenance !== undefined) throw new Error('node is in controller maintenance')
      if (existsSync(resolve(config.root, 'state/interruption-fences', `${id}.json`))) throw new Error('Experiment interruption prevents allocation')

      const request = allocationRequestSchema.parse(raw)
      if (request.protocol === 3 || request.protocol === 4) {
        const placement = request.node.server.storagePlacement
        if (placement === undefined) throw new Error('Protocol 3 requires a saved storage assignment')
        if (placement.serverId !== request.node.server.id || placement.experimentId !== id || !placement.releaseRoot.endsWith('/' + request.deploymentId)) {
          throw new Error('Storage assignment belongs to another node, experiment or release')
        }
        verifyStorage(placement)
      }
      const previous = allocations.get(id)
      if (previous !== undefined) {
        if (previous.deploymentId !== request.deploymentId || JSON.stringify(previous.node) !== JSON.stringify(request.node)
          || previous.protocol !== request.protocol || JSON.stringify(previous.budget) !== JSON.stringify(request.budget) || previous.deadline !== request.deadline) throw new Error('allocation content conflict')
        allocation(id)
        return { allocated: true }
      }
      if ([...allocations.entries()].some(([, row]) => !row.released)) throw new Error('node already belongs to another experiment')
      if (request.node.server.remoteRoot !== config.root) throw new Error('node root does not match the configured deployment')
      if (request.node.backendPath !== config.backendPath) throw new Error('sandbox backend differs from node policy')
      if (config.hiddenPaths.some(path => !request.node.hiddenPaths.includes(path))) throw new Error('private directories differ from node policy')
      mkdirSync(resolve(serverRunRoot(request.node.server, id), 'workspace'), { recursive: true, mode: 0o700 })
      if (request.node.devicePaths.some(path => !config.devicePaths.includes(path))) throw new Error('node request exceeds its granted GPU devices')
      if (request.protocol === 4) {
        const actual = await probeControllerGpu(ctx, config.root, config.cleanupTimeoutMs)
        if (config.gpuSnapshot === undefined) throw new Error('Controller GPU identity policy is unavailable; repeat preparation')
        const identity = JSON.stringify(normalizedSet(actual.gpus.map(gpu => gpu.uuid.toLowerCase())))
        if (JSON.stringify(gpuIdentities(request.node.gpuInfo)) !== identity
          || JSON.stringify(normalizedGpuInventory(config.gpuSnapshot)) !== JSON.stringify(normalizedGpuInventory(actual))
          || request.node.devicePaths.some(path => !actual.devicePaths.includes(path))) {
          throw new Error(`GPU hardware changed after preparation; copy this experiment. Requested devices: ${JSON.stringify(request.node.devicePaths)}; actual: ${JSON.stringify(actual)}`)
        }
      }
      if (existsSync(resolve(config.root, 'state/interruption-fences', `${id}.json`))) throw new Error('Experiment interruption prevents allocation')
      await allocations.put(id, { ...request, released: false, releasing: false, bootId: config.bootId })
      return { allocated: true }
    })
    if (operation === 'release') {
      const saved = await serial(async () => {
        const current = allocations.get(id)
        if (current === undefined || current.released) return current
        const next = { ...current, releasing: true }
        await allocations.put(id, next)
        for (const [serviceId, service] of services.entries()) {
          if (service.experimentId === id && !service.released) {
            await stopGateway(serviceId)
            await services.put(serviceId, { ...service, ...stoppedExposure(service), state: 'stopping', updatedAt: Date.now() })
          }
        }
        return next
      })
      if (saved === undefined || saved.released) return { released: true }
      const owned = [...commands.entries()].filter(([, row]) => row.experimentId === id)
      if (saved.bootId !== config.bootId) return serial(async () => {
        if (owned.some(([, command]) => !command.released)) return { released: false,
          detail: 'node restarted; process cleanup requires operator verification' }
        await allocations.put(id, { ...saved, released: true })
        if (existsSync(resolve(runRoot(id), 'storage-plan.v1.json'))) await environments.governance(environmentBinding(id), 'storage-release')
        return { released: true }
      })
      for (const [key] of owned) { await recordEnvironmentStop(key, 'cancelled'); handles.get(key)?.terminate() }
      await Promise.all(owned.flatMap(([key]) => {
        const pending = settlements.get(key)
        return pending === undefined ? [] : [pending]
      }))
      await Promise.all(owned.map(([key]) => verifyCleanup(key)))
      return serial(async () => {
        const released = owned.every(([key]) => commands.get(key)?.released === true)
        if (released) {
          const server = netServers.get(id)
          if (server !== undefined) await new Promise<void>(resolveClose => server.close(() => { resolveClose() }))
          netServers.delete(id)
          await allocations.put(id, { ...saved, released: true })
          if (existsSync(resolve(runRoot(id), 'storage-plan.v1.json'))) await environments.governance(environmentBinding(id), 'storage-release')
        }
        return { released }
      })
    }
    if (operation === 'files') {
      const saved = allocations.get(id)
      return saved === undefined ? { files: [], truncated: false } : clusterFiles(workspace(id), saved.node.server.id, config.fileLimit)
    }
    if (operation === 'processes') {
      const saved = allocations.get(id)
      if (saved === undefined) return []
      return [...commands.entries()].filter(([, row]) => row.experimentId === id).map(([, row]) => ({
        ...commandView(row), experimentId: id, serverId: saved.node.server.id, command: row.command,
        streams: (['stdout', 'stderr'] as const).filter(stream => existsSync(processLogPath(id, row.commandId, stream))) }))
    }
    if (operation === 'process-log') {
      const request = processLogRequestSchema.parse(raw)
      const saved = allocations.get(id)
      if (saved?.node.server.id !== request.serverId || commands.get(commandKey(id, request.commandId)) === undefined) throw new Error('Process log belongs to another experiment or node')
      const cursor = request.cursor
      if (cursor !== undefined && (cursor.experimentId !== id || cursor.serverId !== request.serverId || cursor.commandId !== request.commandId || cursor.stream !== request.stream)) throw new Error('Log cursor belongs to another experiment, node, process or stream')
      const path = processLogPath(id, request.commandId, request.stream)
      const chunk = readClusterChunk(path, cursor?.offset ?? 0, cursor?.generation, config.chunkBytes)
      return { chunk, missing: chunk.generation === '', cursor: { experimentId: id, serverId: request.serverId,
        commandId: request.commandId, stream: request.stream, generation: chunk.generation, offset: chunk.nextOffset } }
    }
    if (operation === 'log' || operation === 'file') {
      const request = z.object({ offset: z.number().int().nonnegative(), generation: z.string().optional(),
        path: z.string().optional() }).parse(raw)
      const path = operation === 'log' ? logPath(id) : clusterPath(workspace(id), request.path ?? '')
      return readClusterChunk(path, request.offset, request.generation, config.chunkBytes, operation === 'file' ? workspace(id) : undefined)
    }
    if (operation === 'services') {
      const rows = [...services.entries()].filter(([, row]) => row.experimentId === id)
      for (const [key, service] of rows) {
        if (service.released || ['failed', 'interrupted', 'stopped'].includes(service.state)) continue
        const saved = allocations.get(id)
        if (saved?.bootId !== config.bootId || !handles.has(commandKey(id, service.commandId))) {
          await serial(async () => {
            const current = services.get(key)
            if (current === undefined || current.released || !['starting', 'healthy', 'unhealthy'].includes(current.state)) return
            await services.put(key, { ...current, ...stoppedExposure(current), state: 'interrupted', detail: 'Service process identity cannot be verified after node restart.', updatedAt: Date.now() })
          })
          continue
        }
        if (service.deadline !== undefined && service.deadline <= Date.now()) {
          await stopService(service)
          continue
        }
        let state: InferenceService['state'] = 'unhealthy'
        try {
          const response = await fetch(`http://127.0.0.1:${service.port}${service.healthPath}`, { signal: AbortSignal.timeout(config.cleanupTimeoutMs), redirect: 'error' })
          state = response.ok ? 'healthy' : 'unhealthy'
          await response.body?.cancel()
        } catch (error) { ctx.logger.debug(`Aspera service health: ${String(error)}`) }
        const gateway = gateways.get(key)
        const external = gateway === undefined ? service.external : await gateway.probe()
        await serial(async () => {
          const current = services.get(key)
          if (current === undefined || current.released || !['starting', 'healthy', 'unhealthy'].includes(current.state)
            || !handles.has(commandKey(id, current.commandId)) || allocations.get(id)?.releasing) return
          await services.put(key, { ...current, state, ...(external === undefined ? {} : { external }), updatedAt: Date.now() })
        })
      }
      return [...services.entries()].filter(([, row]) => row.experimentId === id).map(([, row]) => row)
    }
    if (operation === 'service-access-info') {
      const request = z.object({ serviceId: serviceIdSchema }).parse(raw)
      const service = services.get(request.serviceId)
      const gateway = gateways.get(request.serviceId)
      allocation(id)
      if (service?.experimentId !== id || service.released || gateway === undefined) throw new Error('Public service is not active in this experiment')
      return gateway.access()
    }
    if (operation === 'stop-service') {
      const request = z.object({ serviceId: serviceIdSchema }).parse(raw)
      const service = services.get(request.serviceId)
      if (service?.experimentId !== id) throw new Error('service is outside this experiment')
      return stopService(service)
    }
    if (operation === 'access-service') {
      const request = z.object({ serviceId: serviceIdSchema, path: z.string().max(2048), method: z.enum(['GET', 'POST']), body: z.string().max(65536).optional() }).parse(raw)
      const service = services.get(request.serviceId)
      if (service?.experimentId !== id || service.state !== 'healthy' || service.released) throw new Error('service is not healthy in this experiment')
      if (!request.path.startsWith('/') || request.path.startsWith('//') || /[\\\\\r\n]/.test(request.path)) throw new Error('service path must be a relative HTTP path')
      allocation(id)
      const response = await fetch(`http://127.0.0.1:${service.port}${request.path}`, { method: request.method, body: request.body,
        headers: request.body === undefined ? {} : { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(config.cleanupTimeoutMs) })
      let bytes = 0
      const chunks: Buffer[] = []
      try {
        if (response.body !== null) for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > config.chunkBytes) throw new Error('service response exceeds the configured byte limit')
          chunks.push(Buffer.from(chunk))
        }
      } finally { if (response.body !== null && !response.body.locked) await response.body.cancel() }
      return { status: response.status, contentType: response.headers.get('content-type'), body: Buffer.concat(chunks).toString('utf8') }
    }
    if (operation === 'status') return [...commands.entries()].filter(([, row]) => row.experimentId === id).map(([,
      row]) => commandView(row))
    allocation(id)
    if (operation === 'verify-input') {
      const request = z.object({ name: z.string(), sha256: deploymentIdSchema }).parse(raw)
      const path = clusterPath(workspace(id), `inputs/${request.name}`)
      if (await clusterFileHash(path) !== request.sha256) throw new Error(`staged input digest mismatch: ${request.name}`)
      return { verified: true }
    }
    if (operation === 'input') {
      const request = z.object({ path: z.string(), data: z.string(), offset: z.number().int().nonnegative() }).parse(raw)
      const bytes = Buffer.from(request.data, 'base64')
      if (bytes.length > config.chunkBytes) throw new Error('input chunk exceeds the configured limit')
      const placement = allocation(id).node.server.storagePlacement
      if (placement !== undefined) verifyStorage(placement, bytes.length)
      mkdirSync(resolve(workspace(id), 'inputs'), { recursive: true })
      if (!request.path.startsWith('inputs/')) throw new Error('inputs must be stored under inputs/')
      const path = clusterPath(workspace(id), request.path)
      {
        const size = existsSync(path) ? statSync(path).size : 0
        if (size === request.offset) appendFileSync(path, bytes, { mode: 0o600 })
        else if (size >= request.offset + bytes.length) {
          const previous = Buffer.alloc(bytes.length)
          const fd = openSync(path, 'r')
          try { readSync(fd, previous, 0, previous.length, request.offset) } finally { closeSync(fd) }
          if (!previous.equals(bytes)) throw new Error('input retry contains different bytes')
        } else throw new Error('input offset does not match the staged file')
      }
      return { nextOffset: request.offset + bytes.length }
    }
    if (operation === 'listen') return serial(async () => {
      allocation(id)
      let server = netServers.get(id)
      if (server === undefined) {
        server = createServer((socket) => {
          socket.on('error', (error) => { ctx.logger.debug(`experiment network probe: ${String(error)}`) })
          socket.setTimeout(config.cleanupTimeoutMs, () => { socket.destroy() })
          socket.end(id)
        })
        await new Promise<void>((resolveReady, reject) => {
          const listener = server
          if (listener === undefined) throw new Error('network probe listener is missing')
          listener.once('error', reject)
          listener.listen(0, '0.0.0.0', resolveReady)
        })
        netServers.set(id, server)
      }
      return { port: (server.address() as AddressInfo).port }
    })
    if (operation === 'connect') {
      const peer = z.object({ host: z.string(), port: z.number().int().min(1).max(65535) }).parse(raw)
      await new Promise<void>((resolveConnected, reject) => {
        const socket = connect(peer.port, peer.host)
        socket.setTimeout(config.cleanupTimeoutMs, () => { socket.destroy(new Error('training network probe timed out')) })
        socket.once('error', reject)
        let reply = ''
        socket.on('data', (data) => { reply += String(data) })
        socket.once('end', () => { if (reply === id) resolveConnected(); else reject(new Error('training network probe reached a different experiment')) })
      })
      return { connected: true }
    }
    if (operation === 'register-service') return serial(async () => {
      const { publish, ...request } = serviceSchema.omit({ serverId: true, commandId: true, state: true, createdAt: true, updatedAt: true, released: true, detail: true, deadline: true, external: true })
        .extend({ publish: z.boolean().optional() }).parse(raw)
      const current = allocation(id)
      if (request.healthPath.startsWith('//') || /[\\\r\n#]/.test(request.healthPath)) throw new Error('Health check requires a relative HTTP path')
      const mapping = publish === true ? current.node.server.inferenceMapping : undefined
      if (publish === true && mapping === undefined) throw new Error('This experiment has no saved external inference mapping for the node')
      if (mapping !== undefined && [request.port, current.node.server.remotePort, current.node.server.remotePort + 1, current.node.server.sshPort].includes(mapping.port)) {
        throw new Error('Mapped inference port must differ from the model, SSH and control ports')
      }
      clusterPath(workspace(id), request.modelPath)
      const previous = services.get(request.id)
      if (previous !== undefined) {
        if (previous.experimentId !== id || previous.command !== request.command || previous.port !== request.port
          || previous.modelPath !== request.modelPath || previous.healthPath !== request.healthPath || previous.modelName !== request.modelName
          || (previous.external !== undefined) !== (mapping !== undefined)) throw new Error('service id is bound to different content')
        return previous
      }
      if ([...services.entries()].some(([, service]) => !service.released && service.port === request.port)) throw new Error('service port belongs to another managed process')
      const probe = createServer()
      await new Promise<void>((ready, reject) => {
        probe.once('error', reject)
        probe.listen({ port: request.port, host: '127.0.0.1', exclusive: true }, ready)
      }).catch((error: unknown) => { throw new Error('service port is already occupied; select an unused loopback port', { cause: error }) })
      await new Promise<void>((done, reject) => { probe.close(error => { if (error !== undefined) reject(error); else done() }) })
      const service: InferenceService = { ...request, experimentId: id, serverId: current.node.server.id, commandId: `service-${request.id}`,
        state: 'starting', createdAt: Date.now(), updatedAt: Date.now(),
        ...(mapping === undefined ? {} : { external: { ...mapping, state: 'unchecked' } }),
        ...(current.budget === undefined ? {} : { deadline: Date.now() + current.budget.maxServiceSeconds * 1000 }), released: false }
      await services.put(service.id, service)
      try {
        if (mapping !== undefined) gateways.set(service.id, await openInferenceGateway(service, {
          root: config.root, healthTimeoutMs: config.cleanupTimeoutMs, requestTimeoutMs: config.serviceRequestTimeoutMs, requestBytes: config.serviceRequestBytes,
        }, () => !closing && handles.has(commandKey(id, service.commandId)) && allocations.get(id)?.releasing === false))
        await launchOwned(id, { commandId: service.commandId, command: service.command }, service.deadline)
      } catch (error) {
        await stopGateway(service.id)
        await services.put(service.id, { ...service, ...stoppedExposure(service), state: 'failed', released: commands.get(commandKey(id, service.commandId))?.released ?? true, detail: String(error) }); throw error
      }
      return service
    })
    if (operation === 'run') {
      const command = clusterCommandSchema.parse({ commandId: input.commandId, command: input.command })
      if (/^(?:service|environment|material)-/.test(command.commandId)) throw new Error('Ordinary commands cannot use reserved managed-operation names')
      return launch(id, command)
    }
    throw new Error('unknown node operation')
  }

  async function stopService(service: InferenceService): Promise<InferenceService> {
    const key = commandKey(service.experimentId, service.commandId)
    const pending = await serial(async () => {
      const current = services.get(service.id)
      if (current === undefined) throw new Error('managed service record is missing')
      if (current.released || allocations.get(current.experimentId)?.bootId !== config.bootId) return { done: undefined }
      const handle = handles.get(key)
      if (handle === undefined) return { done: undefined }
      if (current.state !== 'stopping') {
        await stopGateway(current.id)
        await services.put(current.id, { ...current, ...stoppedExposure(current), state: 'stopping', updatedAt: Date.now() })
        handle.terminate()
      }
      return { done: settlements.get(key) }
    })
    await pending.done
    await verifyCleanup(key)
    const current = services.get(service.id)
    if (current === undefined) throw new Error('managed service record is missing')
    return current
  }

  async function verifyCleanup(key: string): Promise<void> {
    const handle = handles.get(key)
    if (handle === undefined || commands.get(key)?.released) return
    if (!await handle.waitForExit(AbortSignal.timeout(config.cleanupTimeoutMs))) return
    await serial(async () => {
      const command = commands.get(key)
      if (command === undefined) throw new Error('managed cleanup record is missing')
      await commands.put(key, { ...command, released: true })
      for (const [id, service] of services.entries()) if (commandKey(service.experimentId, service.commandId) === key) {
        await services.put(id, { ...service, released: true, updatedAt: Date.now(), state: service.state === 'stopping' ? 'stopped' : 'failed' })
      }
      handles.delete(key); clearTimeout(deadlines.get(key)); deadlines.delete(key)
    })
  }

  function launch(id: ExperimentId, raw: unknown, serviceDeadline?: number): Promise<ClusterCommandResult> {
    return serial(() => launchOwned(id, raw, serviceDeadline))
  }

  async function recordEnvironmentStop(key: string, reason: NonNullable<EnvironmentRuntime['stopReason']>): Promise<void> {
    const command = commands.get(key)
    if (command !== undefined && command.commandId.startsWith('material-')) {
      const identity = /^material-([a-f0-9-]{36})(?:-retry-\d+)?$/.exec(command.commandId)
      const parsed = storageOperationIdSchema.safeParse(identity?.[1])
      if (parsed.success) await serial(() => environments.governance(environmentBinding(command.experimentId), 'material-stop', { operationId: parsed.data, reason }))
      return
    }
    if (command === undefined || !command.commandId.startsWith('environment-') || command.commandId.startsWith('environment-cleanup-')) return
    const parsed = environmentOperationIdSchema.safeParse(command.commandId.slice('environment-'.length))
    if (!parsed.success) return
    const operationId = parsed.data
    await serial(async () => {
      const binding = environmentBinding(command.experimentId)
      const runtime = environments.runtime(binding, operationId)
      if (runtime !== undefined && runtime.stopReason === undefined) await environments.recordRuntime(binding,
        environments.originalRequest(binding, operationId), { stopReason: reason })
    })
  }

  async function launchOwned(id: ExperimentId, raw: unknown, serviceDeadline?: number, managed?: { argv: string[]; operationId: string; cleanup?: boolean; material?: boolean }): Promise<ClusterCommandResult> {
      assertStorageSourceAvailable(config.root, id)
      const current = managed?.cleanup === true ? allocations.get(id) : allocation(id)
      if (current === undefined) throw new Error('Original allocation is missing')
      if (managed === undefined && existsSync(environmentFence(id))) {
        const fence = z.object({ operationId: environmentOperationIdSchema }).parse(JSON.parse(readFileSync(environmentFence(id), 'utf8')))
        const plan = environments.reusePlan(environmentBinding(id), fence.operationId)
        throw new Error(`Environment operation ${fence.operationId} (${plan?.stage ?? 'exit-unconfirmed'}) prevents execution; wait for prepare_experiment_environment or recover this original operation`)
      }
      const request = clusterCommandSchema.parse(raw)
      const key = commandKey(id, request.commandId)
      const previous = commands.get(key)
      if (previous !== undefined) {
        if (previous.command !== request.command) throw new Error('command id is bound to different content')
        return commandView(previous)
      }
      if (closing) throw new Error('node is stopping')
      if (current.deadline !== undefined && current.deadline <= Date.now() && serviceDeadline === undefined) throw new Error('experiment runtime budget expired')
      if (current.budget !== undefined && [...commands.entries()].filter(([, row]) => row.experimentId === id).length >= current.budget.maxCommands) throw new Error('node command budget exhausted')
      if (current.node.server.storagePlacement !== undefined) verifyStorage(current.node.server.storagePlacement, 0, managed !== undefined)
      if (managed === undefined && existsSync(resolve(runRoot(id), 'storage-plan.v1.json'))) {
        await environments.governance(environmentBinding(id), 'storage-command-reserve', { commandId: request.commandId })
      }
      const row = { ...request, experimentId: id, state: 'starting' as const, exitCode: null, released: false }
      await commands.put(key, row)
      let handle: SubprocessHandle
      let observation: ObservationWriter
      try {
        mkdirSync(resolve(runRoot(id), 'process-logs', request.commandId), { recursive: true, mode: 0o700 })
        for (const stream of ['stdout', 'stderr'] as const) appendFileSync(processLogPath(id, request.commandId, stream), '', { mode: 0o600 })
        observation = new ObservationWriter(runRoot(id), { version: 1, experimentId: id, serverId: current.node.server.id,
          id: observationSourceIdSchema.parse(`process-${request.commandId}`), kind: 'process', phase: 'execution', commandId: request.commandId,
          label: request.commandId, createdAt: Date.now(), streams: ['stdout', 'stderr'], complete: false })
        const hidden = [...config.hiddenPaths, ...current.node.hiddenPaths, config.root]
        const storageRoots = resolve(config.root, 'state', 'storage-roots')
        if (existsSync(storageRoots)) for (const name of readdirSync(storageRoots)) {
          const owner = z.object({ namespaceRoot: z.string() }).parse(JSON.parse(readFileSync(resolve(storageRoots, name, '.aspera-owner.json'), 'utf8')))
          hidden.push(owner.namespaceRoot)
        }
        const mounts = managed === undefined ? managedEnvironmentMounts(runRoot(id), workspace(id), config.root) : undefined
        const materialPaths = managed === undefined ? materialReadonlyPaths(runRoot(id), config.root) : []
        mounts?.readonlyPaths.push(...materialPaths)
        const argv = managed?.argv ?? experimentSandboxArgv({ backendPath: current.node.backendPath, workspaceRoot: workspace(id),
          devicePaths: current.node.devicePaths, hiddenPaths: hidden, environment: mounts, offlineMaterials: materialPaths.length > 0 }, ['bash', '-c', request.command])
        if (managed !== undefined && !managed.material) await environments.recordLaunch(environmentBinding(id), managed.operationId, 'starting', undefined, request.commandId)
        handle = ctx.subprocess.spawn({ argv: ownedCommandArgv(runRoot(id), { experimentId: id, serverId: current.node.server.id, commandId: request.commandId,
          controlRoot: config.root, deploymentId: current.deploymentId, ...(managed === undefined ? {} : { environmentOperation: managed.operationId, cacheCleanup: managed.cleanup }) }, argv), cwd: workspace(id),
          env: { HOME: workspace(id), PYTHONUNBUFFERED: '1' }, graceMs: managed === undefined ? config.cleanupTimeoutMs : environments.policy.stopTimeoutMs,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
      } catch (error) {
        await commands.put(key, { ...row, state: 'failed', released: true, detail: String(error) })
        if (managed === undefined && existsSync(resolve(runRoot(id), 'storage-plan.v1.json'))) await environments.governance(environmentBinding(id), 'storage-command-settle', { commandId: request.commandId, launchFailureConfirmed: true })
        if (managed !== undefined) ctx.logger.error('Environment manager failed to launch; the operation remains fenced for recovery')
        throw error
      }
      handles.set(key, handle)
      const deadline = serviceDeadline ?? current.deadline
      if (deadline !== undefined) deadlines.set(key, setTimeout(() => {
        void recordEnvironmentStop(key, 'timeout').catch((error: unknown) => { ctx.logger.error(`Environment stop record failed: ${String(error)}`) }).finally(() => { handle.terminate() })
      }, Math.min(Math.max(1, deadline - Date.now()), 2_147_483_647)))
      const append = (chunk: Buffer | string, stream?: 'stdout' | 'stderr') => {
        try {
          appendFileSync(logPath(id), chunk, { mode: 0o600 })
          if (stream !== undefined) appendFileSync(processLogPath(id, request.commandId, stream), chunk, { mode: 0o600 })
          if (stream !== undefined) observation.append(stream, chunk)
        }
        catch (error) { ctx.logger.error(`experiment log failed: ${String(error)}`); handle.terminate() }
      }
      append(`\n[${request.commandId}]\n`)
      handle.stdout?.on('data', (chunk: Buffer) => { append(chunk, 'stdout') })
      handle.stderr?.on('data', (chunk: Buffer) => { append(chunk, 'stderr') })
      const settled = finish(key, handle, managed === undefined ? config.cleanupTimeoutMs : environments.policy.stopTimeoutMs).catch((error: unknown) => { ctx.logger.error(`experiment node: ${String(error)}`) })
        .finally(async () => {
          observation.close(commands.get(key)?.released === true)
          if (managed !== undefined && commands.get(key)?.released === true) {
            const binding = environmentBinding(id)
            if (managed.material === true) {
              await serial(async () => {
                await environments.governance(binding, 'material-settle', { operationId: managed.operationId, exitCode: commands.get(key)?.exitCode ?? null })
                clearEnvironmentFence(id, managed.operationId)
              })
            } else if (managed.cleanup === true) {
              if (environments.cleanupResult(binding, managed.operationId) !== undefined) clearEnvironmentFence(id, managed.operationId)
            } else await serial(async () => {
              const original = environments.originalRequest(binding, managed.operationId)
              let receipt = environments.receipt(binding, original)
              if (!receipt.exitConfirmed) receipt = await environments.recover(binding, original, false)
              if (receipt.exitConfirmed) {
                await environments.recordLaunch(binding, managed.operationId, 'exited')
                await environments.recordRuntime(binding, original, { exitConfirmed: true, exitCode: commands.get(key)?.exitCode ?? null, admissionReleased: true })
                clearEnvironmentFence(id, managed.operationId)
              }
            })
          }
          if (commands.get(key)?.released === true && existsSync(resolve(config.root, 'state/storage-governance-v1/reservations'))) {
            await environments.governance(environmentBinding(id), 'storage-command-settle', { commandId: request.commandId })
          }
        }).catch((error: unknown) => { ctx.logger.error(`Environment exit verification failed: ${String(error)}`) }).finally(() => { settlements.delete(key) })
      settlements.set(key, settled)
      try {
        await commands.put(key, { ...row, state: 'running' })
        if (managed !== undefined && !managed.material) await environments.recordLaunch(environmentBinding(id), managed.operationId, 'started', undefined, request.commandId)
      }
      catch (error) { handle.terminate(); throw error }
      return commandView({ ...row, state: 'running' })
  }
}
