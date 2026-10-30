/** Node-owned environment operations use the existing managed-process lifetime and independent v1 files. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, lstatSync, statSync } from 'node:fs'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { resolve, dirname, isAbsolute, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import s from '@deepseek-ai/schemastery'
import { prepareExperimentEnvironmentSchema, experimentEnvironmentSchema, environmentOperationSchema, environmentStorageNodeSchema,
  experimentCachePreviewSchema, environmentOperationIdSchema, experimentCacheResultSchema, environmentLaunchSchema,
  environmentCleanupSchema, environmentRecoverySchema, environmentRuntimeSchema, environmentReusePlanSchema,
  prepareExperimentMaterialsSchema, materialOperationSchema, storageOperationIdSchema, storageEvidenceContextSchema } from '@aspera/experiments'
import type { MaterialOperation } from '@aspera/experiments'
import type { ClusterNode, ExperimentId, PrepareExperimentEnvironment, EnvironmentOperation, EnvironmentStorageNode,
  ExperimentCachePreview, ExperimentCacheResult, EnvironmentLaunch, EnvironmentRuntime, EnvironmentReusePlan } from '@aspera/experiments'
import { serverRunRoot } from './storage.ts'
import { experimentSandboxArgv } from './experiment-sandbox.ts'
import { storageGovernancePolicySchema, StorageGovernancePolicyConfig, readBorrowedEnvironments, managedTrainingWorkspace } from './storage-governance.ts'
import type { StorageGovernancePolicy } from './storage-governance.ts'

/** A failed read retains its diagnostic location separately from its repeatable failure description. */
export class EnvironmentInspectionError extends Error {
  /** @param detail - observed failure without an attempt-specific diagnostic path. @param diagnostics - saved stdout, stderr and exit records. */
  constructor(readonly detail: string, readonly diagnostics: string) {
    super(detail + '; diagnostics: ' + diagnostics)
  }
}

/** Deployment-varying installer, space and scanner bounds. */
export const managedEnvironmentPolicySchema = z.object({ uvVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('0.13.0'),
  pipVersion: z.string().regex(/^\d+\.\d+(?:\.\d+)?$/).default('26.2.1'),
  uvPath: z.string().startsWith('/').default('/usr/local/bin/uv'), pythonPath: z.string().startsWith('/').default('/usr/bin/python3'),
  timeoutMs: z.number().int().min(1000).max(2147483647).default(1800000), readTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  minimumFreeBytes: z.number().int().nonnegative().default(1073741824), maxPackageBytes: z.number().int().positive().default(17179869184),
  maxPackageFiles: z.number().int().min(1).max(1000000).default(200000), legacyCandidateLimit: z.number().int().min(1).max(10000).default(256),
  readBytes: z.number().int().min(65536).max(32000000).default(8388608), storageIntervalMs: z.number().int().min(1000).default(30000),
  stopTimeoutMs: z.number().int().min(1000).default(30000), legacyScanDepth: z.number().int().min(1).max(32).default(16),
  legacyRunLimit: z.number().int().min(1).max(10000).default(128),
  legacyEntryLimit: z.number().int().min(1).max(10000000).default(100000),
  operationPollIntervalMs: z.number().int().min(100).default(1000),
  operationReconnectTimeoutMs: z.number().int().min(1000).max(600000).default(60000),
  governance: storageGovernancePolicySchema.optional(),
}).strict().refine(value => storageGovernancePolicySchema.parse(value.governance ?? {}).metadataProbeTimeoutMs < value.readTimeoutMs,
  'Canonical metadata probe timeout must be shorter than the outer environment read timeout')
  .refine(value => storageGovernancePolicySchema.parse(value.governance ?? {}).scanTimeoutMs < value.readTimeoutMs,
    'Storage scan page timeout must be shorter than the outer environment read timeout')
/** Resolved node policy supplied by profile configuration. */
export type ManagedEnvironmentPolicy = z.infer<typeof managedEnvironmentPolicySchema>
/**
 * Keep unsupported settings out of older fixed releases' strict configuration readers.
 * @param policy - resolved local installer policy.
 * @param supportsInstallerV3 - capability of the selected immutable release.
 * @param supportsStorage - release supports the storage-governance settings.
 * @param supportsPurposeStorage - release supports business storage format 0.1.0 settings.
 * @returns only settings understood by that release.
 */
export function managedEnvironmentPolicyForRelease(policy: ManagedEnvironmentPolicy, supportsInstallerV3: boolean, supportsStorage = false, supportsPurposeStorage = false, supportsTargetedMaterials = false): Omit<ManagedEnvironmentPolicy, 'pipVersion' | 'governance'> & { pipVersion?: string; governance?: Omit<StorageGovernancePolicy, 'systemReserveBytes' | 'systemReserveRatio' | 'dataReserveBytes' | 'dataReserveRatio' | 'peakSafetyFactor' | 'capacityRecheckMs' | 'metadataProbeTimeoutMs'> } {
  const { pipVersion, governance, ...previous } = policy
  const { metadataProbeTimeoutMs: _probe, ...compatible } = governance ?? storageGovernancePolicySchema.parse({})
  const { systemReserveBytes: _systemBytes, systemReserveRatio: _systemRatio, dataReserveBytes: _dataBytes, dataReserveRatio: _dataRatio,
    peakSafetyFactor: _peak, capacityRecheckMs: _recheck, ...legacy } = compatible
  return { ...previous, ...(supportsInstallerV3 ? { pipVersion } : {}), ...(supportsStorage && governance !== undefined ? { governance: supportsPurposeStorage ? supportsTargetedMaterials ? governance : compatible : legacy } : {}) }
}
/** Profile settings for both the manager and Host's bounded read-only storage observations. */
export const ManagedEnvironmentPolicyConfig: s<ManagedEnvironmentPolicy> = s.object({
  uvVersion: s.string().default('0.13.0'), uvPath: s.string().default('/usr/local/bin/uv'), pythonPath: s.string().default('/usr/bin/python3'),
  pipVersion: s.string().default('26.2.1'),
  timeoutMs: s.number().step(1).min(1000).default(1800000), readTimeoutMs: s.number().step(1).min(1000).max(120000).default(30000),
  minimumFreeBytes: s.number().step(1).min(0).default(1073741824), maxPackageBytes: s.number().step(1).min(1).default(17179869184),
  maxPackageFiles: s.number().step(1).min(1).max(1000000).default(200000), legacyCandidateLimit: s.number().step(1).min(1).max(10000).default(256),
  readBytes: s.number().step(1).min(65536).max(32000000).default(8388608), storageIntervalMs: s.number().step(1).min(1000).default(30000),
  stopTimeoutMs: s.number().step(1).min(1000).default(30000), legacyScanDepth: s.number().step(1).min(1).max(32).default(16),
  legacyRunLimit: s.number().step(1).min(1).max(10000).default(128),
  legacyEntryLimit: s.number().step(1).min(1).max(10000000).default(100000),
  operationPollIntervalMs: s.number().step(1).min(100).default(1000),
  operationReconnectTimeoutMs: s.number().step(1).min(1000).max(600000).default(60000),
  governance: StorageGovernancePolicyConfig,
})

/** Program-resolved allocation; tools cannot supply placement or device grants. */
export type ManagedEnvironmentBinding = { experimentId: ExperimentId; node: ClusterNode; deploymentId: string; controlRoot: string; hiddenPaths: string[] }
type Binding = ManagedEnvironmentBinding
function readManagedJson(path: string): unknown {
  let checked = resolve(path)
  for (;;) {
    if (lstatSync(checked).isSymbolicLink()) throw new Error('Managed record contains a symbolic link')
    const parent = dirname(checked)
    if (parent === checked) break
    checked = parent
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}
/** @returns the shipped helper for read-only SSH observations and confirmed reference release. */
export function managedEnvironmentProgram(): string {
  return ['storage-placement.py', 'environment-repair.py', 'wheel-metadata.py', 'manager-cache.py', 'input-sharing.py', 'storage-governance.py', 'storage-reuse.py', 'storage-preflight.py', 'managed-environment.py']
    .map(name => readFileSync(new URL('../scripts/' + name, import.meta.url), 'utf8')).join('\n')
}
/** Trusted helper inputs include saved placement, fixed tools and the actual sandbox argv. */
export function managedEnvironmentConfig(binding: Binding, policy: ManagedEnvironmentPolicy, action: string) {
  const placement = binding.node.server.storagePlacement
  if (placement === undefined || placement.experimentId !== binding.experimentId || placement.serverId !== binding.node.server.id) {
    throw new Error('Managed environments require the original saved storage placement')
  }
  const argv = experimentSandboxArgv({ backendPath: binding.node.backendPath, workspaceRoot: placement.workspaceRoot,
    devicePaths: binding.node.devicePaths, hiddenPaths: binding.hiddenPaths }, ['true'])
  return { action, placement, policy, serverName: binding.node.server.name, deploymentId: binding.deploymentId, reuseVerificationVersion: 1, repairVersion: 1, storagePreflightVersion: 2, managerCacheVersion: 1, inputSharingVersion: 1, releaseAssetSharingVersion: 1,
    uvPath: policy.uvPath, pythonPath: policy.pythonPath, backendPath: binding.node.backendPath, devicePaths: binding.node.devicePaths,
    gpuInfo: binding.node.gpuInfo, sandboxBase: argv.slice(0, -2), governancePolicy: storageGovernancePolicySchema.parse(policy.governance ?? {}) }
}

/**
 * Read published roots for confinement; manifests are outside the model-writable workspace.
 * @param runRoot - pinned private experiment directory. @param workspace - pinned workspace. @param controlRoot - trusted node root for separately registered training storage.
 * @returns immutable environment mounts, detached files, private residue masks and registered Python commands.
 */
export function managedEnvironmentMounts(runRoot: string, workspace: string, controlRoot?: string): { readonlyPaths: string[]; writablePaths: string[]; hiddenPaths: string[]; python?: string } {
  workspace = managedTrainingWorkspace(runRoot, workspace, controlRoot)
  const root = resolve(runRoot, 'environments-v1')
  const hiddenPaths: string[] = []
  const hideResidue = (path: string) => {
    const entry = lstatSync(path, { throwIfNoEntry: false })
    if (entry === undefined) return
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Private environment residue is not a real directory')
    let checked = path
    for (;;) {
      if (lstatSync(checked).isSymbolicLink()) throw new Error('Private environment residue contains a symbolic link')
      if (checked === resolve(workspace)) break
      checked = dirname(checked)
    }
    if (!hiddenPaths.includes(path)) hiddenPaths.push(path)
  }
  const cleanupRoot = resolve(runRoot, 'environment-cleanups-v1')
  if (existsSync(cleanupRoot)) {
    for (const name of readdirSync(cleanupRoot).filter(name => name.endsWith('.json'))) {
      const cleanup = environmentCleanupSchema.parse(readManagedJson(resolve(cleanupRoot, name)))
      const owner = z.object({ version: z.literal(1), experimentId: z.string(), serverId: z.string() }).strict().parse(readManagedJson(resolve(runRoot, '.aspera-owner.json')))
      if (cleanup.experimentId !== owner.experimentId || cleanup.serverId !== owner.serverId
        || cleanup.paths.length !== 1 || cleanup.paths[0] !== resolve(workspace, 'tmp', 'environment-' + cleanup.operationId)) throw new Error('Temporary cleanup record escaped its experiment')
      if (cleanup.state === 'blocked') throw new Error('Managed environment cleanup safety remains blocked: ' + (cleanup.detail ?? cleanup.operationId))
      if (cleanup.state !== 'completed') hideResidue(cleanup.paths[0]!)
    }
  }
  const requests = resolve(runRoot, 'environment-requests-v1')
  if (existsSync(requests)) {
    for (const name of readdirSync(requests).filter(name => name.endsWith('.json'))) {
      const id = environmentOperationIdSchema.parse(name.slice(0, -5))
      const path = resolve(workspace, 'tmp', 'environment-' + id)
      hideResidue(path)
    }
  }
  const values = existsSync(root) ? readdirSync(root).filter(name => name.endsWith('.json')).map(name => experimentEnvironmentSchema.parse(readManagedJson(resolve(root, name)))) : []
  const loans = readBorrowedEnvironments(runRoot, controlRoot)
  const readonlyPaths: string[] = loans.flatMap(value => value.readonlyPaths); const writablePaths: string[] = []
  for (const environment of values) {
    if (environment.state !== 'ready' || environment.verification?.verified !== true) throw new Error('Managed environment requires program verification before execution')
    const rel = relative(workspace, environment.directory)
    if (rel === '' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Managed environment escaped the experiment workspace')
    if (hiddenPaths.some(path => environment.directory === path || environment.directory.startsWith(path + sep))) throw new Error('Published environment overlaps private operation residue')
    const owner = z.object({ version: z.literal(1), experimentId: z.string(), serverId: z.string() }).strict().parse(readManagedJson(resolve(runRoot, '.aspera-owner.json')))
    if (owner.experimentId !== environment.experimentId || owner.serverId !== environment.serverId) throw new Error('Managed environment belongs to another experiment or node')
    let checked = environment.directory
    for (;;) {
      if (lstatSync(checked).isSymbolicLink()) throw new Error('Managed environment contains a symbolic link')
      if (checked === resolve(workspace)) break
      checked = dirname(checked)
    }
    const marker = z.object({ version: z.literal(1), generation: z.uuid(), environmentId: z.string() }).strict()
      .parse(readManagedJson(resolve(environment.directory, '.aspera-environment.json')))
    if (marker.generation !== environment.generation || marker.environmentId !== environment.environmentId) throw new Error('Managed environment publication identity changed')
    readonlyPaths.push(environment.directory)
    const site = readdirSync(resolve(environment.directory, 'lib')).filter(name => /^python\d+\.\d+$/.test(name))
    if (site.length !== 1) throw new Error('Managed Python library directory is unconfirmed')
    for (const name of environment.privateFiles) {
      if (!environment.packages.some(packageRow => packageRow.modified && packageRow.files.includes(name))) throw new Error('Writable package file is not registered')
      const path = resolve(environment.directory, 'lib', site[0]!, 'site-packages', name)
      let current = dirname(path)
      while (current !== environment.directory) {
        if (lstatSync(current).isSymbolicLink()) throw new Error('Detached file escaped its registered package')
        current = dirname(current)
      }
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Detached package file identity changed')
      writablePaths.push(path)
    }
  }
  const selected = values.find(value => value.environmentId === 'training') ?? values[0]
  const borrowed = loans.find(value => value.environmentId === 'training') ?? loans[0]
  return { readonlyPaths, writablePaths, hiddenPaths, ...(selected === undefined ? borrowed === undefined ? {} : { python: borrowed.python } : { python: selected.python }) }
}

/** Trusted request construction and read-only helper calls for one node control. */
export class ManagedEnvironments {
  readonly policy: ManagedEnvironmentPolicy
  constructor(private readonly ctx: Context, policy?: ManagedEnvironmentPolicy) { this.policy = managedEnvironmentPolicySchema.parse(policy ?? {}) }

  /** @param binding - saved allocation. @param operationId - original operation. @returns its original deadline and observed exit, when supported. */
  runtime(binding: Binding, operationId: string): EnvironmentRuntime | undefined {
    const path = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'environment-runtime-v1', environmentOperationIdSchema.parse(operationId) + '.json')
    if (!existsSync(path)) return undefined
    const value = environmentRuntimeSchema.parse(readManagedJson(path))
    if (value.experimentId !== binding.experimentId || value.serverId !== binding.node.server.id || value.operationId !== operationId
      || value.deploymentId !== binding.deploymentId) throw new Error('Environment runtime belongs to another operation or release')
    return value
  }

  /** Caller serializes node mutations. @param binding - allocation. @param request - original request. @param patch - observed lifetime changes. @returns the durably saved runtime. */
  async recordRuntime(binding: Binding, request: PrepareExperimentEnvironment, patch: Partial<Pick<EnvironmentRuntime, 'stopReason' | 'exitConfirmed' | 'exitCode' | 'admissionReleased' | 'detail'>> = {}): Promise<EnvironmentRuntime> {
    const original = this.runtime(binding, request.operationId)
    const time = Date.now()
    const value = environmentRuntimeSchema.parse({ version: 1, experimentId: binding.experimentId, serverId: binding.node.server.id,
      operationId: request.operationId, environmentId: request.environmentId, deploymentId: binding.deploymentId,
      startedAt: time, deadline: time + this.policy.timeoutMs, exitConfirmed: false, exitCode: null, admissionReleased: false,
      ...original, ...patch, updatedAt: time })
    await writeFileAtomic(resolve(serverRunRoot(binding.node.server, binding.experimentId), 'environment-runtime-v1', request.operationId + '.json'), JSON.stringify(value), { mode: 0o600 })
    return value
  }

  /** @param binding - saved allocation. @param operationId - original request. @returns a small atomic progress file, without hashing dependencies. */
  reusePlan(binding: Binding, operationId: string): EnvironmentReusePlan | undefined {
    const path = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'environment-operations-v1', environmentOperationIdSchema.parse(operationId), 'reuse-plan.v1.json')
    if (!existsSync(path)) return undefined
    const value = environmentReusePlanSchema.parse(readManagedJson(path))
    if (value.experimentId !== binding.experimentId || value.serverId !== binding.node.server.id || value.operationId !== operationId) throw new Error('Environment reuse plan belongs to another operation')
    return value
  }

  /** @param binding - saved node ownership. @param raw - checked operation. @param evidenceContext - original approved plan and execution Session. @returns an owned manager command and a stable request file. */
  command(binding: Binding, raw: PrepareExperimentEnvironment, evidenceContext?: z.infer<typeof storageEvidenceContextSchema>): { argv: string[]; commandId: string } {
    const request = prepareExperimentEnvironmentSchema.parse(raw)
    const run = serverRunRoot(binding.node.server, binding.experimentId)
    const folder = resolve(run, 'environment-requests-v1')
    mkdirSync(folder, { recursive: true, mode: 0o700 })
    const path = resolve(folder, request.operationId + '.json')
    const value = JSON.stringify({ ...managedEnvironmentConfig(binding, this.policy, 'prepare'), request,
      ...(evidenceContext === undefined ? {} : { evidenceContext }) })
    if (existsSync(path)) {
      const original = z.object({ request: prepareExperimentEnvironmentSchema, deploymentId: z.string(), evidenceContext: storageEvidenceContextSchema.optional(),
        placement: z.object({ experimentId: z.string(), serverId: z.string(), workspaceRoot: z.string() }) }).parse(readManagedJson(path))
      if (JSON.stringify(original.request) !== JSON.stringify(request) || original.deploymentId !== binding.deploymentId
        || original.placement.experimentId !== binding.experimentId || original.placement.serverId !== binding.node.server.id
        || original.placement.workspaceRoot !== binding.node.server.storagePlacement?.workspaceRoot
        || JSON.stringify(original.evidenceContext) !== JSON.stringify(evidenceContext)) throw new Error('Environment operation identity is bound to different content or evidence context')
    } else writeFileSync(path, value, { flag: 'wx', mode: 0o600 })
    return { argv: [this.policy.pythonPath, fileURLToPath(new URL('../scripts/managed-environment.py', import.meta.url)), path], commandId: 'environment-' + request.operationId }
  }

  /** @param binding - saved node. @param request - operation identity. @returns the committed receipt or pending state. */
  receipt(binding: Binding, request: PrepareExperimentEnvironment): EnvironmentOperation {
    const run = serverRunRoot(binding.node.server, binding.experimentId)
    const path = resolve(run, 'environment-operations-v1', request.operationId, 'receipt.v1.json')
    if (existsSync(path)) {
      const value = environmentOperationSchema.parse(readManagedJson(path))
      if (value.experimentId !== binding.experimentId || value.serverId !== binding.node.server.id || value.operationId !== request.operationId) throw new Error('Environment receipt belongs to another operation')
      const cleanupPath = resolve(run, 'environment-cleanups-v1', request.operationId + '.json')
      const recoveryPath = resolve(run, 'environment-recoveries-v1', request.operationId + '.json')
      const cleanup = existsSync(cleanupPath) ? environmentCleanupSchema.parse(readManagedJson(cleanupPath)) : undefined
      const recovery = existsSync(recoveryPath) ? environmentRecoverySchema.parse(readManagedJson(recoveryPath)) : undefined
      for (const record of [cleanup, recovery]) {
        if (record !== undefined && (record.experimentId !== binding.experimentId || record.serverId !== binding.node.server.id
          || record.operationId !== request.operationId || record.environmentId !== request.environmentId)) throw new Error('Environment recovery or cleanup belongs to another operation')
      }
      return { ...value, ...(cleanup === undefined ? {} : { cleanup }), ...(recovery === undefined ? {} : {
        recovery, exitConfirmed: true, state: 'blocked', detail: recovery.detail,
      }) }
    }
    return { version: 1, experimentId: binding.experimentId, serverId: binding.node.server.id, operationId: request.operationId,
      environmentId: request.environmentId, requestHash: createHash('sha256').update(JSON.stringify(request)).digest('hex'), action: request.action,
      state: 'requested', commandId: 'environment-' + request.operationId,
      startedAt: Math.floor(statSync(resolve(run, 'environment-requests-v1', request.operationId + '.json')).mtimeMs),
      updatedAt: Math.floor(statSync(resolve(run, 'environment-requests-v1', request.operationId + '.json')).mtimeMs), exitConfirmed: false, exitCode: null }
  }

  /** @param binding - original allocation. @param operationId - saved request. @returns checked startup evidence, or absent for older operations. */
  launch(binding: Binding, operationId: string): EnvironmentLaunch | undefined {
    const path = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'environment-launches-v1', environmentOperationIdSchema.parse(operationId) + '.json')
    if (!existsSync(path)) return undefined
    const value = environmentLaunchSchema.parse(readManagedJson(path))
    if (value.experimentId !== binding.experimentId || value.serverId !== binding.node.server.id || value.operationId !== operationId
      || value.deploymentId !== binding.deploymentId || !['environment-' + operationId, 'environment-cleanup-' + operationId].includes(value.commandId)) throw new Error('Environment startup evidence belongs to another operation')
    return value
  }

  /** @param binding - original allocation. @param operationId - saved request. @param state - observed spawn stage. @param detail - diagnostic. @param commandId - owned environment or cleanup command. @returns durable startup evidence. */
  async recordLaunch(binding: Binding, operationId: string, state: EnvironmentLaunch['state'], detail?: string, commandId?: string): Promise<EnvironmentLaunch> {
    const previous = this.launch(binding, operationId)
    const command = commandId ?? previous?.commandId ?? 'environment-' + operationId
    if (previous !== undefined && previous.commandId !== command) throw new Error('Startup operation identity is already bound to another command')
    const value = environmentLaunchSchema.parse({ version: 1, experimentId: binding.experimentId, serverId: binding.node.server.id,
      operationId, commandId: command, deploymentId: binding.deploymentId, state,
      createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now(), ...(detail === undefined ? {} : { detail }) })
    const path = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'environment-launches-v1', operationId + '.json')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    await writeFileAtomic(path, JSON.stringify(value), { mode: 0o600 })
    return value
  }

  /** @param binding - original node. @returns all retained operations, including unresolved installer outcomes. */
  operations(binding: Binding): EnvironmentOperation[] {
    const folder = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'environment-requests-v1')
    if (!existsSync(folder)) return []
    return readdirSync(folder).filter(name => name.endsWith('.json')).map(name => {
      const request = z.object({ request: prepareExperimentEnvironmentSchema }).parse(readManagedJson(resolve(folder, name))).request
      return this.receipt(binding, request)
    })
  }

  /** @param binding - original node. @param request - original content. @param launchFailureConfirmed - node's settled launch failure. @returns recovered receipt after Linux process-group proof. */
  async recover(binding: Binding, request: PrepareExperimentEnvironment, launchFailureConfirmed: boolean): Promise<EnvironmentOperation> {
    return environmentOperationSchema.parse(await this.read({ ...managedEnvironmentConfig(binding, this.policy, 'recover'), request, launchFailureConfirmed }))
  }

  /** @param binding - original node. @param operationId - stable cleanup ID. @returns committed cleanup result, or absent while its manager runs. */
  cleanupResult(binding: Binding, operationId: string): ExperimentCacheResult['nodes'][number] | undefined {
    const path = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'environment-operations-v1', 'cleanup-' + environmentOperationIdSchema.parse(operationId) + '.json')
    if (!existsSync(path)) return undefined
    const saved = z.object({ state: z.string(), result: experimentCacheResultSchema.shape.nodes.element.optional() }).parse(readManagedJson(path))
    return saved.result
  }

  /** @param binding - original node. @param operationId - previously stored ID. @returns validated original model request. */
  originalRequest(binding: Binding, operationId: string): PrepareExperimentEnvironment {
    const path = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'environment-requests-v1', environmentOperationIdSchema.parse(operationId) + '.json')
    return z.object({ request: prepareExperimentEnvironmentSchema }).parse(readManagedJson(path)).request
  }
  /** @param binding - original allocation. @param operationId - saved operation. @param fingerprint - original preview. @param launchFailureConfirmed - settled node launch result. @returns cleanup outcome after process-group exit proof. */
  async recoverCleanup(binding: Binding, operationId: string, fingerprint: string, launchFailureConfirmed: boolean): Promise<ExperimentCacheResult['nodes'][number]> {
    return experimentCacheResultSchema.shape.nodes.element.parse(await this.read({ ...managedEnvironmentConfig(binding, this.policy, 'recover-cleanup'),
      operationId: environmentOperationIdSchema.parse(operationId), fingerprint, launchFailureConfirmed }))
  }
  /** @param binding - original allocation. @param operationId - retained cleanup ID. @returns its saved preview digest without creating a request. */
  cleanupFingerprint(binding: Binding, operationId: string): string {
    const path = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'environment-cleanup-requests-v1', environmentOperationIdSchema.parse(operationId) + '.json')
    return z.object({ fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).parse(readManagedJson(path)).fingerprint
  }

  /** @param binding - original node. @param signal - bounded read lifetime. @returns actual space and environment observations. */
  async inspect(binding: Binding, signal?: AbortSignal): Promise<EnvironmentStorageNode> {
    return environmentStorageNodeSchema.parse(await this.read({ ...managedEnvironmentConfig(binding, this.policy, 'inspect') }, signal))
  }

  /** @param binding - original allocation. @param requiredEnvironments - execution-record environment names or paths. @returns fresh payload and registration checks. */
  async acceptance(binding: Binding, requiredEnvironments: readonly string[] = []): Promise<{ verified: boolean; environments: number }> {
    return z.object({ verified: z.boolean(), environments: z.number().int().nonnegative() }).strict()
      .parse(await this.read({ ...managedEnvironmentConfig(binding, this.policy, 'acceptance'), requiredEnvironments }))
  }

  /** @param binding - original node. @param signal - read lifetime. @returns the current program-generated cleanup snapshot. */
  async preview(binding: Binding, signal?: AbortSignal): Promise<ExperimentCachePreview['nodes'][number]> {
    const value = await this.read({ ...managedEnvironmentConfig(binding, this.policy, 'preview') }, signal)
    return experimentCachePreviewSchema.shape.nodes.element.parse(value)
  }

  /** @param binding - original node. @param operationId - repeated cleanup identity. @param fingerprint - preview digest. @returns owned cleanup argv. */
  cleanupCommand(binding: Binding, operationId: string, fingerprint: string, candidateIds?: string[], referenceRepairIds?: string[]): { argv: string[]; commandId: string } {
    const id = environmentOperationIdSchema.parse(operationId)
    const path = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'environment-cleanup-requests-v1', id + '.json')
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const value = JSON.stringify({ ...managedEnvironmentConfig(binding, this.policy, 'cleanup'), operationId: id, fingerprint,
      ...(candidateIds === undefined ? {} : { candidateIds: [...candidateIds].sort() }),
      ...(referenceRepairIds === undefined ? {} : { referenceRepairIds: [...referenceRepairIds].sort() }) })
    if (existsSync(path)) {
      const original = z.object({ operationId: environmentOperationIdSchema, fingerprint: z.string(), deploymentId: z.string(), candidateIds: z.array(z.string()).optional(),
        referenceRepairIds: z.array(z.string()).optional(),
        placement: z.object({ experimentId: z.string(), serverId: z.string(), workspaceRoot: z.string() }) }).parse(readManagedJson(path))
      if (original.operationId !== id || original.fingerprint !== fingerprint || original.deploymentId !== binding.deploymentId
        || original.placement.experimentId !== binding.experimentId || original.placement.serverId !== binding.node.server.id
        || original.placement.workspaceRoot !== binding.node.server.storagePlacement?.workspaceRoot
        || JSON.stringify(original.candidateIds) !== JSON.stringify(candidateIds === undefined ? undefined : [...candidateIds].sort())
        || JSON.stringify(original.referenceRepairIds) !== JSON.stringify(referenceRepairIds === undefined ? undefined : [...referenceRepairIds].sort())) throw new Error('Cleanup identity is bound to another preview or selection')
    }
    else writeFileSync(path, value, { flag: 'wx', mode: 0o600 })
    return { argv: [this.policy.pythonPath, fileURLToPath(new URL('../scripts/managed-environment.py', import.meta.url)), path], commandId: 'environment-cleanup-' + id }
  }

  /** @param binding - authenticated allocation. @param action - storage service operation. @param input - validated operation fields. @param signal - request lifetime. @returns program observations or a persisted operation result. */
  async governance(binding: Binding, action: string, input: object = {}, signal?: AbortSignal): Promise<unknown> {
    return this.read({ ...managedEnvironmentConfig(binding, this.policy, action), ...input }, signal)
  }

  /** @param binding - allocated destination. @param input - validated content-bound request. @returns durable material manager argv and original lifetime. */
  materialCommand(binding: Binding, input: object, evidenceContext?: { sessionId: string; planRevision: number }): { argv: string[]; commandId: string; deadline: number; registration: object } {
    const request = prepareExperimentMaterialsSchema.parse(input)
    const root = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'material-requests-v1')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    const path = resolve(root, request.operationId + '.json')
    const value = { ...managedEnvironmentConfig(binding, this.policy, 'material-prepare'), request, materialCommandId: 'material-' + request.operationId,
      deadline: Date.now() + storageGovernancePolicySchema.parse(this.policy.governance ?? {})[request.action === 'verify' ? 'verificationTimeoutMs' : 'materialTimeoutMs'],
      ...(evidenceContext === undefined ? {} : { evidenceContext }) }
    if (existsSync(path)) {
      const original = z.object({ request: prepareExperimentMaterialsSchema, deadline: z.number().int(), placement: z.object({ experimentId: z.string(), serverId: z.string() }) }).parse(readManagedJson(path))
      if (original.placement.experimentId !== binding.experimentId || original.placement.serverId !== binding.node.server.id
        || original.request.materialId !== request.materialId || original.request.budgetId !== request.budgetId || original.request.reuseCandidateId !== request.reuseCandidateId
        || request.action !== 'recover' && original.request.action !== request.action) throw new Error('Material operation belongs to different content')
      value.deadline = original.deadline
      if (request.action === 'recover') {
        const attempt = readdirSync(root).filter(name => name.startsWith(request.operationId + '.attempt-')).length + 1
        value.materialCommandId += '-retry-' + attempt
        const retry = resolve(root, request.operationId + '.attempt-' + attempt + '.json')
        writeFileSync(retry, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
        return { argv: [this.policy.pythonPath, fileURLToPath(new URL('../scripts/managed-environment.py', import.meta.url)), retry],
          commandId: value.materialCommandId, deadline: value.deadline, registration: { request, deadline: value.deadline, materialCommandId: value.materialCommandId, ...(evidenceContext === undefined ? {} : { evidenceContext }) } }
      }
    } else writeFileSync(path, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    return { argv: [this.policy.pythonPath, fileURLToPath(new URL('../scripts/managed-environment.py', import.meta.url)), path],
      commandId: value.materialCommandId, deadline: value.deadline, registration: { request, deadline: value.deadline, materialCommandId: value.materialCommandId, ...(evidenceContext === undefined ? {} : { evidenceContext }) } }
  }

  /** @param binding - allocated destination. @param operationId - original material acquisition. @returns its immutable request after checking allocation identity. */
  materialOriginal(binding: Binding, operationId: string): z.infer<typeof prepareExperimentMaterialsSchema> {
    const path = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'material-requests-v1', storageOperationIdSchema.parse(operationId) + '.json')
    const saved = z.object({ request: prepareExperimentMaterialsSchema, deploymentId: z.string(), placement: z.object({ experimentId: z.string(), serverId: z.string() }) }).parse(readManagedJson(path))
    if (saved.placement.experimentId !== binding.experimentId || saved.placement.serverId !== binding.node.server.id || saved.deploymentId !== binding.deploymentId) throw new Error('Material request belongs to another allocation')
    return saved.request
  }

  /** @param binding - allocated destination. @param operationId - original material acquisition. @returns persisted progress without reading weight contents. */
  materialStatus(binding: Binding, operationId: string): MaterialOperation | undefined {
    const root = resolve(serverRunRoot(binding.node.server, binding.experimentId), 'material-operations-v1', operationId)
    const path = resolve(root, 'receipt.v1.json')
    if (!existsSync(path)) return undefined
    const value = materialOperationSchema.parse(readManagedJson(path))
    if (value.experimentId !== binding.experimentId || value.serverId !== binding.node.server.id || value.operationId !== operationId) throw new Error('Material progress belongs to another experiment')
    return value
  }

  private async read<T extends ReturnType<typeof managedEnvironmentConfig>>(value: T, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.policy.readTimeoutMs)
    const child = this.ctx.subprocess.spawn({ argv: [this.policy.pythonPath, fileURLToPath(new URL('../scripts/managed-environment.py', import.meta.url))],
      cwd: process.cwd(), signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]), graceMs: this.policy.readTimeoutMs,
      env: { PYTHONDONTWRITEBYTECODE: '1' }, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } })
    let output = ''; let error = ''; let outputLimited = false
    const limit = () => { outputLimited = true; child.terminate() }
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); if (Buffer.byteLength(output) > this.policy.readBytes) limit() })
    child.stderr?.on('data', (chunk: Buffer) => { error += chunk.toString('utf8'); if (Buffer.byteLength(error) > this.policy.readBytes) limit() })
    child.stdin?.end(JSON.stringify(value))
    const exit = await child.done
    const exitConfirmed = await child.waitForExit(AbortSignal.timeout(this.policy.readTimeoutMs))
    if (!exitConfirmed || exit.exitCode !== 0 || timeout.aborted || signal?.aborted || outputLimited) {
      const reason = signal?.aborted ? 'cancelled' : timeout.aborted ? 'read-timeout' : outputLimited ? 'output-limit' : !exitConfirmed ? 'exit-unconfirmed' : 'process-failed'
      const directory = resolve(value.placement.runRoot, 'environment-read-diagnostics-v1', randomUUID())
      await writeFileAtomic(resolve(directory, 'stderr.log'), error, { mode: 0o600 })
      await writeFileAtomic(resolve(directory, 'stdout.log'), output, { mode: 0o600 })
      await writeFileAtomic(resolve(directory, 'result.v1.json'), JSON.stringify({ version: 1, experimentId: value.placement.experimentId,
        serverId: value.placement.serverId, action: value.action, reason, checkedAt: Date.now(), exitConfirmed, exit }), { mode: 0o600 })
      throw new EnvironmentInspectionError(`Environment inspection ${reason}: ${error || output}`, directory)
    }
    return JSON.parse(output)
  }
}
