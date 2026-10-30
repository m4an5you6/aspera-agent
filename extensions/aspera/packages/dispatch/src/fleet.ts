import type {} from '@aspera/runtime'
/** Local server registry, independent dispatch Sessions, and immutable cluster submissions. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, statSync, appendFileSync } from 'node:fs'
import { basename, isAbsolute, resolve, sep } from 'node:path'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  CLUSTER_HANDOVER, clusterChunkSchema, clusterFileHash, clusterFileSchema, clusterRecordSchema, clusterServerSchema,
  clusterSubmissionV2Schema, clusterSubmissionV4Schema, experimentIdSchema, serverIdSchema, answerExperimentQuestionSchema,
  serverSettingsSchema, inspectServerStorage, prepareServerStorage, verifyServerStorage, cleanupServerStorage, serviceAccessInfoSchema,
} from '@aspera/runtime'
import type { ClusterChunk, ClusterFile, ClusterNode, ClusterPrivate, ClusterRecord, ClusterServer, ClusterSubmission, ExperimentId, ExperimentServerId, ServerSettings, ServerProbe } from '@aspera/runtime'
import { copy, remote, remoteResult, request, shellQuote, prepareSshHostKey, resolveSshConnectionPolicy } from './transport.ts'
import type { SshConnectionPolicy, Target } from './transport.ts'
import { installPrivateFile } from './deploy.ts'
import type { DeploymentConfig, PreparedEnvironment } from './deploy.ts'
import { snapshotSource } from './snapshot.ts'
import { InstallationRecovery } from './installation.ts'
import { installationPolicySchema } from './installation-model.ts'
import type { InstallationPolicy } from './installation-model.ts'
import { storageGovernancePolicySchema } from '@aspera/runtime'
import { transferExperimentInput } from './input-transfer.ts'
import { PublicServiceChecks, publicServiceVerificationRouteSchema } from './service-verification.ts'
import type { PublicServiceVerificationRoute } from './service-verification.ts'
import { sshPasswordRef } from './ssh-account.ts'
import { pinnedTargetSchema } from './deployment-settings.ts'
import { fleetExperimentV5Schema, fleetRegistryV5Schema, fleetRequestV5Schema } from './fleet-schema-v5.ts'
import { serverConnectionCheckSchema, deletedExperimentSchema, experimentDeletionSchema, deleteRequestSchema } from './management-schema.ts'
import { cleanupLocalInputs } from './cleanup.ts'
import type { ServerConnectionCheck, DeletedExperiment, ExperimentDeletion, ExperimentDeletionPreview, DeleteExperimentsRequest, FleetSnapshot, ServerDeletionPreview } from './types.ts'
import { removalStoreSpec, removedWork, sameServerEndpoint } from './removals.ts'
import type { LocalRemoval } from './removals.ts'
import { delegateClusterLogin, describeClusterNode, ensureClusterRole, prepareClusterServer, inspectController } from './cluster-deploy.ts'
import type { DeploymentRelease } from './cluster-deploy.ts'
import { EnvironmentPreparation, UnconfirmedPreparationCommand } from './environment-preparation.ts'
import { ControllerRepair, controllerRepairPolicySchema } from './controller-repair.ts'
import { SandboxRepair, sandboxRepairPolicySchema } from './sandbox-repair.ts'
import type { SandboxRepairPolicy } from './sandbox-repair.ts'
import { gpuInventoryText, normalizedSet } from '@aspera/experiments'
import type { EnvironmentPreparationInput } from './environment-preparation.ts'
import { preparationCommandPolicySchema } from './preparation-command.ts'
import type { PreparationCommandPolicy } from './preparation-command.ts'
import type { EnvironmentProgress } from './types.ts'
import { environmentRequirements, installedEnvironmentRequirements, inspectEnvironment, checkEnvironment } from './environment.ts'
import type { FleetCreateRequest, FleetExperiment, FleetRegistry, FleetServerInput, PinnedDeployment } from './types.ts'
import type { AnswerExperimentQuestion, ExperimentModels } from '@aspera/experiments'
import { experimentRemovalBlocker, serverRemovalBlockers } from './server-usage.ts'
import { executionProgressReadSchema } from '@aspera/experiments'
import { StorageSelection, refreshStorageSelection } from './storage-selection.ts'
import { preparationStorage } from './preparation-storage.ts'
import { resolveTrainingNetwork } from './network-selection.ts'
import { captureExperimentModels } from './models.ts'
import { experimentPhases, experimentModelsSchema } from '@aspera/experiments'
import { openPhaseModelContext, privateModelConfigurationSchema } from '@aspera/runtime'
import { PhaseContextPolicyConfig } from '@aspera/runtime'
import type { PhaseContextPolicy } from '@aspera/runtime'
import { agentRecordRequestSchema, agentRecordPageSchema, projectAgentRecord, experimentProcessSchema, processLogRequestSchema, processLogPageSchema, traceEventChunkSchema } from '@aspera/experiments'
import type { AgentRecordRequest, AgentRecordPage, ExperimentProcess, ProcessLogRequest, ProcessLogPage } from '@aspera/experiments'
import { observationReadSchema, observationSourceSchema, observationSourceIdSchema, observationPageSchema, metricReadSchema, metricSampleSchema } from '@aspera/experiments'
import type { ObservationSource, ObservationRead, ObservationPage, MetricRead, MetricSample } from '@aspera/experiments'
import { observationSources, readObservation, redactObservation, readTraceAttachment } from '@aspera/runtime'
import { RunArchives } from './run-archive.ts'
import { RunArchiveReader, runArchivePolicySchema } from './run-archive-reader.ts'
import type { RunArchivePolicy } from './run-archive-reader.ts'
import type { ExperimentArchiveStatus } from '@aspera/experiments'
import type { ExperimentInterruptionStatus } from '@aspera/experiments'
import { ExperimentInterruptions } from './interruption.ts'
import type { InterruptionTask } from './interruption.ts'
import { remoteTaskStoreSpec, remoteTaskFromExperiment, remoteTaskAsInterruption, remoteTaskRecordSchema } from './remote-task.ts'
import type { RemoteTaskStatus } from './remote-task.ts'
import { RemoteInterruption } from './interruption-remote.ts'
import type { InterruptionFacts, InterruptionMode } from './interruption-remote.ts'
import { CompletionReviews } from './completion-review.ts'
import { CompletionReader } from './completion-reader.ts'
import { AcceptanceRecoveries } from './acceptance-recovery.ts'
import { serviceSchema } from '@aspera/experiments'
import { FinalizationRecords } from './finalization-records.ts'
import { finalizationPolicySchema } from '@aspera/runtime'
import { planningPolicySchema } from '@aspera/experiments'
import type { FinalizationPolicy } from '@aspera/runtime'
import { runCompletionReviewAgent } from './completion-agent.ts'
import { redactCompletionData, redactCompletionText, redactCompletionScript } from './completion-data.ts'
import { readCompletionTrace } from './completion-trace.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { ExperimentEnvironments } from './managed-environments.ts'
import { managedEnvironmentProgram, managedEnvironmentPolicySchema } from '@aspera/runtime'
import type { ManagedEnvironmentPolicy } from '@aspera/runtime'
import type { ExperimentStorageUsage, ExperimentCachePreview, ExperimentCacheCleanup, ExperimentCacheResult } from '@aspera/experiments'

const requestSchema = fleetRequestV5Schema.safeExtend({ coordinatorId: serverIdSchema })
  .refine(value => value.serverIds.includes(value.coordinatorId), 'Coordinator must be a selected execution node')
const localSchema = fleetExperimentV5Schema.extend({ request: z.union([requestSchema, fleetExperimentV5Schema.shape.request]) })
const registrySchema = fleetRegistryV5Schema.extend({ checks: z.record(z.string(), serverConnectionCheckSchema).optional() })
const storeSpec = defineDomain({ name: 'aspera_fleet', version: 6, compatibleVersions: [1, 2, 3, 4, 5], layout: 'per-record', tables: {
  registry: domainTable<string, FleetRegistry>(registrySchema),
  experiments: domainTable<ExperimentId, FleetExperiment>(localSchema),
  deleted: domainTable<ExperimentId, DeletedExperiment>(deletedExperimentSchema),
  deletions: domainTable<ExperimentId, ExperimentDeletion>(experimentDeletionSchema),
} })
type Store = Domain<typeof storeSpec>

function connectionConfiguration(server: ServerSettings): string {
  return createHash('sha256').update(JSON.stringify([server.host, server.sshPort, server.username, server.authMode, server.passwordRef,
    server.remotePort, server.storagePreference, server.remoteRoot])).digest('hex')
}

/** Deployment provider for release transfer, private credentials and authenticated control requests. */
export interface FleetDriver {
  prepareSshHostKey: typeof prepareSshHostKey
  snapshotSource: typeof snapshotSource
  prepareClusterServer: typeof prepareClusterServer
  ensureClusterRole: typeof ensureClusterRole
  inspectController: typeof inspectController
  describeClusterNode: typeof describeClusterNode
  delegateClusterLogin: typeof delegateClusterLogin
  installPrivateFile: typeof installPrivateFile
  remote: typeof remote
  remoteResult: typeof remoteResult
  inspectEnvironment: typeof inspectEnvironment
  environmentRequirements: typeof environmentRequirements
  installedEnvironmentRequirements: typeof installedEnvironmentRequirements
  copy: typeof copy
  request: typeof request
  inspectServerStorage: typeof inspectServerStorage
  prepareServerStorage: typeof prepareServerStorage
  cleanupServerStorage: typeof cleanupServerStorage
  verifyServerStorage: typeof verifyServerStorage
  resolveTrainingNetwork: typeof resolveTrainingNetwork
}

const productionDriver: FleetDriver = { prepareSshHostKey, snapshotSource, prepareClusterServer, ensureClusterRole, inspectController, describeClusterNode,
  delegateClusterLogin, installPrivateFile, remote, remoteResult, inspectEnvironment, environmentRequirements, installedEnvironmentRequirements, copy, request, inspectServerStorage, prepareServerStorage, verifyServerStorage, cleanupServerStorage, resolveTrainingNetwork }

class CoordinatorRequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

/** Server registry and dispatch service shared by Web and experiment tools. */
export class ExperimentFleet {
  private chain: Promise<void> = Promise.resolve()
  private readonly preparing = new Map<ExperimentId, { abort: AbortController; done: Promise<void> }>()
  private readonly serverChains = new Map<ExperimentServerId, Promise<void>>()
  private readonly handles = new Map<ExperimentId, AgentHandle>()
  private readonly tokens = new Map<string, Promise<string>>()
  private readonly acceptance = new Map<ExperimentId, Promise<void>>()
  private readonly checks = new Map<ExperimentServerId, Promise<ServerConnectionCheck>>()
  private readonly deletionWork = new Map<ExperimentId, Promise<ExperimentDeletion>>()
  private readonly cleanupControllers = new Map<ExperimentId, AbortController>()
  private readonly localCleanupWork = new Map<ExperimentId, Promise<void>>()
  private readonly checkControllers = new Map<ExperimentServerId, AbortController>()
  private readonly requests = new Map<ExperimentId, Set<AbortController>>()
  private closing = false
  private readonly uploadRoot = resolve(resolveDshHome(), 'aspera-inputs')
  private readonly archives: RunArchives
  private readonly archiveReader: RunArchiveReader
  private readonly completionReviews: CompletionReviews
  private readonly acceptanceRecoveries: AcceptanceRecoveries
  private readonly finalizationRecords: FinalizationRecords
  private readonly interruptions: ExperimentInterruptions
  private readonly environments: ExperimentEnvironments
  private readonly remoteInterruption: RemoteInterruption
  private readonly preparationSettlements = new Set<ExperimentId>()
  private readonly publicServiceChecks: PublicServiceChecks

  private constructor(private readonly ctx: Context, private readonly store: Store, private readonly removals: Domain<typeof removalStoreSpec>,
    private readonly remoteTasks: Domain<typeof remoteTaskStoreSpec>,
    private readonly deployment: (server: ServerSettings) => PinnedDeployment,
    private readonly connectionCheckTimeoutMs: number, private readonly driver: FleetDriver,
    private readonly installations: InstallationRecovery, private readonly controllerRepairMaxAttempts: number,
    private readonly sshConnectionPolicy: SshConnectionPolicy, private readonly sandboxRepairPolicy: SandboxRepairPolicy,
    private readonly archivePolicy: RunArchivePolicy, private readonly agentContext: PhaseContextPolicy,
    private readonly environmentPolicy: ManagedEnvironmentPolicy, private readonly commandPolicy: PreparationCommandPolicy,
    private readonly finalizationPolicy: FinalizationPolicy, publicServiceVerificationRoute: PublicServiceVerificationRoute) {
    this.publicServiceChecks = new PublicServiceChecks(resolve(resolveDshHome(), 'aspera-service-verifications'), { alive: id => !this.closing && !this.isRemoved(id),
      call: async (id, operation, input, signal) => {
        try { return await this.call(this.get(id), operation, { experimentId: id, ...input }, signal) }
        catch (error) {
          if (operation === 'service-verification-pending' && error instanceof CoordinatorRequestError && error.status === 404
            && error.message === 'cluster route not found') return { supported: false, operations: [] }
          throw error
        }
      }, report: error => this.ctx.logger.error('Public service verification: ' + String(error)),
    }, this.finalizationPolicy.evidenceBytes, this.finalizationPolicy.readTimeoutMs, publicServiceVerificationRoute)
    this.environments = new ExperimentEnvironments(resolve(resolveDshHome(), 'aspera-environments'), {
      get: id => this.get(id), alive: id => !this.closing && !this.isRemoved(id), secrets: record => this.archiveSecrets(record), list: () => this.list(),
      program: managedEnvironmentProgram,
      ssh: async (record, serverId, command, signal, input) => {
        const connection = await this.interruptionConnection(record, serverId)
        return this.driver.remote(connection.target, command, signal, connection.password, input)
      },
      node: async (record, serverId, operation, body, signal) => {
        const server = record.submission?.nodes.find(node => node.server.id === serverId)?.server
        if (server === undefined || record.submission?.protocol !== 4) throw new Error('Environment management requires a capable original protocol-4 release')
        const connection = await this.interruptionConnection(record, serverId)
        const target = { ...connection.target, remotePort: server.remotePort, toolTimeoutMs: Math.min(connection.target.toolTimeoutMs, this.environmentPolicy.readTimeoutMs) }
        const value = await this.driver.request(target, await this.token(server, 'node'), '/aspera/v4/node/' + operation, 'POST', body, signal, connection.password)
        if (value.status !== 200) throw new Error(`Environment node request failed (${value.status}): ${JSON.stringify(value.value)}`)
        return value.value
      },
    }, environmentPolicy)
    this.remoteInterruption = new RemoteInterruption(driver, sandboxRepairPolicy.cleanupTimeoutMs)
    this.interruptions = new ExperimentInterruptions(resolve(resolveDshHome(), 'aspera-interruptions'), {
      get: id => this.interruptionTask(id), alive: id => this.remoteTasks.table('tasks').get(id) !== undefined
        || !this.isRemoved(id) && this.store.table('experiments').get(id) !== undefined,
      settle: (record, status, signal, update) => {
        const settle = () => this.settleInterruption(record, status, signal, update)
        if (this.preparationSettlements.has(record.request.experimentId) || record.submission === undefined && record.submissionHash === undefined) return settle()
        const nodes = [...record.servers.map(server => server.id)].sort()
        const lock = (index: number): Promise<ClusterRecord | undefined> => index === nodes.length ? settle()
          : this.onServer(nodes[index]!, signal, () => lock(index + 1), record.request.experimentId)
        return lock(0)
      },
      accept: (id, result) => this.serial(async () => {
        if (result === undefined) return
        const identity = this.interruptionTask(id)
        const expected = identity.submissionHash ?? createHash('sha256').update(JSON.stringify(identity.submission)).digest('hex')
        if (createHash('sha256').update(JSON.stringify(result.submission)).digest('hex') !== expected) throw new Error('Interruption result belongs to another submission')
        if (!['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(result.state) || !result.resourcesReleased || result.services.some(service => !service.released)) {
          throw new Error('Interruption has no confirmed terminal resource release')
        }
        if (this.isRemoved(id)) return
        const current = this.get(id)
        if ((current.latest?.revision ?? 0) <= result.revision) await this.store.table('experiments').put(id, { ...current, latest: result, waitingFor: [] })
        this.archives.changed(id)
      }),
      changed: () => this.ctx.emit('experiment-fleet/changed', { kind: 'experiments' }),
      report: error => this.ctx.logger.error(String(error)),
    }, record => this.resolvedTarget(record.coordinatorTarget).toolTimeoutMs)
    this.archives = new RunArchives(resolve(resolveDshHome(), 'aspera-run-records'), {
      list: () => this.list(), get: id => this.get(id), alive: id => !this.closing && !this.isRemoved(id),
      secrets: record => this.archiveSecrets(record),
      observe: (id, observed) => this.serial(async () => {
        if (this.closing || this.isRemoved(id)) return
        const current = this.get(id)
        if (JSON.stringify(observed.submission) !== JSON.stringify(current.submission)) throw new Error('Archived status belongs to another submission')
        if ((current.latest?.revision ?? 0) < observed.revision) await this.store.table('experiments').put(id, { ...current, latest: observed })
        if (['running', 'serving'].includes(observed.state)) this.publicServiceChecks.changed(id)
      }),
    }, this.archiveReader = new RunArchiveReader({ remoteResult: driver.remoteResult,
      connection: async (record, serverId) => {
        const server = record.servers.find(server => server.id === serverId)
        const target = serverId === record.coordinator.id ? record.coordinatorTarget : record.targets[record.servers.findIndex(server => server.id === serverId)]
        if (server === undefined || target === undefined) throw new Error('Archive node belongs to another experiment')
        const registered = this.servers().servers.find(value => value.id === serverId)
        const login = registered ?? server
        return { target: this.connectionTarget({ ...this.resolvedTarget(target), host: login.host, sshPort: login.sshPort,
          username: login.username, authMode: login.authMode, identityFile: login.identityFile,
          knownHostsFile: login.knownHostsFile, passwordRef: sshPasswordRef(login) }),
          password: await this.password(login) }
      },
      rpc: (record, operation, input, signal) => this.call(record, operation, input, signal),
      trace: (_record, input, signal) => this.recordsRemote(input, true, signal),
      observation: (_record, input, signal) => this.logReadRemote(input, signal),
      pipe: (_record, input, signal) => this.processLogRemote(input, signal),
    }, archivePolicy), archivePolicy)
    const reader = new CompletionReader(driver, (record, serverId) => this.interruptionConnection(record, serverId), this.archiveReader,
      { ...archivePolicy, archiveRequestTimeoutMs: finalizationPolicy.readTimeoutMs })
    this.finalizationRecords = new FinalizationRecords(resolve(resolveDshHome(), 'aspera-run-records'), {
      get: id => this.get(id), alive: id => !this.closing && !this.isRemoved(id),
      read: async (record, signal) => {
        if (record.submission === undefined) return { version: 1, experimentId: record.request.experimentId, supported: false, observedAt: Date.now(), offline: false, truncated: false, waits: [], stages: [] }
        const lifetime = AbortSignal.any([signal, AbortSignal.timeout(this.finalizationPolicy.readTimeoutMs)])
        try { return await this.call(record, 'finalization-status', {}, lifetime) }
        catch (error) { lifetime.throwIfAborted(); void error; return reader.finalization(record, lifetime) }
      },
    })
    const secrets = new Map<ExperimentId, string[]>()
    this.completionReviews = new CompletionReviews(resolve(resolveDshHome(), 'aspera-completion-reviews'), {
      get: id => this.get(id), alive: id => !this.closing && !this.isRemoved(id),
      snapshot: async (record, signal) => { secrets.set(record.request.experimentId, await this.archiveSecrets(record)); return reader.snapshot(record, signal) },
      source: async (record, input, signal) => {
        const source = await reader.source(record, input, signal)
        return { ...source, text: redactCompletionText(source.text, secrets.get(record.request.experimentId) ?? []), tail: redactCompletionText(source.tail, secrets.get(record.request.experimentId) ?? []) }
      },
      environment: (record, entry, signal) => reader.environment(record, entry, signal),
      serviceIssues: async (record, signal) => {
        if (this.acceptanceRecoveries.status(record.request.experimentId) !== undefined) return this.acceptanceRecoveries.serviceIssues(record.request.experimentId, signal)
        return await reader.serviceRecoveryRequired(record, signal) ? [{ code: 'results', detail: 'Original public inference still requires a verified serving recovery.',
          remedy: 'Use recoverExperimentAcceptance on this original task. Existing checkpoints are retained; do not retrain.' }] : []
      },
      commit: (record, review, signal, assessment) => reader.commit(record, review, signal, assessment),
      run: async (record, review, tools, signal) => runCompletionReviewAgent(ctx, { ...record,
        acceptanceRecovery: this.acceptanceRecoveries.status(record.request.experimentId) }, review, tools, {
        snapshot: (value, lifetime) => reader.snapshot(value, lifetime),
        source: async (value, input, lifetime) => {
          const result = await reader.source(value, input, lifetime)
          return { ...result, text: redactCompletionText(result.text, secrets.get(value.request.experimentId) ?? []), tail: redactCompletionText(result.tail, secrets.get(value.request.experimentId) ?? []) }
        },
      }, agentContext, beforeSeq => this.records({ experimentId: record.request.experimentId, phase: 'execution', beforeSeq, limit: 50 }, true), signal),
      changed: () => ctx.emit('experiment-fleet/changed', { kind: 'experiments' }),
      redact: (record, data) => redactCompletionData(data, secrets.get(record.request.experimentId) ?? []),
      trace: async (review, input) => readCompletionTrace(ctx.sessionPersistence, review, input, await this.archiveSecrets(this.get(review.experimentId))),
      finished: id => { secrets.delete(id) },
      report: error => { ctx.logger.error('Completion review: ' + String(error)) },
    }, this.finalizationPolicy)
    this.acceptanceRecoveries = new AcceptanceRecoveries(resolve(resolveDshHome(), 'aspera-acceptance-recoveries'), {
      get: id => this.get(id), alive: id => !this.isRemoved(id) && this.store.table('experiments').get(id) !== undefined,
      candidates: id => this.list().filter(row => row.request.experimentId !== id).sort((left, right) => right.createdAt - left.createdAt),
      source: (original, recovery, signal) => reader.acceptanceSource(original, recovery, signal),
      observe: async (recovery, source, signal) => {
        const observation = await reader.acceptanceObservation(recovery, source, signal), services = []
        for (const node of recovery.submission!.nodes) {
          const connection = await this.interruptionConnection(recovery, node.server.id)
          const value = await this.driver.request({ ...connection.target, remotePort: node.server.remotePort }, await this.token(node.server, 'node'),
            '/aspera/v4/node/services', 'POST', { experimentId: recovery.request.experimentId }, signal, connection.password)
          if (value.status !== 200) throw new Error('Recovery service liveness is unavailable: ' + value.status)
          const observed = z.array(serviceSchema).parse(value.value)
          if (observed.some(service => service.experimentId !== recovery.request.experimentId || service.serverId !== node.server.id)) throw new Error('Recovery services belong to another node or experiment')
          services.push(...observed)
        }
        return { ...observation, services }
      },
      evidence: (original, operation, observation, signal) => reader.saveAcceptanceEvidence(original, operation, observation, signal),
      review: id => this.completionReviews.request(id), reviewStatus: id => this.completionReviews.status(id),
      createRuntime: (original, previous, runtimeId, source, signal) => this.createAcceptanceRuntime(original, previous, runtimeId, source, reader, signal),
      changed: () => ctx.emit('experiment-fleet/changed', { kind: 'experiments' }),
    }, archivePolicy.archiveIntervalMs, this.finalizationPolicy.reconnectTimeoutMs)
  }

  /**
   * Open durable records and reconcile interrupted local preparation.
   * @param ctx - dispatch host.
   * @param deployment - resolves shared policy against a selected server.
   * @param connectionCheckTimeoutMs - total connection-check deadline, independent of preparation command timeouts.
   * @param driver - release and transport provider; the default uses password SSH.
   * @param installationPolicy - supervised installer budgets.
   * @param controllerRepairPolicy - per-server and per-role restart limit.
   * @param sshConnectionPolicy - local handshake and reconnection limits; saved releases and submissions remain fixed.
   * @param sandboxRepairPolicy - private-proc probe, cleanup and immutable launcher installation limits.
   * @param archivePolicy - local copy intervals, read limits, retry delays and disk reserve.
   * @param agentContext - DSH compaction and tool-output settings for preparation Agents.
   * @param environmentPolicy - fixed installer, storage observations and package bounds.
   * @param commandPolicy - preparation command polling and exit-recovery limits.
   * @param finalizationPolicy - historical stage tolerances and finalization observation limits.
   * @param publicServiceVerificationRoute - Host-owned direct or inherited HTTP routing for registered service checks.
   * @returns effect-owned fleet service.
   */
  static async open(ctx: Context, deployment: (server: ServerSettings) => PinnedDeployment,
    connectionCheckTimeoutMs: number, driver: FleetDriver = productionDriver,
    installationPolicy: InstallationPolicy = installationPolicySchema.parse({}),
    controllerRepairPolicy = controllerRepairPolicySchema.parse({}),
    sshConnectionPolicy = resolveSshConnectionPolicy({}),
    sandboxRepairPolicy: SandboxRepairPolicy = sandboxRepairPolicySchema.parse({}),
    archivePolicy: RunArchivePolicy = runArchivePolicySchema.parse({}),
    agentContext: PhaseContextPolicy = PhaseContextPolicyConfig({ compaction: {}, pruning: {} }),
    environmentPolicy: ManagedEnvironmentPolicy = managedEnvironmentPolicySchema.parse({}),
    commandPolicy: PreparationCommandPolicy = preparationCommandPolicySchema.parse({}),
    finalizationPolicy: FinalizationPolicy = finalizationPolicySchema.parse({}),
    publicServiceVerificationRoute: PublicServiceVerificationRoute = publicServiceVerificationRouteSchema.parse(undefined)): Promise<ExperimentFleet> {
    const store = await ctx.storage.domain.open(storeSpec)
    const removals = await ctx.storage.domain.open(removalStoreSpec)
    const remoteTasks = await ctx.storage.domain.open(remoteTaskStoreSpec)
    for (const [, record] of store.table('experiments').entries()) {
      const identity = remoteTaskFromExperiment(record)
      if (identity !== undefined && remoteTasks.table('tasks').get(identity.experimentId) === undefined) await remoteTasks.table('tasks').put(identity.experimentId, identity)
    }
    for (const [id, removal] of removals.table('removals').entries()) {
      if (removal.work?.protocol === 4 && /^[a-f0-9]{64}$/.test(removal.work.submissionHash ?? '') && remoteTasks.table('tasks').get(id) === undefined) {
        await remoteTasks.table('tasks').put(id, remoteTaskRecordSchema.parse({ version: 1, experimentId: id, name: removal.name,
          work: removal.work, createdAt: removal.identity.deletedAt, updatedAt: removal.identity.deletedAt }))
      }
    }
    const installations = await InstallationRecovery.open(ctx, installationPolicy, driver)
    const fleet = new ExperimentFleet(ctx, store, removals, remoteTasks, deployment, connectionCheckTimeoutMs, driver, installations,
      controllerRepairPolicySchema.parse(controllerRepairPolicy).maxAttempts, resolveSshConnectionPolicy(sshConnectionPolicy), sandboxRepairPolicySchema.parse(sandboxRepairPolicy), runArchivePolicySchema.parse(archivePolicy), agentContext, managedEnvironmentPolicySchema.parse(environmentPolicy), preparationCommandPolicySchema.parse(commandPolicy), finalizationPolicySchema.parse(finalizationPolicy), publicServiceVerificationRoute)
    ctx.effect(() => () => fleet.close(), 'experiment fleet: local preparations')
    if (store.table('registry').get('servers') === undefined) {
      await store.table('registry').put('servers', { servers: [] })
    }
    const registry = fleet.servers()
    if (Object.values(registry.checks ?? {}).some(check => check.status === 'checking')) {
      await store.table('registry').put('servers', { ...registry, checks: Object.fromEntries(Object.entries(registry.checks ?? {}).map(([id, check]) =>
        [id, check.status === 'checking' ? { ...check, status: 'interrupted', checkedAt: Date.now() } : check])) })
    }
    for (const [id, job] of store.table('deletions').entries()) {
      if (fleet.isRemoved(id)) {
        await store.table('deletions').put(id, { experimentId: id, operationId: job.operationId, cleanupRemote: job.cleanupRemote, started: job.started, state: 'deleted', nodes: [], updatedAt: job.updatedAt })
      } else if (job.state === 'deleting') await store.table('deletions').put(id, { ...job, state: 'failed', detail: 'Cleanup was interrupted; retry to resume saved progress', updatedAt: Date.now() })
    }
    for (const [id, record] of store.table('experiments').entries()) {
      if (fleet.isRemoved(id)) { await store.table('experiments').delete(id); continue }
      if (record.state === 'preparing' && !(installations.has(id) && record.submission === undefined)) await store.table('experiments').put(id, { ...record, state: 'failed', detail:
        record.submission === undefined ? 'Local preparation was interrupted before remote handover.' : 'Submission outcome is unknown; refresh to reconcile the saved experiment id.' })
    }
    ctx.on('domain/changed', (change) => {
      if (change.domain === 'aspera_fleet' || change.domain === 'aspera_removals' || change.domain === 'aspera_preparation' || change.domain === 'aspera_remote_tasks') ctx.emit('experiment-fleet/changed',
        { kind: change.table === 'registry' ? 'servers' : 'experiments' })
    })
    for (const [id, removal] of removals.table('removals').entries()) if (removal.localCleanup === 'pending') fleet.beginLocalCleanup(id)
    for (const record of fleet.list()) if (record.state === 'preparing' && installations.has(record.request.experimentId) && record.submission === undefined) fleet.beginPreparation(record.request.experimentId)
    fleet.archives.start()
    fleet.environments.start()
    fleet.interruptions.resume()
    fleet.completionReviews.resume()
    fleet.acceptanceRecoveries.resume()
    for (const record of fleet.list()) void fleet.environments.resume(record.request.experimentId).catch(error => { ctx.logger.error(`Environment cleanup recovery: ${String(error)}`) })
    return fleet
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => {}, () => {})
    return result
  }

  private async onServer<T>(id: ExperimentServerId, signal: AbortSignal, operation: () => Promise<T>, ownerId: ExperimentId): Promise<T> {
    const prior = this.serverChains.get(id) ?? Promise.resolve()
    const result = prior.then(async () => {
      signal.throwIfAborted()
      for (const record of this.list()) {
        if (record.request.experimentId !== ownerId && this.installations.pending(record.request.experimentId).includes(id)) throw new UnconfirmedPreparationCommand('Another experiment still owns an installation on this server; reconcile its exit before preparing a new experiment')
        const environment = record.preparation?.environments?.find(value => value.serverId === id)
        if (environment?.pendingCommand === undefined) continue
        const server = record.coordinator.id === id ? record.coordinator : record.servers.find(value => value.id === id)
        const target = record.coordinator.id === id ? record.coordinatorTarget : record.targets[record.servers.findIndex(value => value.id === id)]
        if (server === undefined || target === undefined) throw new Error('Pending preparation command has no saved server')
        const directory = environment.pendingCommand.directory
        let exit = await this.driver.remote(target, `if [ -f ${shellQuote(directory + '/exited')} ]; then cat ${shellQuote(directory + '/exited')}; else printf unknown; fi`, signal, await this.password(server))
        if (!/^\d+\s*$/.test(exit) && record.request.experimentId === ownerId && directory.includes('/controller-repairs/')) {
          const role = /\/controller-repairs\/(node|coordinator)\//.exec(directory)?.[1]
          if (role !== 'node' && role !== 'coordinator') throw new UnconfirmedPreparationCommand('Saved controller repair role is unavailable')
          const configured = this.resolvedTarget(target)
          const digest = server.storagePlacement?.releaseRoot.split('/').at(-1)
          if (digest === undefined || !/^[a-f0-9]{64}$/.test(digest)) throw new UnconfirmedPreparationCommand('Original controller repair release is unavailable')
          const password = await this.password(server)
          const prepared = await this.driver.prepareClusterServer(configured, { digest, reuse: true }, password, signal)
          const repair = new ControllerRepair({ experimentId: ownerId, serverId: id, role, target: configured, prepared,
            token: await this.token(server, role), password, maxAttempts: this.controllerRepairMaxAttempts,
            ...this.interruptionRecovery(ownerId) }, this.driver)
          await repair.reconcile(directory, signal)
          exit = await this.driver.remote(target, `cat ${shellQuote(directory + '/exited')}`, signal, password)
        }
        if (!/^\d+\s*$/.test(exit)) throw new UnconfirmedPreparationCommand(`Server preparation is still unconfirmed at ${directory}; inspect that command before retrying.`)
        const { pendingCommand: _pending, ...settled } = environment
        await this.environmentProgress(record.request.experimentId, { ...settled, detail: `Previous command exited ${exit.trim()}; environment must be rechecked.` })
      }
      return operation()
    })
    const done = result.then(() => {}, () => {})
    this.serverChains.set(id, done)
    try { return await result } finally { if (this.serverChains.get(id) === done) this.serverChains.delete(id) }
  }

  /**
   * Read configured servers without credential values.
   * @returns peer server registrations and dated checks.
   */
  servers(): FleetRegistry {
    const registry = this.store.table('registry').get('servers')
    if (registry === undefined) throw new Error('server registry is missing')
    return { ...registry, servers: registry.servers.filter(server => this.removals.table('removed_servers').get(server.id) === undefined) }
  }

  /**
   * Save peer server settings without changing pinned experiment destinations.
   * @param raw - complete server definition.
   * @returns persisted peer server registrations.
   */
  saveServer(raw: FleetServerInput): Promise<FleetRegistry> {
    const server = serverSettingsSchema.omit({ storagePlacement: true }).parse(raw)
    if (server.remoteRoot === undefined && server.storagePreference === undefined) server.storagePreference = { mode: 'auto' }
    if (server.authMode !== 'password' || server.identityFile !== undefined) throw new Error('Aspera server configuration supports password login only')
    if (server.inferenceMapping !== undefined && [server.remotePort, server.remotePort + 1, server.sshPort].includes(server.inferenceMapping.port)) {
      throw new Error('Mapped inference port must differ from the SSH and internal control ports')
    }
    return this.serial(async () => {
      if (this.removals.table('removed_servers').get(server.id) !== undefined) throw new Error('Server registration was removed; add it with a new identity')
      const registry = this.servers()
      const previous = registry.servers.find(other => other.id === server.id)
      if (registry.servers.some(other => other.id !== server.id && other.host === server.host && other.sshPort === server.sshPort)) {
        throw new Error('this SSH server is already configured')
      }
      const servers = registry.servers.some(other => other.id === server.id)
        ? registry.servers.map(other => other.id === server.id ? server : other) : [...registry.servers, server]
      const probes = { ...registry.probes }; delete probes[server.id]
      const checks = { ...registry.checks }
      if (previous === undefined || connectionConfiguration(previous) !== connectionConfiguration(server)) {
        const lastSuccess = checks[server.id]?.lastSuccess
        checks[server.id] = { status: 'unchecked', configuration: connectionConfiguration(server), ...(lastSuccess === undefined ? {} : { lastSuccess }) }
      }
      const next = { servers, probes, checks }
      await this.store.table('registry').put('servers', next)
      return next
    })
  }

  /**
   * Remove a server configuration from future selections without stopping pinned experiments.
   * @param id - server registration to remove; historical snapshots and remote files remain.
   * @param allowLinked - explicit acknowledgement that unfinished work and cleanup obligations remain.
   * @returns registry after safe removal.
   */
  removeServer(id: ExperimentServerId, allowLinked: boolean = false): Promise<FleetRegistry> {
    return this.serial(async () => {
      const current = this.servers()
      if (!allowLinked && (serverRemovalBlockers(id, this.list(), current.checks?.[id]?.result ?? current.checks?.[id]?.lastSuccess?.result ?? current.probes?.[id], this.deletedIds(), this.interruptions.list()).length > 0 || this.list().some(row => this.installations.pending(row.request.experimentId).includes(id)))) {
        throw new Error('Server has pending work or unconfirmed cleanup; stop or reconcile that work before removing its registration')
      }
      const servers = current.servers.filter(server => server.id !== id)
      const { [id]: _removedProbe, ...probes } = current.probes ?? {}
      await this.removals.table('removed_servers').put(id, { removedAt: Date.now() })
      this.checkControllers.get(id)?.abort(new Error('Server configuration removed'))
      const { [id]: _removedCheck, ...checks } = current.checks ?? {}
      const next = { servers, probes, checks }
      await this.store.table('registry').put('servers', next)
      const removed = current.servers.find(server => server.id === id)
      if (removed !== undefined) await this.removeUnusedCredential(sshPasswordRef(removed))
      return next
    })
  }

  /** Preview local configuration deletion without connecting to the server.
   * @param id - saved server identity. @returns retained experiments and unresolved deleted work.
   */
  previewServerRemoval(id: ExperimentServerId): ServerDeletionPreview {
    return { serverId: id, linkedExperiments: this.list().filter(row => row.servers.some(server => server.id === id) || row.coordinator.id === id)
      .map(row => ({ experimentId: row.request.experimentId, name: row.request.name ?? row.request.objective.split('\n')[0]!.slice(0, 120), unfinished: experimentRemovalBlocker(row, this.interruptions.status(row.request.experimentId)) !== undefined || this.installations.pending(row.request.experimentId).includes(id) })),
    unconfirmedExperimentIds: this.unconfirmedRemoteWork().filter(value => value.serverIds.includes(id)).map(value => value.experimentId) }
  }

  private async password(server: ServerSettings): Promise<string | undefined> {
    if (server.authMode !== 'password') return undefined
    const value = await this.ctx.credentials.resolve(sshPasswordRef(server))
    if (value === undefined) throw new Error(`SSH password is missing for ${server.name}`)
    return value.value
  }

  /** Explicit editor reveal; ordinary snapshots never contain the returned value.
   * @param id - saved server identity. @returns its saved password, only on operator request.
   */
  async revealPassword(id: ExperimentServerId): Promise<string> {
    const server = this.servers().servers.find(value => value.id === id)
    if (server === undefined) throw new Error('Server is no longer configured')
    return await this.password(server) ?? ''
  }

  /** Invalidate observations made with a replaced credential.
   * @param ref - credential changed by the server editor.
   */
  invalidatePassword(ref: string): Promise<void> {
    return this.serial(async () => {
      const registry = this.servers(); const checks = { ...registry.checks }; const probes = { ...registry.probes }
      for (const server of registry.servers) if (sshPasswordRef(server) === ref) {
        const lastSuccess = checks[server.id]?.lastSuccess
        checks[server.id] = { status: 'unchecked', configuration: connectionConfiguration(server), ...(lastSuccess === undefined ? {} : { lastSuccess }) }; delete probes[server.id]
      }
      await this.store.table('registry').put('servers', { ...registry, checks, probes })
    })
  }

  private async removeUnusedCredential(ref: string, deletingId?: ExperimentId): Promise<void> {
    if (!/^(DSH_EXPERIMENT_SSH_PASSWORD_|ASPERA_(SSH|MODEL|KEY)_)/.test(ref)) return
    if (this.servers().servers.some(server => sshPasswordRef(server) === ref)) return
    for (const record of this.list()) {
      if (record.request.experimentId === deletingId) continue
      if ([record.coordinator, ...record.servers].some(server => sshPasswordRef(server) === ref)) return
      if (record.models !== undefined && experimentPhases.some(phase => record.models?.[phase].configurationRef === ref
        || `ASPERA_KEY_${record.request.experimentId.replaceAll('-', '_')}_${phase}`.toUpperCase() === ref)) return
    }
    for (const [id, removal] of this.removals.table('removals').entries()) {
      if (!this.isRemoteTaskReleased(id) && removal.work?.nodes.some(node => sshPasswordRef(node.server) === ref)) return
      if (id !== deletingId && removal.localCleanup === 'pending' && removal.credentialRefs.includes(ref)) return
    }
    for (const [id, task] of this.remoteTasks.table('tasks').entries()) {
      if (!this.isRemoteTaskReleased(id) && task.work.nodes.some(node => sshPasswordRef(node.server) === ref)) return
    }
    const key = credentialRef(ref)
    if ((await this.ctx.credentials.describe(key)).writable) await this.ctx.credentials.unset(key)
  }

  /** Complete snapshots include deletion identities so stale replies cannot restore rows. @returns public management state. */
  snapshot(): FleetSnapshot {
    return { registry: this.servers(), experiments: this.list().map(record => this.view(record)), deletedIds: this.deletedIds(),
      installations: this.installations.progress(this.list().map(row => row.request.experimentId)),
      removedServerIds: [...this.removals.table('removed_servers').entries()].map(([id]) => id),
      unconfirmedWork: this.unconfirmedRemoteWork(),
      deletions: [...this.store.table('deletions').entries()].map(([id, job]) => this.isRemoved(id) ? { ...job, state: 'deleted' as const } : job),
      interruptions: this.interruptions.list().filter(status => !this.isRemoved(status.experimentId)) }
  }

  /** @param record - original stored record. @returns presentation-only review state without changing the fleet schema or remote outcome. */
  view(record: FleetExperiment): FleetExperiment {
    const review = this.completionReviews.status(record.request.experimentId), original = record.latest ?? record.receipt
    const matching = review !== undefined && review.submissionHash === createHash('sha256').update(JSON.stringify(record.submission)).digest('hex')
      && review.originalRevision === original?.revision && review.executionSessionId === original.sessionId
    return { ...record, acceptanceRecovery: this.acceptanceRecoveries.status(record.request.experimentId),
      acceptanceParentId: this.acceptanceRecoveries.parentOf(record.request.experimentId), completionReviewAvailable: this.completionReviews.eligible(record),
      ...(matching ? { completionAssessment: this.completionReviews.assessment(record.request.experimentId) } : {}),
      ...(review === undefined ? {} : { completionReview: matching ? review : { ...review, phase: 'blocked' as const, detail: 'Original result identity changed; the previous review is not applicable.' } }) }
  }
  /** @param id - released completion-evidence failure. @returns the durable acknowledgement of read-only supplementation. */
  reviewCompletion(id: ExperimentId): import('@aspera/experiments').CompletionReview { return this.completionReviews.request(id) }
  /** @param id - retained trained task. @param recoveryId - optional existing inference execution. @returns a checkpoint-bound recovery operation beneath the original task. */
  recoverAcceptance(id: ExperimentId, recoveryId?: ExperimentId): Promise<import('@aspera/experiments').AcceptanceRecovery> { return this.acceptanceRecoveries.request(id, recoveryId) }
  /** @param id - original task. @returns the retained recovery progress without starting work. */
  acceptanceRecoveryStatus(id: ExperimentId): import('@aspera/experiments').AcceptanceRecovery | undefined { this.get(id); return this.acceptanceRecoveries.status(id) }
  private async createAcceptanceRuntime(original: FleetExperiment, previous: FleetExperiment, runtimeId: ExperimentId,
    source: import('@aspera/experiments').AcceptanceSource, reader: CompletionReader, lifetime: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(this.finalizationPolicy.readTimeoutMs)])
    const fresh = await reader.snapshot(original, signal)
    if (fresh.record.revision !== source.resultRevision || fresh.record.payloadHash !== source.submissionHash) throw new Error('Original training changed before recovery preparation')
    const references = await reader.acceptanceReferences(previous, signal)
    const files = await reader.acceptanceScripts(original, fresh.files ?? [], signal)
    const secrets = await this.archiveSecrets(original)
    const input = Buffer.from(JSON.stringify({ version: 1, source: redactCompletionData(source, secrets), previousExperimentId: previous.request.experimentId,
      previousOutcome: redactCompletionData((previous.latest ?? previous.receipt)?.detail, secrets), references: redactCompletionData(references, secrets),
      files: files.map(file => redactCompletionScript(file, secrets)), originalExecutions: redactCompletionData(fresh.record.executions, secrets),
      originalObjective: redactCompletionText(original.submission!.objective, secrets), approvedOriginalPlan: redactCompletionData(fresh.record.plan, secrets) }) + '\n')
    const models = original.models
    if (models === undefined) throw new Error('Original phase models are unavailable')
    const selections = Object.fromEntries(experimentPhases.map(phase => [phase, { provider: models[phase].provider, model: models[phase].model,
      ...(models[phase].reasoningEffort === undefined ? {} : { reasoningEffort: models[phase].reasoningEffort }) }]))
    const required = source.nodes.map(node => ({ serverId: node.serverId, step: node.step, modelName: node.modelName, publicUrl: node.publicUrl }))
    const request: FleetCreateRequest = { experimentId: runtimeId, name: (original.request.name ?? 'Experiment') + ' · 验收恢复',
      serverIds: original.request.serverIds, coordinatorId: original.coordinator.id, mode: original.request.mode,
      models: experimentModelsSchema.parse(selections), files: [], uploads: [{ name: 'acceptance-source.json', size: input.length }],
      objective: `This is an inference-only acceptance recovery operation beneath original experiment ${original.request.experimentId}; it is not new training. Preserve original results, fixed releases, environments, weights, checkpoints and logs. Required serving identity: ${JSON.stringify(required)}.\n\nRead acceptance-source.json completely. It contains program-inspected retained checkpoint identities, prior verified environment hints, prior Agent policy proposals, original execution entries and original configuration/script text. Hints and proposals require fresh tool verification and are not approval. Use the exact retained native endpoint via the protected snapshot tools; never retrain, reevaluate or create new adapters.\n\nContinue only the original unmet public inference acceptance. Reuse the retained corrected server code when suitable rather than rebuilding an unrelated backend. You own the remaining script choices and any corrections. Use the actual verified environment candidate and canonical base-model material; do not reinstall large dependencies, copy old environments or redownload verified weights. Read retention policy, independently estimate the small inference-only outputs and commit the correct budget. Earlier rejected proposals are reference options, not the original training retention policy. Request explicit Host approval if required; do not loop through equivalent capacity estimates.\n\nLoad the unquantized fixed base and the retained adapter in one GPU process, using framework offline loading and absolute managed interpreter paths. The model must actually generate. Register a private loopback backend and publish through the saved public mapping with program-managed authentication. Verify real public generation, model listing, and missing/wrong-credential rejection through verify_inference_service. If the service needs correction, use the dedicated stop tool and confirm release before replacement. Do not run an extra lifecycle exercise when the original required acceptance already passes. Keep the final accepted service running.\n\nSave a concise inference-only plan and actual step/effective execution records, distinguishing retained training from this serving operation. Request the program completion check and finish only after the required public checks and records pass. Reports do not replace program checks. Do not modify the original experiment or execute its scripts in its workspace. Read referenced source text and perform any permitted changes only in this recovery's own workspace. No archive.` }
    request.objective += '\n\nSource entries retain sha256 for original file bytes; textSha256 hashes the supplied UTF-8 text and textRedacted identifies credential masking. Use textSha256 for copied-text checks. Masked source is a reference for your own reviewed script, not an executable byte-for-byte original. Original file proofs and credentials remain protected.'
    signal.throwIfAborted()
    let record = await this.create(request)
    signal.throwIfAborted()
    if (record.state === 'staging') {
      for (let offset = 0; offset < input.length;) {
        signal.throwIfAborted()
        const chunk = input.subarray(offset, offset + 65536)
        offset = this.upload(runtimeId, 'acceptance-source.json', offset, chunk.toString('base64')).nextOffset
      }
      signal.throwIfAborted(); record = await this.commitInputs(runtimeId)
    }
    if (record.state === 'failed') throw new Error(record.detail ?? 'Acceptance recovery preparation failed')
  }
  /** @param id - original experiment. @returns saved assessment without network access. */
  completionReviewStatus(id: ExperimentId): import('@aspera/experiments').CompletionReview | undefined { this.get(id); return this.completionReviews.status(id) }
  /** @param id - original experiment. @returns saved stage and step supplements, without modifying the original result. */
  completionAssessment(id: ExperimentId): import('@aspera/experiments').CompletionAssessment | undefined { this.get(id); return this.completionReviews.assessment(id) }
  /** @param id - original task. @returns lightweight program observations or a dated offline copy. */
  finalizationStatus(id: ExperimentId): Promise<import('@aspera/experiments').ExperimentFinalizationStatus> { this.get(id); return this.finalizationRecords.read(id) }
  /** @param id - selected review. @returns after its Agent and pending reads stop, retaining original results. */
  async cancelCompletionReview(id: ExperimentId): Promise<import('@aspera/experiments').CompletionReview | undefined> {
    this.get(id); await this.completionReviews.stop(id); return this.completionReviews.status(id)
  }
  /** @param id - original experiment. @param operationId - supplementary owner. @param input - bounded source cursor. @returns independently saved review Session events. */
  completionReviewTrace(id: ExperimentId, operationId: string, input: Omit<AgentRecordRequest, 'experimentId' | 'phase'>): Promise<AgentRecordPage> {
    this.get(id)
    if (this.completionReviews.status(id)?.operationId !== z.uuid().parse(operationId)) throw new Error('Supplementary trace belongs to another operation')
    return this.completionReviews.trace({ ...input, experimentId: id, phase: 'execution' })
  }

  private unconfirmedRemoteWork(): import('./types.ts').UnconfirmedWorkNotice[] {
    const notices = new Map<ExperimentId, import('./types.ts').UnconfirmedWorkNotice>()
    for (const [id, removal] of this.removals.table('removals').entries()) {
      if (removal.work === undefined || this.isRemoteTaskReleased(id)) continue
      notices.set(id, { experimentId: id, name: removal.name, serverIds: [...new Set(removal.work.nodes.flatMap(node => [node.server.id,
        ...this.servers().servers.filter(server => sameServerEndpoint(node.server, server)).map(server => server.id)]))] })
    }
    for (const [id, task] of this.remoteTasks.table('tasks').entries()) {
      if (!this.isRemoved(id) || this.isRemoteTaskReleased(id)) continue
      const status = this.remoteTaskStatus(id)!
      notices.set(id, { ...status, serverIds: [...new Set(task.work.nodes.flatMap(node => [node.server.id,
        ...this.servers().servers.filter(server => sameServerEndpoint(node.server, server)).map(server => server.id)]))] })
    }
    return [...notices.values()]
  }

  /** Compute removal eligibility without changing tasks or remote files.
   * @param rawIds - selected experiments. @returns node directories and outstanding obligations.
   */
  previewDeletion(rawIds: string[]): ExperimentDeletionPreview[] {
    const ids = z.array(experimentIdSchema).max(100).parse(rawIds)
    return ids.map(id => {
      const record = this.get(id)
      const interruption = this.interruptions.status(id)
      const interruptionPending = interruption !== undefined && interruption.phase !== 'released'
      const reason = interruptionPending ? 'cleanup-unconfirmed' : this.preparing.has(id) ? 'active' : this.installations.pending(id).length ? 'cleanup-unconfirmed' : experimentRemovalBlocker(record)
      const servers = [...new Map([record.coordinator, ...record.servers].map(server => [server.id, server])).values()]
      const nodes = servers.flatMap(server => {
        const placement = server.storagePlacement ?? record.preparation?.placements.find(value => value.serverId === server.id)
        return placement === undefined ? [] : [{ serverId: server.id, name: server.name, path: placement.runRoot }]
      })
      return { experimentId: id, name: record.request.name ?? record.request.objective.split('\n')[0]!.slice(0, 120),
        eligible: reason === undefined, recordDeletionAvailable: !interruptionPending, ...(reason === undefined ? {} : { reason }), cleanupAvailable: reason === undefined && nodes.length === servers.length, nodes }
    })
  }

  /** Remove confirmed terminal records, retaining failures and per-node cleanup receipts.
   * @param raw - explicit batch identity and cleanup choice. @returns independent outcomes, including skipped active records.
   */
  async deleteExperiments(raw: DeleteExperimentsRequest): Promise<ExperimentDeletion[]> {
    const input = deleteRequestSchema.parse(raw)
    await Promise.all(input.experimentIds.map(id => this.interruptions.wait(id)))
    if (!input.cleanupRemote) return Promise.all(input.experimentIds.map(id => this.deleteLocally(id, input)))
    return Promise.all(input.experimentIds.map(id => {
      const existing = this.deletionWork.get(id)
      if (existing !== undefined) return existing.then(job => {
        if (job.cleanupRemote !== input.cleanupRemote) throw new Error('Cleanup is already running with a different policy')
        return job
      })
      const abort = new AbortController(); this.cleanupControllers.set(id, abort)
      const work = this.deleteOne(id, input, abort.signal).finally(() => { this.deletionWork.delete(id); this.cleanupControllers.delete(id) })
      this.deletionWork.set(id, work)
      return work
    }))
  }

  private async deleteOne(id: ExperimentId, input: z.infer<typeof deleteRequestSchema>, signal: AbortSignal): Promise<ExperimentDeletion> {
    let job = await this.serial(async () => {
      if (this.closing) throw new Error('Experiment management is stopping')
      const prior = this.store.table('deletions').get(id)
      if (this.isRemoved(id) && prior !== undefined) return { ...prior, state: 'deleted' as const }
      if (prior?.operationId === input.operationId && prior.cleanupRemote !== input.cleanupRemote) throw new Error('Deletion identity has a different cleanup policy')
      const preview = this.previewDeletion([id])[0]!
      const failed = !preview.eligible || (input.cleanupRemote && !preview.cleanupAvailable)
      const next: ExperimentDeletion = { experimentId: id, operationId: input.operationId, cleanupRemote: input.cleanupRemote,
        started: !failed || prior?.started === true, state: failed ? 'failed' : 'deleting', updatedAt: Date.now(), nodes: preview.nodes.map(node => ({ serverId: node.serverId, path: node.path,
          state: prior?.nodes.some(old => old.serverId === node.serverId && old.path === node.path && old.state === 'cleaned') ? 'cleaned' : 'pending' })),
        ...(failed ? { detail: !preview.eligible ? 'Stop the experiment and confirm all resources are released before deleting'
          : 'Saved directory ownership is incomplete; only record deletion is available' } : {}) }
      await this.store.table('deletions').put(id, next)
      return next
    })
    if (job.state !== 'deleting') return job
    const record = this.get(id)
    try {
      if (job.cleanupRemote && !await this.environments.readyToDelete(id)) throw new Error('Original cache cleanup process exit is unconfirmed; remote experiment deletion is blocked')
      if (job.cleanupRemote) for (const node of job.nodes) {
        signal.throwIfAborted()
        if (node.state === 'cleaned') continue
        const server = [record.coordinator, ...record.servers].find(value => value.id === node.serverId)!
        const placement = server.storagePlacement ?? record.preparation?.placements.find(value => value.serverId === server.id)
        if (placement === undefined) throw new Error('Saved directory assignment is missing')
        const target = server.id === record.coordinator.id ? record.coordinatorTarget : record.targets[record.servers.findIndex(value => value.id === server.id)]!
        const names = server.id !== record.coordinator.id ? [] : [`${id}.json`, `${id}-model.json`,
          ...record.servers.flatMap(value => [`${id}-${value.id}.known_hosts`, ...(value.identityFile === undefined ? [] : [`${id}-${value.id}.identity`])])]
        const password = await this.password(server)
        try { await this.driver.cleanupServerStorage(this.connectionTarget(target), placement, names, password, signal) } catch (error) {
          const detail = password ? String(error).replaceAll(password, '[redacted]') : String(error)
          job = { ...job, nodes: job.nodes.map(value => value.serverId === node.serverId ? { ...value, detail } : value) }
          throw new Error(detail)
        }
        signal.throwIfAborted()
        job = { ...job, nodes: job.nodes.map(value => value.serverId === node.serverId ? { ...value, state: 'cleaned' } : value), updatedAt: Date.now() }
        await this.store.table('deletions').put(id, job)
      }
      job = await this.deleteLocally(id, input)
    } catch (error) {
      job = this.isRemoved(id) ? { ...job, state: 'deleted', updatedAt: Date.now() }
        : { ...job, state: 'failed', detail: String(error), updatedAt: Date.now() }
    }
    await this.store.table('deletions').put(id, job)
    return job
  }

  private isRemoved(id: ExperimentId): boolean {
    return this.removals.table('removals').get(id) !== undefined || this.store.table('deleted').get(id) !== undefined
  }

  private deletedIds(): ExperimentId[] {
    return [...new Set([...this.store.table('deleted').entries(), ...this.removals.table('removals').entries()].map(([id]) => id))]
  }

  private async deleteLocally(id: ExperimentId, input: z.infer<typeof deleteRequestSchema>): Promise<ExperimentDeletion> {
    await this.interruptions.wait(id)
    const result = await this.serial(async () => {
      const prior = this.store.table('deletions').get(id)
      if (this.isRemoved(id)) {
        const removal = this.removals.table('removals').get(id)
        return prior === undefined ? { experimentId: id, operationId: input.operationId, cleanupRemote: input.cleanupRemote,
          started: true, state: 'deleted' as const, nodes: [], updatedAt: removal?.identity.deletedAt ?? Date.now() } : { ...prior, state: 'deleted' as const }
      }
      if (this.closing) throw new Error('Experiment management is stopping')
      if (prior?.operationId === input.operationId && prior.cleanupRemote !== input.cleanupRemote) throw new Error('Deletion identity has a different cleanup policy')
      const record = this.get(id)
      const interruption = this.interruptions.status(id)
      if (interruption !== undefined && interruption.phase !== 'released') {
        const failed: ExperimentDeletion = { experimentId: id, operationId: input.operationId, cleanupRemote: input.cleanupRemote,
          state: 'failed', started: false, nodes: [], updatedAt: Date.now(), detail: 'Interruption exit verification is incomplete; retry interruption before deleting its recovery records' }
        await this.store.table('deletions').put(id, failed); return failed
      }
      const blocked = this.preparing.has(id) || this.installations.pending(id).length > 0 || experimentRemovalBlocker(record) !== undefined
      if (blocked && (!input.allowUnconfirmed || input.cleanupRemote)) {
        const failed: ExperimentDeletion = { experimentId: id, operationId: input.operationId, cleanupRemote: input.cleanupRemote,
          state: 'failed', started: prior?.started ?? false, nodes: prior?.nodes ?? [], updatedAt: Date.now(),
          detail: 'Remote release is unconfirmed; explicitly choose local record deletion or confirm release before file cleanup' }
        await this.store.table('deletions').put(id, failed); return failed
      }
      const credentialRefs: string[] = [...new Set([record.coordinator, ...record.servers].map(sshPasswordRef))]
      if (record.models !== undefined) for (const phase of experimentPhases) {
        credentialRefs.push(record.models[phase].configurationRef, ('ASPERA_KEY_' + id.replaceAll('-', '_') + '_' + phase).toUpperCase())
      }
      const identity = { experimentId: id, requestHash: createHash('sha256').update(JSON.stringify(record.request)).digest('hex'),
        deletedAt: Date.now(), ...(record.sourceGoal === undefined ? {} : { sourceGoal: record.sourceGoal }) }
      const removal: LocalRemoval = { identity, operationId: input.operationId, localCleanup: 'pending', credentialRefs,
        name: record.request.name ?? record.request.objective.split('\n')[0]!.slice(0, 120),
        ...(blocked ? { work: removedWork(record, record.submission === undefined ? undefined : createHash('sha256').update(JSON.stringify(record.submission)).digest('hex')) } : {}) }
      // This write hides the record even if compatibility writes or local cleanup are interrupted.
      await this.rememberRemoteTask(record)
      await this.removals.table('removals').put(id, removal)
      this.preparing.get(id)?.abort.abort(new Error('Local experiment record removed'))
      this.cleanupControllers.get(id)?.abort(new Error('Local experiment record removed'))
      for (const controller of this.requests.get(id) ?? []) controller.abort(new Error('Local experiment record removed'))
      const job: ExperimentDeletion = { experimentId: id, operationId: input.operationId, cleanupRemote: input.cleanupRemote,
        started: true, state: 'deleted', nodes: [], updatedAt: identity.deletedAt }
      await this.store.table('deletions').put(id, job)
      return job
    })
    if (result.state === 'deleted') this.beginLocalCleanup(id)
    return result
  }

  private beginLocalCleanup(id: ExperimentId): void {
    if (this.localCleanupWork.has(id)) return
    const work = this.finishLocalRemoval(id).catch(async error => {
      const removal = this.removals.table('removals').get(id)
      if (removal !== undefined) await this.removals.table('removals').put(id, { ...removal, error: redactObservation(String(error)) })
    }).finally(() => { this.localCleanupWork.delete(id) })
    this.localCleanupWork.set(id, work)
  }

  private async finishLocalRemoval(id: ExperimentId): Promise<void> {
    await this.publicServiceChecks.stop(id)
    await this.acceptanceRecoveries.forget(id)
    await this.completionReviews.forget(id)
    await this.finalizationRecords.forget(id)
    await this.environments.remove(id)
    await this.archives.stop(id)
    await this.interruptions.stop(id)
    await Promise.allSettled([this.preparing.get(id)?.done, this.acceptance.get(id)])
    await this.serial(async () => {
      const removal = this.removals.table('removals').get(id)
      if (removal === undefined || removal.localCleanup === 'complete') return
      await this.store.table('deleted').put(id, removal.identity)
      await this.store.table('experiments').delete(id)
      cleanupLocalInputs(this.uploadRoot, id)
      cleanupLocalInputs(resolve(resolveDshHome(), 'aspera-observations'), id)
      cleanupLocalInputs(resolve(resolveDshHome(), 'aspera-run-records'), id)
      cleanupLocalInputs(resolve(resolveDshHome(), 'aspera-service-verifications'), id)
      if (this.remoteTasks.table('tasks').get(id) === undefined) await this.interruptions.forget(id)
      const next = { ...removal, localCleanup: 'complete' as const }
      if (next.work?.submissionHash === undefined && next.work?.nodes.every(node => node.pendingDirectory === undefined) && this.installations.pending(id).length === 0) delete next.work
      delete next.error
      if (next.work === undefined) {
        cleanupLocalInputs(resolve(resolveDshHome(), 'aspera-controller-repairs'), id)
        await this.installations.forget(id)
      }
      await this.removals.table('removals').put(id, next)
      for (const ref of next.credentialRefs) await this.removeUnusedCredential(ref, id)
    })
  }

  /** Recheck deleted tasks using their original runtime and private connections, without submitting or stopping them.
   * @param id - current server registration. @param signal - optional owner cancellation; otherwise the connection-check deadline applies.
   * @returns remaining unresolved deleted experiment identities.
   */
  async reconcileRemovedWork(id: ExperimentServerId, signal?: AbortSignal): Promise<ExperimentId[]> {
    const lifetime = signal ?? AbortSignal.timeout(this.connectionCheckTimeoutMs)
    const server = this.servers().servers.find(value => value.id === id)
    if (server === undefined) throw new Error('Server is no longer configured')
    for (const [taskId, task] of this.remoteTasks.table('tasks').entries()) {
      if (!this.isRemoved(taskId) || this.isRemoteTaskReleased(taskId) || !task.work.nodes.some(node => sameServerEndpoint(node.server, server))) continue
      await this.interruptions.recover(taskId, lifetime)
    }
    for (const [experimentId, removal] of this.removals.table('removals').entries()) {
      const work = removal.work
      if (work === undefined || removal.localCleanup !== 'complete' || !work.nodes.some(node => sameServerEndpoint(node.server, server))) continue
      try {
        if (work.submissionHash !== undefined && !this.isRemoteTaskReleased(experimentId)) {
          const coordinator = work.nodes.find(node => node.server.id === work.coordinatorId)!
          const result = z.object({ record: clusterRecordSchema }).parse(await this.controlRequest(coordinator.server, coordinator.target, work.protocol,
            'status', { experimentId }, lifetime))
          if (createHash('sha256').update(JSON.stringify(result.record.submission)).digest('hex') !== work.submissionHash
            || !result.record.resourcesReleased || result.record.services.some(service => !service.released)
            || !['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(result.record.state)) continue
        }
        let settled = true
        for (const node of work.nodes) if (!await this.installations.reconcile(experimentId, node.server.id, this.resolvedTarget(node.target), await this.password(node.server), lifetime)) settled = false
        for (const node of work.nodes) if (node.pendingDirectory !== undefined) {
          const path = shellQuote(node.pendingDirectory + '/exited')
          const exit = await this.driver.remote(this.connectionTarget(node.target), 'if [ -f ' + path + ' ]; then cat ' + path + '; else printf unknown; fi', lifetime, await this.password(node.server))
          if (!/^\d+\s*$/.test(exit)) settled = false
        }
        if (!settled) continue
        await this.serial(async () => {
          const current = this.removals.table('removals').get(experimentId)
          if (current === undefined || JSON.stringify(current.work) !== JSON.stringify(work)) return
          const { work: _released, ...released } = current
          await this.removals.table('removals').put(experimentId, released)
          cleanupLocalInputs(resolve(resolveDshHome(), 'aspera-controller-repairs'), experimentId)
          await this.installations.forget(experimentId)
          for (const node of work.nodes) await this.removeUnusedCredential(sshPasswordRef(node.server))
        })
      } catch (error) {
        lifetime.throwIfAborted()
        // An unreachable or mismatched old runtime retains its ownership evidence.
        void error
      }
    }
    return this.unconfirmedRemoteWork().filter(value => value.serverIds.includes(id)).map(value => value.experimentId)
  }

  private async token(server: ServerSettings, role: 'coordinator' | 'node'): Promise<string> {
    const ref = credentialRef(`ASPERA_CLUSTER_${role.toUpperCase()}_${server.id.replaceAll('-', '_')}`)
    let pending = this.tokens.get(ref)
    if (pending === undefined) {
      pending = (async () => {
        const saved = await this.ctx.credentials.resolve(ref)
        if (saved !== undefined) return saved.value
        const value = randomBytes(32).toString('hex')
        await this.ctx.credentials.set(ref, value)
        return value
      })()
      this.tokens.set(ref, pending)
      void pending.catch(() => { this.tokens.delete(ref) })
    }
    return pending
  }

  /**
   * Check SSH connectivity and report GPU and allocation facts within the configured deadline.
   * @param id - configured server.
   * @returns saved success or failure after cancelled SSH operations settle; concurrent checks share this result.
   */
  probe(id: ExperimentServerId): Promise<ServerConnectionCheck> {
    const existing = this.checks.get(id)
    if (existing !== undefined) return existing
    const work = this.checkServer(id).finally(() => { this.checks.delete(id) })
    this.checks.set(id, work)
    return work
  }

  private async checkServer(id: ExperimentServerId): Promise<ServerConnectionCheck> {
    const server = this.servers().servers.find(server => server.id === id)
    if (server === undefined) throw new Error('Server is no longer configured')
    const configuration = connectionConfiguration(server)
    const startedAt = Date.now()
    const previous = this.servers().checks?.[id]
    const checking: ServerConnectionCheck = { status: 'checking', configuration, startedAt,
      ...(previous?.lastSuccess === undefined ? {} : { lastSuccess: previous.lastSuccess }) }
    const deadline = new AbortController()
    this.checkControllers.set(id, deadline)
    const timer = setTimeout(() => {
      deadline.abort(new Error(`Connection check timed out after ${this.connectionCheckTimeoutMs / 1000} ${this.connectionCheckTimeoutMs === 1000 ? 'second' : 'seconds'}`))
    }, this.connectionCheckTimeoutMs)
    const signal = deadline.signal
    let check: ServerConnectionCheck
    let password: string | undefined
    try {
      await this.serial(async () => {
        const registry = this.servers()
        if (!registry.servers.some(value => value.id === id && connectionConfiguration(value) === configuration)) throw new Error('Server configuration changed before the check began')
        await this.store.table('registry').put('servers', { ...registry, checks: { ...registry.checks, [id]: checking } })
      })
      signal.throwIfAborted()
      const deployment = this.reuseExecutablePaths(server.id, this.deployment(server))
      const target = { ...deployment, toolTimeoutMs: Math.min(deployment.toolTimeoutMs, this.connectionCheckTimeoutMs) }
      await this.driver.prepareSshHostKey(target, signal)
      signal.throwIfAborted()
      password = await this.password(server)
      signal.throwIfAborted()
      const directory = server.storagePreference?.mode === 'manual' ? server.storagePreference.directory
        : server.storagePreference === undefined ? server.remoteRoot : undefined
      const environment = await this.driver.inspectEnvironment(target, password, signal)
      signal.throwIfAborted()
      const readiness = checkEnvironment(environment, this.driver.environmentRequirements(target.localRepo), target.pathEntries)
      const token = await this.token(server, 'node')
      signal.throwIfAborted()
      const observations = await Promise.allSettled([this.driver.inspectServerStorage(target, directory, password, signal),
        this.driver.remote(target, 'nvidia-smi -L', signal, password),
        this.driver.request(target, token, '/aspera/v1/health', 'GET', undefined, signal, password)])
      signal.throwIfAborted()
      const inventory = observations[0].status === 'fulfilled' ? observations[0].value : undefined
      const gpuInfo = observations[1].status === 'fulfilled' ? observations[1].value : ''
      const health = observations[2].status === 'fulfilled' && observations[2].value.status === 200
        ? z.object({ node: z.object({ allocations: z.array(z.string()) }) }).safeParse(observations[2].value.value) : undefined
      const result: ServerProbe = { gpuInfo, allocations: health?.success ? health.data.node.allocations : [],
        ...(inventory === undefined ? {} : { inventory }), environment, environmentReady: readiness.ready,
        ...(!readiness.ready ? { detail: readiness.failures.join('\n') } : observations[0].status === 'rejected' ? { detail: String(observations[0].reason) } : {}) }
      const checkedAt = Date.now()
      check = { status: 'passed', configuration, startedAt, checkedAt, result, lastSuccess: { checkedAt, result },
        gpu: observations[1].status === 'fulfilled' && gpuInfo.trim() !== '' ? 'passed' : 'unavailable', control: health?.success ? 'passed' : 'unavailable' }
    } catch (error) {
      const message = String(signal.aborted ? signal.reason : error)
      check = { ...checking, status: 'failed', checkedAt: Date.now(), error: password ? message.replaceAll(password, '[redacted]') : message }
    } finally { clearTimeout(timer); if (this.checkControllers.get(id) === deadline) this.checkControllers.delete(id) }
    return this.serial(async () => {
      const registry = this.servers()
      if (registry.checks?.[id]?.startedAt !== startedAt || !registry.servers.some(value => value.id === id && connectionConfiguration(value) === configuration)) {
        return registry.checks?.[id] ?? { status: 'unchecked', configuration }
      }
      await this.store.table('registry').put('servers', { ...registry, checks: { ...registry.checks, [id]: check } })
      return check
    })
  }

  /**
   * Read experiments in their durable display order.
   * @returns independent experiments in most-recent-first order.
   */
  list(): FleetExperiment[] { return [...this.store.table('experiments').entries()].filter(([id]) => !this.isRemoved(id)).map(([, record]) => record).sort((a,
    b) => b.createdAt - a.createdAt) }

  private get(id: ExperimentId): FleetExperiment {
    const record = !this.isRemoved(id) ? this.store.table('experiments').get(id) : undefined
    if (record === undefined) throw new Error('experiment not found')
    return record
  }

  /**
   * Stage bounded input bytes with idempotent byte offsets.
   * @param id - new experiment.
   * @param name - basename.
   * @param offset - expected upload cursor.
   * @param data - bounded base64 bytes.
   * @returns next byte offset.
   */
  upload(id: ExperimentId, name: string, offset: number, data: string): { nextOffset: number } {
    experimentIdSchema.parse(id)
    clusterSubmissionV2Schema.shape.inputs.element.shape.name.parse(name)
    const submitted = this.get(id)
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid upload offset')
    const bytes = Buffer.from(data, 'base64')
    if (bytes.length > 65536) throw new Error('upload chunk exceeds 64 KiB')
    const directory = resolve(this.uploadRoot, id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = resolve(directory, name)
    const size = existsSync(path) ? statSync(path).size : 0
    if ((offset < size || (submitted !== undefined && submitted.state !== 'staging')) && offset + bytes.length <= size) {
      const existing = Buffer.alloc(bytes.length)
      const fd = openSync(path, 'r')
      try { readSync(fd, existing, 0, existing.length, offset) } finally { closeSync(fd) }
      if (!existing.equals(bytes)) throw new Error('upload retry contains different bytes')
      return { nextOffset: offset + bytes.length }
    }
    if (submitted?.state !== 'staging') throw new Error('create a staging experiment before uploading inputs')
    const declared = submitted.request.uploads.find(file => file.name === name)
    if (declared === undefined) throw new Error('input is not declared by this experiment')
    if (offset + bytes.length > declared.size) throw new Error('input exceeds its declared size')
    if (offset !== size) throw new Error('upload offset does not match saved bytes')
    appendFileSync(path, bytes, { mode: 0o600 })
    return { nextOffset: size + bytes.length }
  }

  /**
   * Persist an independent experiment before beginning asynchronous preparation.
   * @param raw - user goal, explicitly selected servers, and admitted inputs.
   * @param sourceGoal - optional caller Goal revision bound to this dispatch.
   * @returns saved preparation immediately.
   */
  async create(raw: FleetCreateRequest, sourceGoal?: FleetExperiment['sourceGoal']): Promise<FleetExperiment> {
    const input = requestSchema.parse(raw)
    return this.serial(async () => {
      if (this.closing) throw new Error('experiment dispatch is stopping')
      if (this.isRemoved(input.experimentId) || (sourceGoal !== undefined && [...this.store.table('deleted').entries(), ...[...this.removals.table('removals').entries()].map(([id, value]) => [id, value.identity] as const)].some(([, value]) =>
        value.sourceGoal?.sessionId === sourceGoal.sessionId && value.sourceGoal.id === sourceGoal.id && value.sourceGoal.revision === sourceGoal.revision))) throw new Error('Experiment was deleted; copy to a new experiment')
      const previous = this.store.table('experiments').get(input.experimentId) ?? (sourceGoal === undefined ? undefined
        : this.list().find(row => row.sourceGoal?.sessionId === sourceGoal.sessionId
          && row.sourceGoal.id === sourceGoal.id && row.sourceGoal.revision === sourceGoal.revision))
      if (previous !== undefined) {
        if (JSON.stringify(previous.request) !== JSON.stringify({ ...input,
          experimentId: previous.request.experimentId })) throw new Error('experiment id is bound to different requirements')
        return previous
      }
      const registry = this.servers()
      const unresolved = [...this.removals.table('removals').entries()].find(([id, removal]) => !this.isRemoteTaskReleased(id)
        && (this.remoteTasks.table('tasks').get(id) === undefined || this.remoteTasks.table('tasks').get(id)!.work.nodes.some(node => !input.serverIds.includes(node.server.id)) || this.installations.pending(id).length > 0
          || removal.work?.nodes.some(node => node.pendingDirectory !== undefined)) && removal.work?.nodes.some(node =>
          registry.servers.some(server => input.serverIds.includes(server.id) && sameServerEndpoint(node.server, server))))
      if (unresolved !== undefined) throw new Error('Selected nodes have unconfirmed remote work from a deleted experiment; recheck the server before submitting')
      const coordinator = registry.servers.find(server => server.id === input.coordinatorId)
      const conflict = this.list().find(row => row.coordinator.id !== input.coordinatorId && (experimentRemovalBlocker(row, this.interruptions.status(row.request.experimentId)) !== undefined || this.preparing.has(row.request.experimentId) || this.deletionWork.has(row.request.experimentId))
        && [row.coordinator.id, ...row.servers.map(server => server.id)].some(id => input.serverIds.includes(id)))
      if (conflict !== undefined) throw new Error(`Selected nodes are assigned to experiment ${conflict.request.name ?? conflict.request.experimentId} under another coordinator; finish that experiment or use its coordinator`)
      if (coordinator === undefined) throw new Error('configure the coordinator server before submitting an experiment')
      if (input.models === undefined) throw new Error('Select preparation, planning and execution models before submitting')
      const models = await captureExperimentModels(this.ctx, input.experimentId, input.models)
      const selected = input.serverIds.map((id) => {
        const server = registry.servers.find(server => server.id === id)
        if (server === undefined) throw new Error('selected server is no longer configured')
        return server
      })
      const pinned = new Map<ExperimentServerId, ServerSettings>()
      for (const server of [coordinator, ...selected]) {
        if (pinned.has(server.id)) continue
        const password = await this.password(server)
        const ref = `ASPERA_SSH_${input.experimentId.replaceAll('-', '_')}_${server.id.replaceAll('-', '_')}`
        if (password === undefined) throw new Error('Aspera requires password login')
        await this.ctx.credentials.set(credentialRef(ref), password)
        pinned.set(server.id, { ...server, passwordRef: ref })
      }
      const pinnedCoordinator = pinned.get(coordinator.id)
      if (pinnedCoordinator === undefined) throw new Error('coordinator snapshot is missing')
      const servers = selected.map(server => { const value = pinned.get(server.id); if (value === undefined) throw new Error('node snapshot is missing'); return value })
      const sessionId = SessionId(`aspera-dispatch-${input.experimentId}`)
      const record: FleetExperiment = { request: input, coordinator: pinnedCoordinator, servers,
        coordinatorTarget: pinnedTargetSchema.parse(this.deployment(pinnedCoordinator)),
        targets: servers.map(server => pinnedTargetSchema.parse(this.deployment(server))), createdAt: Date.now(),
        agentModel: { provider: models.preparation.provider, model: models.preparation.model,
          ...(models.preparation.reasoningEffort === undefined ? {} : { reasoningEffort: models.preparation.reasoningEffort }) }, models,
        state: input.uploads.length > 0 ? 'staging' : 'preparing', sessionId, waitingFor: [], handoverRecorded: false,
        preparation: { protocol: 4, stage: 'inspecting', inventories: [], placements: [] },
        ...(sourceGoal === undefined ? {} : { sourceGoal }) }
      await this.installations.pin(input.experimentId, [pinnedCoordinator.id, ...servers.map(server => server.id)])
      await this.store.table('experiments').put(input.experimentId, record)
      if (record.state === 'preparing') this.beginPreparation(input.experimentId)
      return record
    })
  }

  /**
   * Bind an independent experiment to the caller's exact Goal revision.
   * @param agent - local caller with an active Goal.
   * @param objective - authorized requirements.
   * @param serverIds - explicitly selected participants.
   * @param coordinatorId - selected participant responsible for coordination.
   * @param files - admitted local data files.
   * @param mode - plan confirmation policy.
   * @param models - explicit phase model selections.
   * @param name - optional short experiment label.
   * @returns independent experiment, deduplicated by the caller's Goal revision.
   */
  async createForGoal(agent: Agent, objective: string, serverIds: string[], coordinatorId: string, files: string[], mode: FleetCreateRequest['mode'], models: ExperimentModels, name?: string): Promise<FleetExperiment> {
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined || goal.phase === 'complete') throw new Error('cluster dispatch requires an active local Goal')
    return this.create({ experimentId: randomUUID(), objective, serverIds, coordinatorId, files, mode, models, ...(name === undefined ? {} : { name }) }, { sessionId: agent.id, id: goal.id,
      revision: goal.revision })
  }

  private beginPreparation(id: ExperimentId): void {
    const abort = new AbortController()
    const done = Promise.resolve().then(() => this.prepare(id, abort.signal))
    void done.catch((error: unknown) => { this.ctx.logger.error(`Aspera preparation cleanup failed: ${String(error)}`) })
    this.preparing.set(id, { abort, done })
  }

  /** Resume an interrupted v4 preparation using its saved model configuration, servers, inputs and directories.
   * @param id - existing experiment. @returns its current preparation or reconciled receipt.
   */
  async retry(id: ExperimentId): Promise<FleetExperiment> {
    this.assertInterruptionSettled(id)
    if (this.get(id).submission !== undefined) return this.refresh(id)
    return this.serial(async () => {
      const current = this.get(id)
      if (this.closing) throw new Error('Experiment dispatch is stopping')
      const deletion = this.store.table('deletions').get(id)
      if (deletion?.started) throw new Error('Experiment cleanup was requested; copy to start a new experiment')
      if (this.preparing.has(id) || current.state === 'submitted') return current
      if (current.preparation?.protocol !== 4 || current.models === undefined) throw new Error('Copy this legacy preparation to a new experiment')
      if (current.state !== 'failed') throw new Error('Only interrupted or failed preparation can be retried')
      const serverIds = [...new Set([current.coordinator.id, ...current.servers.map(server => server.id)])]
      const placements = current.preparation.placements
      const beforeRelease = this.installations.has(id) && current.preparation.stage === 'inspecting'
        && placements.length === 0 && current.preparation.inventories.length === 0
        && !current.preparation.environments?.length && current.latest === undefined && current.receipt === undefined && !current.handoverRecorded
      if (!beforeRelease && !this.installations.material(id) && (placements.length !== serverIds.length || serverIds.some(serverId =>
        !placements.some(placement => placement.serverId === serverId && /\/[a-f0-9]{64}$/.test(placement.releaseRoot))))) {
        throw new Error('Original release directories are missing from the preparation record; copy this experiment')
      }
      await this.installations.pin(id, serverIds)
      for (const server of [...new Map([current.coordinator, ...current.servers].map(server => [server.id, server])).values()]) {
        if (this.installations.pending(id).includes(server.id)) {
          const target = server.id === current.coordinator.id ? current.coordinatorTarget : current.targets[current.servers.findIndex(value => value.id === server.id)]!
          if (!await this.installations.stop(id, server.id, this.resolvedTarget(target), await this.password(server), AbortSignal.timeout(this.connectionCheckTimeoutMs))) throw new Error('Previous installation exit remains unconfirmed; retry is blocked')
        }
      }
      for (const serverId of serverIds) await this.installations.startBudget(id, serverId, true)
      const next = { ...current, state: 'preparing' as const }
      delete next.detail
      await this.store.table('experiments').put(id, next)
      this.beginPreparation(id)
      return next
    })
  }

  /** Commit staged attachments before deploying. @param id - staging experiment. @returns durable preparation record. */
  async commitInputs(id: ExperimentId): Promise<FleetExperiment> {
    return this.serial(async () => {
      const current = this.get(id)
      if (current.state !== 'staging') return current
      for (const file of current.request.uploads) {
        const path = resolve(this.uploadRoot, id, file.name)
        if (!existsSync(path) || statSync(path).size !== file.size) throw new Error(`input upload is incomplete: ${file.name}`)
      }
      const next = { ...current, state: 'preparing' as const }
      await this.store.table('experiments').put(id, next)
      this.beginPreparation(id)
      return next
    })
  }

  /** Confirm a saved plan remotely. @param id - experiment. @param revision - displayed plan. @returns updated record. */
  async approve(id: ExperimentId, revision: number): Promise<FleetExperiment> {
    this.assertInterruptionSettled(id)
    await this.call(this.get(id), 'approve', { experimentId: id, revision })
    return this.refresh(id)
  }

  /** Stop a registered service without depending on its Agent. @param id - experiment. @param serviceId - process identity. @returns updated record. */
  async stopService(id: ExperimentId, serviceId: string): Promise<FleetExperiment> {
    await this.call(this.get(id), 'stop-service', { experimentId: id, serviceId })
    return this.refresh(id)
  }

  /** Access an inference endpoint through managed SSH and the coordinator. @param id - experiment. @param serviceId - process identity. @param path - relative HTTP path. @param method - HTTP method. @param body - optional JSON body. @param signal - cancellation. @returns bounded HTTP response. */
  async accessService(id: ExperimentId, serviceId: string, path: string, method: 'GET' | 'POST', body?: string, signal?: AbortSignal): Promise<unknown> {
    return this.call(this.get(id), 'access-service', { experimentId: id, serviceId, path, method, body }, signal)
  }

  /** Read a service-only credential on explicit operator request; never persists it in a receipt.
   * @param id - owning experiment. @param serviceId - registered public service. @returns private calling information.
   */
  async serviceAccessInfo(id: ExperimentId, serviceId: string): Promise<import('@aspera/experiments').ServiceAccessInfo> {
    return serviceAccessInfoSchema.parse(await this.call(this.get(id), 'service-access-info', { experimentId: id, serviceId }))
  }

  private async prepare(id: ExperimentId, signal: AbortSignal): Promise<void> {
    let source: Awaited<ReturnType<typeof snapshotSource>> | undefined
    let modelScope: Awaited<ReturnType<typeof openPhaseModelContext>> | undefined
    try {
      let record = this.get(id)
      if (record.preparation?.protocol !== 4 || record.models === undefined) throw new Error('Legacy preparation retains its original model settings; copy it to a new experiment')
      const pendingTarget = record.coordinatorTarget
      const selection = record.agentModel
      modelScope = await openPhaseModelContext(this.ctx, record.models.preparation, this.agentContext)
      const storage = new StorageSelection(async (observation, experimentId, deploymentId, operation, input, operationSignal) =>
        preparationStorage({ ...observation, id: experimentId, deploymentId, operation, input, policy: this.environmentPolicy, signal: operationSignal,
          transport: {
            run: async (server, command, activeSignal, input) => {
              const target = server.id === record.coordinator.id ? record.coordinatorTarget : record.targets[record.servers.findIndex(item => item.id === server.id)]
              if (target === undefined) throw new Error('Preparation storage server is outside this experiment')
              return this.driver.remote(target, command, activeSignal, await this.password(server), input)
            },
            inspect: async (server, activeSignal) => {
              const target = server.id === record.coordinator.id ? record.coordinatorTarget : record.targets[record.servers.findIndex(item => item.id === server.id)]
              if (target === undefined) throw new Error('Preparation storage server is outside this experiment')
              return this.driver.inspectServerStorage(target, server.storagePreference?.mode === 'manual' ? server.storagePreference.directory : undefined,
                await this.password(server), activeSignal)
            },
          } }))
      const environment = new EnvironmentPreparation(this.commandPolicy)
      const options = { agentOptions: { ...selection },
        setup: async (ctx: Context, agent: Agent) => { installModelSelection(ctx, { current: selection, assembled: undefined }); storage.install(ctx, agent); environment.install(ctx, agent) } }
      const storedSession = await this.ctx.sessionPersistence.stat(SessionId(record.sessionId), { signal })
      if (storedSession === undefined && record.goalId !== undefined) throw new Error('The recorded dispatch Session is missing; copy to a new experiment')
      const handle = storedSession === undefined
        ? await modelScope.context.agents.create({ sessionId: SessionId(record.sessionId), meta: { cwd: pendingTarget.localRepo }, ...options })
        : await modelScope.context.agents.resume({ resumeSessionId: SessionId(record.sessionId), ...options })
      this.handles.set(id, handle)
      signal.throwIfAborted()
      const goal = this.ctx.goals.get(handle.agent) ?? (record.goalId === undefined
        ? this.ctx.goals.create(handle.agent, { objective: record.request.objective }) : undefined)
      if (goal === undefined || (record.goalId !== undefined && (goal.id !== record.goalId || goal.revision !== record.goalRevision))) {
        throw new Error('Dispatch Goal changed; copy the requirements to a new experiment')
      }
      this.ctx.goals.disarm(handle.agent)
      await this.ctx.sessionPersistence.flush()
      record = await this.serial(async () => {
        signal.throwIfAborted()
        const next = { ...this.get(id), goalId: goal.id, goalRevision: goal.revision }
        await this.store.table('experiments').put(id, next)
        return next
      })
      const preparation = record.preparation
      if (preparation === undefined) throw new Error('Storage preparation is missing')
      const unique = [...new Map([record.coordinator, ...record.servers].map(server => [server.id, server])).values()]
      const targetFor = (server: ServerSettings): PinnedDeployment => {
        if (server.id === record.coordinator.id) return this.connectionTarget(record.coordinatorTarget)
        const index = record.servers.findIndex(value => value.id === server.id)
        const target = record.targets[index]
        if (target === undefined) throw new Error('Selected server has no pinned preparation settings')
        return this.connectionTarget(target)
      }
      for (const server of unique) {
        await this.installations.startBudget(id, server.id)
        await this.driver.prepareSshHostKey(targetFor(server), this.installations.signal(id, server.id, signal))
      }
      const installationSignal = AbortSignal.any(unique.map(server => this.installations.signal(id, server.id, signal)))
      const retained = this.installations.material(id)
      const savedDigest = retained?.digest ?? preparation.placements[0]?.releaseRoot.split('/').at(-1)
      if (savedDigest === undefined) source = await this.driver.snapshotSource(pendingTarget.localRepo, pendingTarget.toolTimeoutMs, installationSignal)
      const snapshot: DeploymentRelease = source ?? { digest: z.string().regex(/^[a-f0-9]{64}$/).parse(savedDigest), reuse: true }
      if (preparation.placements.some(placement => !placement.releaseRoot.endsWith('/' + snapshot.digest))) throw new Error('Saved server releases differ; copy this experiment')
      const requirements = source === undefined
        ? await this.installations.recover(id, snapshot.digest, pendingTarget, await this.password(record.coordinator), installationSignal)
        : this.driver.environmentRequirements(pendingTarget.localRepo)
      if (source !== undefined) await this.installations.retain(id, source, requirements)
      const files = record.request.files.map(path => this.localInput(path, pendingTarget.dataRoots))
      for (const file of record.request.uploads) files.push(resolve(this.uploadRoot, id, file.name))
      const inputs: { name: string; sha256: string }[] = []
      for (const file of files) {
        const name = basename(file)
        if (inputs.some(input => input.name === name)) throw new Error('Input file names must be unique')
        inputs.push({ name, sha256: await clusterFileHash(file) })
      }
      if (preparation.inputs !== undefined && JSON.stringify(preparation.inputs) !== JSON.stringify(inputs)) {
        throw new Error('Experiment inputs changed after preparation; copy to a new experiment')
      }
      record = await this.preparationStage(id, preparation.stage, { inputs })
      const environmentInput = async (server: ServerSettings, target: PinnedDeployment, operation: EnvironmentPreparationInput['operation']): Promise<EnvironmentPreparationInput> => ({
        experimentId: id, serverId: server.id, serverName: server.name, target: this.connectionTarget(target), requirements, operation,
        controlRoot: target.remoteRoot, password: await this.password(server),
        directories: target.storagePlacement === undefined ? undefined : {
          workspace: target.storagePlacement.workspaceRoot, release: target.storagePlacement.releaseRoot, control: target.storagePlacement.controlRoot,
        },
        observation: await this.driver.inspectEnvironment(this.connectionTarget(target), await this.password(server), operation === 'controller' ? signal : this.installations.signal(id, server.id, signal)),
        pendingCommand: this.get(id).preparation?.environments?.find(value => value.serverId === server.id)?.pendingCommand,
        outputChars: target.preparationOutputChars, commandDeadline: operation === 'controller' ? undefined : this.installations.deadline(id, server.id),
        installation: operation === 'deployment' ? this.installations.tools(id, server.id, this.resolvedTarget(target), await this.password(server), handle.agent.session.id) : undefined,
        sandbox: new SandboxRepair({ experimentId: id, serverId: server.id, controlRoot: target.remoteRoot,
          password: await this.password(server), policy: this.sandboxRepairPolicy, minimumFreeBytes: this.environmentPolicy.minimumFreeBytes }, this.driver),
        progress: value => this.environmentProgress(id, value),
      })
      for (const server of unique) {
        await this.installations.startBudget(id, server.id)
        await this.onServer(server.id, signal, async () => {
          const target = this.reuseExecutablePaths(server.id, targetFor(server))
          const result = await environment.ensure(handle.agent, await environmentInput(server, target, 'bootstrap'), this.driver,
            async (candidate, observed) => {
              const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
              if (!checked.ready) throw new Error(checked.failures.join('\n'))
              return checked.toolchain
            }, this.installations.signal(id, server.id, signal))
          record = await this.saveExecutablePaths(id, server.id, result.value.pathEntries)
        }, id)
      }
      let inventories = record.preparation?.inventories ?? []
      if (inventories.length === 0) {
        const observations = await Promise.allSettled(unique.map(async server => {
          const directory = server.storagePreference?.mode === 'manual' ? server.storagePreference.directory
            : server.storagePreference === undefined ? server.remoteRoot : undefined
          return { serverId: server.id, inventory: await this.driver.inspectServerStorage(targetFor(server), directory, await this.password(server), this.installations.signal(id, server.id, signal)) }
        }))
        inventories = observations.map(result => { if (result.status === 'rejected') throw result.reason; return result.value })
        record = await this.preparationStage(id, 'selecting-storage', { inventories })
      }
      let placements = record.preparation?.placements ?? []
      if (placements.length === 0) {
        if (pendingTarget.minimumFreeBytes === undefined) throw new Error('Storage reserve is absent from the pinned deployment policy')
        const selected = await storage.run(handle.agent, id, snapshot.digest, unique.map(server => {
          const observed = inventories.find(value => value.serverId === server.id)
          if (observed === undefined) throw new Error('Server inventory is missing')
          return { server, inventory: observed.inventory }
        }), pendingTarget.minimumFreeBytes, installationSignal)
        await this.ctx.sessionPersistence.flush()
        record = await this.preparationStage(id, 'preparing-storage', selected)
        placements = selected.placements; inventories = selected.inventories
      } else {
        const selected = await refreshStorageSelection({ id, digest: snapshot.digest, servers: unique,
          saved: { placements, inventories }, signal: installationSignal,
          inspect: (server, activeSignal) => this.onServer(server.id, activeSignal, async () => this.driver.inspectServerStorage(targetFor(server),
            placements.find(row => row.serverId === server.id)!.candidate.directory, await this.password(server), activeSignal), id),
        })
        handle.agent.inject(createUserMessage({ source: { kind: 'aspera', experimentId: id }, content: [{ type: 'text',
          text: JSON.stringify({ operation: 'verify-fixed-experiment-storage', experimentId: id, placements: selected.placements,
            observedAt: selected.inventories.map(row => ({ serverId: row.serverId, observedAt: row.inventory.observedAt })) }) }] }))
        await this.ctx.sessionPersistence.flush()
        record = await this.preparationStage(id, 'preparing-storage', selected)
        placements = selected.placements; inventories = selected.inventories
      }
      const resolvedServer = (server: ServerSettings): ClusterServer => {
        const placement = placements.find(value => value.serverId === server.id)
        if (placement === undefined) throw new Error('Storage selection is incomplete')
        const { storagePreference: _preference, ...connection } = server
        return clusterServerSchema.parse({ ...connection, remoteRoot: placement.controlRoot, storagePlacement: placement })
      }
      const resolvedCoordinator = resolvedServer(record.coordinator)
      const resolvedNodes = record.servers.map(resolvedServer)
      record = await this.serial(async () => {
        signal.throwIfAborted()
        const current = this.get(id)
        const next = { ...current, coordinator: resolvedCoordinator, servers: resolvedNodes,
          coordinatorTarget: { ...current.coordinatorTarget, remoteRoot: resolvedCoordinator.remoteRoot, storagePlacement: resolvedCoordinator.storagePlacement },
          targets: current.targets.map((target, index) => ({ ...target, remoteRoot: resolvedNodes[index].remoteRoot, storagePlacement: resolvedNodes[index].storagePlacement })) }
        await this.store.table('experiments').put(id, next)
        return next
      })
      let target = this.resolvedTarget(record.coordinatorTarget)
      const coordinatorPassword = await this.password(record.coordinator)
      const coordinatorToken = await this.token(record.coordinator, 'coordinator')
      const controllerAcceptances = new Map<string, ControllerRepair>()
      const startRole = async (server: ServerSettings, pending: PinnedDeployment, prepared: PreparedEnvironment, role: 'coordinator' | 'node', token: string, password: string | undefined) => {
        const repair = new ControllerRepair({ experimentId: id, serverId: server.id, role, target: this.resolvedTarget(pending), prepared,
          token, password, maxAttempts: this.controllerRepairMaxAttempts, ...this.interruptionRecovery(id) }, this.driver)
        const result = await environment.ensure(handle.agent, { ...await environmentInput(server, pending, 'controller'), controller: repair }, this.driver,
          async (candidate, observed, operationSignal) => {
            const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
            if (!checked.ready) throw new Error(checked.failures.join('\n'))
            return repair.verify(operationSignal, checked.toolchain.pathEntries)
          }, signal)
        record = await this.saveExecutablePaths(id, server.id, result.pathEntries)
        controllerAcceptances.set(`${server.id}-${role}`, repair)
        return { target: { ...this.resolvedTarget(pending), pathEntries: result.pathEntries }, prepared: result.value }
      }
      const preparedCoordinator = await this.onServer(record.coordinator.id, signal, async () => {
        const placement = resolvedCoordinator.storagePlacement
        if (placement === undefined) throw new Error('Coordinator storage is missing')
        await this.preparationStage(id, 'deploying')
        const result = await environment.ensure(handle.agent, await environmentInput(record.coordinator, record.coordinatorTarget, 'deployment'), this.driver,
          async (candidate, observed, operationSignal, callId) => {
            const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
            if (!checked.ready) throw new Error(checked.failures.join('\n'))
            const configured = { ...target, pathEntries: checked.toolchain.pathEntries }
            await this.driver.prepareServerStorage(configured, placement, coordinatorPassword, operationSignal, 0, requirements.registrationFormat === '0.1.3')
            return this.driver.prepareClusterServer(configured, snapshot, coordinatorPassword, operationSignal,
              () => this.installations.ensure(id, record.coordinator.id, configured, coordinatorPassword, operationSignal, { sessionId: handle.agent.session.id, callId }))
          }, this.installations.signal(id, record.coordinator.id, signal))
        await this.installations.verified(id, record.coordinator.id)
        const prepared = result.value
        target = { ...target, pathEntries: result.pathEntries }
        record = await this.saveExecutablePaths(id, record.coordinator.id, result.pathEntries)
        const started = await startRole(record.coordinator, record.coordinatorTarget, prepared, 'coordinator', coordinatorToken, coordinatorPassword)
        target = started.target
        return started.prepared
      }, id)
      const preparedNodes: ClusterNode[] = []
      for (const [index, server] of resolvedNodes.entries()) preparedNodes.push(await this.onServer(server.id, signal, async () => {
        const pendingNode = record.targets[index]
        if (pendingNode === undefined) throw new Error('selected server has no pinned deployment settings')
        let nodeTarget = this.resolvedTarget(pendingNode)
        const password = await this.password(server)
        if (server.storagePlacement === undefined) throw new Error('Node storage is missing')
        const nodePlacement = server.storagePlacement
        const result = server.id === record.coordinator.id ? { value: preparedCoordinator, pathEntries: [...(target.pathEntries ?? [])] }
          : await environment.ensure(handle.agent, await environmentInput(server, pendingNode, 'deployment'), this.driver,
            async (candidate, observed, operationSignal, callId) => {
              const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
              if (!checked.ready) throw new Error(checked.failures.join('\n'))
              const configured = { ...nodeTarget, pathEntries: checked.toolchain.pathEntries }
              await this.driver.prepareServerStorage(configured, nodePlacement, password, operationSignal, 0, requirements.registrationFormat === '0.1.3')
              return this.driver.prepareClusterServer(configured, snapshot, password, operationSignal,
                () => this.installations.ensure(id, server.id, configured, password, operationSignal, { sessionId: handle.agent.session.id, callId }))
            }, this.installations.signal(id, server.id, signal))
        await this.installations.verified(id, server.id)
        const prepared = result.value
        nodeTarget = { ...nodeTarget, pathEntries: result.pathEntries }
        record = await this.saveExecutablePaths(id, server.id, result.pathEntries)
        const started = await startRole(server, record.targets[index], prepared, 'node', await this.token(server, 'node'), password)
        nodeTarget = started.target
        return this.driver.describeClusterNode(server, started.prepared)
      }, id))
      let nodes = preparedNodes
      await this.preparationStage(id, 'checking-network')
      for (const server of resolvedNodes) await this.onServer(server.id, signal, async () => {
        const pending = targetFor(server)
        const result = await environment.ensure(handle.agent, await environmentInput(server, pending, 'network'), this.driver,
          async (candidate, observed, operationSignal) => {
            const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
            if (!checked.ready) throw new Error(checked.failures.join('\n'))
            const participants = await Promise.all(nodes.map(async (node, index) => {
              const inventory = inventories.find(value => value.serverId === node.server.id)?.inventory
              if (inventory === undefined) throw new Error('Node network inventory is missing')
              return { node, target: this.resolvedTarget(record.targets[index]), inventory,
                password: await this.password(node.server), token: await this.token(node.server, 'node') }
            }))
            return this.driver.resolveTrainingNetwork(id, participants, operationSignal, server.id)
          }, signal)
        nodes = result.value
      }, id)
      for (const server of unique) await this.onServer(server.id, signal, async () => {
        const pending = targetFor(server)
        const expected = server.id === record.coordinator.id ? preparedCoordinator : preparedNodes.find(node => node.server.id === server.id)
        if (expected === undefined) throw new Error('Node has no verified deployment')
        const final = await environment.ensure(handle.agent, await environmentInput(server, pending, 'deployment'), this.driver,
          async (candidate, observed, operationSignal) => {
            if (JSON.stringify(candidate.pathEntries) !== JSON.stringify(pending.pathEntries)) {
              throw new Error('Final acceptance must use the executable directories saved for the running controller')
            }
            const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
            if (!checked.ready) throw new Error(checked.failures.join('\n'))
            const verified = await this.driver.prepareClusterServer({ ...this.resolvedTarget(pending), pathEntries: checked.toolchain.pathEntries },
              { digest: snapshot.digest, reuse: true }, await this.password(server), operationSignal)
            return verified
          }, signal)
        if (server.id === record.coordinator.id) {
          const started = await startRole(server, pending, final.value, 'coordinator', await this.token(server, 'coordinator'), await this.password(server))
          target = started.target
        }
        if (nodes.some(node => node.server.id === server.id)) {
          const started = await startRole(server, pending, final.value, 'node', await this.token(server, 'node'), await this.password(server))
          nodes = nodes.map(node => node.server.id === server.id ? { ...node, backendPath: started.prepared.backendPath,
            devicePaths: normalizedSet(started.prepared.devicePaths), hiddenPaths: normalizedSet(started.prepared.hiddenPaths), gpuInfo: gpuInventoryText(started.prepared.gpu) } : node)
        }
      }, id)
      const coordinator = nodes.find(node => node.server.id === resolvedCoordinator.id)?.server ?? resolvedCoordinator
      record = await this.serial(async () => {
        const next = { ...this.get(id), coordinator, servers: nodes.map(node => node.server) }
        await this.store.table('experiments').put(id, next); return next
      })
      await this.preparationStage(id, 'transferring')
      const placement = resolvedCoordinator.storagePlacement
      if (placement === undefined) throw new Error('Coordinator storage is missing')
      await this.driver.verifyServerStorage(target, placement, coordinatorPassword, signal, files.reduce((total, file) => total + statSync(file).size, 0))
      const incoming = `${placement.runRoot}/inputs`
      await this.driver.remote(target, `umask 077; mkdir -p ${shellQuote(incoming)}`, signal, coordinatorPassword)
      const transferTimeoutMs = storageGovernancePolicySchema.parse(this.environmentPolicy.governance ?? {}).materialTimeoutMs
      const transferSignal = AbortSignal.any([signal, AbortSignal.timeout(transferTimeoutMs)])
      const transferTarget = { ...target, toolTimeoutMs: transferTimeoutMs }
      for (const file of files) {
        const name = basename(file)
        const sha256 = await clusterFileHash(file)
        const submitted = inputs.find(input => input.name === name)
        if (submitted?.sha256 !== sha256) throw new Error('Input changed during preparation')
        await transferExperimentInput(this.driver, transferTarget, placement, file, { ...submitted, size: statSync(file).size }, transferSignal, coordinatorPassword)
      }
      if (record.request.budget !== undefined || record.models === undefined) throw new Error('Legacy preparation cannot be converted to protocol 4; copy it to a new experiment')
      const submission = clusterSubmissionV4Schema.parse({ protocol: 4, experimentId: id, deploymentId: snapshot.digest,
        name: record.request.name ?? record.request.objective.split('\n')[0]?.slice(0, 120) ?? 'Experiment', models: record.models,
        objective: record.request.objective, coordinator, nodes, inputs, inventories, createdAt: record.createdAt,
        strategy: { mode: record.request.mode, coordinator: 'single-agent' },
        versions: { dsh: '0.2.0-rc.2', extension: '0.1.1', harness: snapshot.digest, data: inputs.map(input => input.sha256) } })
      const modelCredentialFile = `${target.remoteRoot}/secrets/${id}-model.json`
      const credentials: Record<string, string> = {}
      for (const phase of experimentPhases) {
        const name = record.models[phase].configurationRef
        const configuration = await this.ctx.credentials.resolve(credentialRef(name))
        if (configuration === undefined) throw new Error(`${phase}: model configuration snapshot is missing`)
        const saved = privateModelConfigurationSchema.parse(JSON.parse(configuration.value))
        const key = await this.ctx.credentials.resolve(credentialRef(saved.keyRef))
        if (key === undefined) throw new Error(`${phase}: model credential snapshot is missing`)
        credentials[name] = configuration.value
        credentials[saved.keyRef] = key.value
      }
      await this.driver.installPrivateFile(target, modelCredentialFile, JSON.stringify({ version: 1, refs: credentials }), signal, coordinatorPassword)
      const connections = await Promise.all(nodes.map(async ({ server }) => ({ serverId: server.id,
        token: await this.token(server, 'node'),
        ...(server.authMode === 'password' ? { password: await this.password(server) } : {}),
        ...await this.driver.delegateClusterLogin(target, server, id, coordinatorPassword, signal),
      })))
      const runtime: ClusterPrivate = { submission, connections, modelCredentialFile, toolTimeoutMs: target.toolTimeoutMs,
        ...(preparedCoordinator.requiredFeatures?.includes('documentation-pages-0.1.0') ? { documentationPolicy: planningPolicySchema.parse({
          documentationReadTimeoutMs: target.documentationReadTimeoutMs, documentationPageBytes: target.documentationPageBytes }) } : {}),
        agentModel: selection }
      await this.driver.installPrivateFile(target, `${target.remoteRoot}/secrets/${id}.json`, JSON.stringify(runtime), signal, coordinatorPassword)
      for (const acceptance of controllerAcceptances.values()) await acceptance.verifyAcceptance(signal)
      record = await this.serial(async () => {
        const next = { ...this.get(id), submission }
        await this.rememberRemoteTask(next)
        await this.store.table('experiments').put(id, next)
        return next
      })
      signal.throwIfAborted()
      await this.preparationStage(id, 'submitting')
      let receipt: ClusterRecord
      try { receipt = clusterRecordSchema.parse(await this.call(record, 'submit', submission)) }
      catch (error) { signal.throwIfAborted(); void error; receipt = clusterRecordSchema.parse(await this.call(record,
        'submit', submission)) }
      await this.accept(record, receipt)
    } catch (error) {
      if (this.isRemoved(id)) return
      const current = this.get(id)
      if (this.closing && this.installations.has(id) && current.submission === undefined) return
      await this.installations.failed(id, String(error))
      if (current.receipt === undefined) await this.store.table('experiments').put(id, { ...current,
        state: signal.aborted && !this.closing && current.submission === undefined ? 'cancelled' : 'failed', detail: `preparation: ${String(error)}` })
    } finally {
      source?.dispose()
      const handle = this.handles.get(id)
      this.handles.delete(id)
      try { await handle?.dispose() } finally { await modelScope?.dispose(); this.preparing.delete(id) }
    }
  }

  private resolvedTarget(target: PinnedDeployment): DeploymentConfig {
    if (target.remoteRoot === undefined) throw new Error('Server directories have not been resolved')
    return this.connectionTarget({ ...target, remoteRoot: target.remoteRoot, managedEnvironments: this.environmentPolicy })
  }

  private connectionTarget<T extends Target>(target: T): T & SshConnectionPolicy {
    return { ...target, ...this.sshConnectionPolicy }
  }

  private reuseExecutablePaths(serverId: ExperimentServerId, target: PinnedDeployment): PinnedDeployment {
    target = this.connectionTarget(target)
    if (target.pathEntries !== undefined) return target
    for (const record of this.list()) {
      const saved = record.coordinator.id === serverId ? record.coordinatorTarget : record.targets[record.servers.findIndex(server => server.id === serverId)]
      if (saved?.pathEntries !== undefined && saved.host === target.host && saved.sshPort === target.sshPort && saved.username === target.username) {
        return { ...target, pathEntries: [...saved.pathEntries] }
      }
    }
    return target
  }

  private async environmentProgress(id: ExperimentId, value: EnvironmentProgress): Promise<void> {
    await this.serial(async () => {
      const removed = this.removals.table('removals').get(id)
      if (removed !== undefined) {
        if (removed.work !== undefined) {
          const nodes = removed.work.nodes.map(node => {
            if (node.server.id !== value.serverId) return node
            const next = { ...node }
            if (value.pendingCommand === undefined) delete next.pendingDirectory
            else next.pendingDirectory = value.pendingCommand.directory
            return next
          })
          await this.removals.table('removals').put(id, { ...removed, work: { ...removed.work, nodes } })
        }
        return
      }
      const current = this.get(id)
      if (current.preparation === undefined) throw new Error('Preparation record is missing')
      const environments = [...(current.preparation.environments ?? []).filter(row => row.serverId !== value.serverId), value]
      await this.store.table('experiments').put(id, { ...current, preparation: { ...current.preparation, stage: value.phase, environments } })
    })
    await this.ctx.sessionPersistence.flush()
  }

  private saveExecutablePaths(id: ExperimentId, serverId: ExperimentServerId, pathEntries: string[]): Promise<FleetExperiment> {
    return this.serial(async () => {
      const current = this.get(id)
      const next = { ...current,
        coordinatorTarget: serverId === current.coordinator.id ? { ...current.coordinatorTarget, pathEntries } : current.coordinatorTarget,
        targets: current.targets.map((target, index) => current.servers[index]?.id === serverId ? { ...target, pathEntries } : target) }
      await this.store.table('experiments').put(id, next); return next
    })
  }

  private preparationStage(id: ExperimentId, stage: NonNullable<FleetExperiment['preparation']>['stage'],
    patch: Partial<Pick<NonNullable<FleetExperiment['preparation']>, 'inventories' | 'placements' | 'inputs'>> = {}): Promise<FleetExperiment> {
    return this.serial(async () => {
      const current = this.get(id)
      if (current.preparation === undefined || current.state === 'cancelled') throw new Error('Preparation is unavailable or cancelled')
      const next = { ...current, preparation: { ...current.preparation, ...patch, stage } }
      await this.store.table('experiments').put(id, next); return next
    })
  }

  private localInput(path: string, roots: readonly string[]): string {
    if (!isAbsolute(path) || !lstatSync(path).isFile()) throw new Error('dataset must be an existing absolute file')
    const canonical = realpathSync(path)
    if (!roots.some(root => canonical.startsWith(realpathSync(root) + sep))) throw new Error('dataset is outside configured data roots')
    return canonical
  }

  private async accept(record: FleetExperiment, receipt: ClusterRecord): Promise<void> {
    if (JSON.stringify(receipt.submission) !== JSON.stringify(record.submission)) throw new Error('remote receipt does not match this experiment')
    const id = record.request.experimentId
    const pending = (this.acceptance.get(id) ?? Promise.resolve()).then(async () => {
      const current = this.get(id)
      const saved = current.receipt ?? receipt
      if (current.receipt === undefined) {
        const accepted: FleetExperiment = { ...current, state: 'submitted', receipt: saved, latest: receipt }
        delete accepted.detail
        await this.store.table('experiments').put(id, accepted)
      }
      await this.recordHandover(this.get(id), saved)
    })
    this.acceptance.set(id, pending)
    try { await pending } finally { if (this.acceptance.get(id) === pending) this.acceptance.delete(id) }
  }

  private async recordHandover(record: FleetExperiment, receipt: ClusterRecord): Promise<void> {
    const notice = `${CLUSTER_HANDOVER}\n${JSON.stringify(receipt)}`
    const complete = async (agent: Agent, id: string | undefined, revision: number | undefined) => {
      if (this.isRemoved(record.request.experimentId)) return
      const goal = this.ctx.goals.get(agent)
      if (goal === undefined || goal.id !== id || (goal.phase !== 'complete' && goal.revision !== revision)) return
      if (goal.phase !== 'complete') {
        agent.session.append('user/message', createUserMessage({ source: { kind: 'aspera', experimentId: record.request.experimentId },
          content: [{ type: 'text', text: notice }] }), { surfaceOp: 'append' })
        this.ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
      }
      await this.ctx.sessionPersistence.flush()
    }
    if (record.sourceGoal !== undefined) {
      const caller = this.ctx.agents.get(SessionId(record.sourceGoal.sessionId))
      if (caller !== undefined) {
        await complete(caller, record.sourceGoal.id, record.sourceGoal.revision)
      }
    }
    if (record.handoverRecorded) return
    const live = this.ctx.agents.get(SessionId(record.sessionId))
    if (live !== undefined) await complete(live, record.goalId, record.goalRevision)
    else {
      const resumed = await this.ctx.agents.resume({ resumeSessionId: SessionId(record.sessionId) })
      try { await complete(resumed.agent, record.goalId, record.goalRevision) } finally { await resumed.dispose() }
    }
    await this.store.table('experiments').put(record.request.experimentId, { ...this.get(record.request.experimentId),
      handoverRecorded: true })
  }

  private async call(record: FleetExperiment, operation: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    const id = record.request.experimentId
    this.get(id)
    const abort = new AbortController()
    const controllers = this.requests.get(id) ?? new Set<AbortController>()
    controllers.add(abort); this.requests.set(id, controllers)
    try {
      return await this.controlRequest(record.coordinator, record.coordinatorTarget, record.submission?.protocol ?? 4, operation, body,
        signal === undefined ? abort.signal : AbortSignal.any([signal, abort.signal]))
    } catch (error) {
      if (this.isRemoved(id)) throw new Error('experiment not found')
      throw error
    } finally { controllers.delete(abort); if (controllers.size === 0) this.requests.delete(id) }
  }

  private async controlRequest(server: ServerSettings, target: PinnedDeployment, protocol: number, operation: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const password = await this.password(server)
    const token = await this.token(server, 'coordinator')
    signal?.throwIfAborted()
    const response = await this.driver.request(this.connectionTarget({ ...target, remotePort: target.remotePort + 1 }), token,
      '/aspera/v' + protocol + '/' + operation, 'POST', body, signal, password)
    if (response.status !== 200) {
      const error = z.object({ error: z.string() }).safeParse(response.value)
      throw new CoordinatorRequestError(response.status, error.success ? error.data.error : `coordinator returned HTTP ${response.status}`)
    }
    return response.value
  }

  /**
   * Reconcile saved experiment state and ownership evidence.
   * @param id - saved experiment.
   * @returns reconciled remote state and queue blockers.
   */
  async refresh(id: ExperimentId): Promise<FleetExperiment> {
    const current = this.get(id)
    if (current.submission === undefined) return current
    let result: { record: ClusterRecord; waitingFor: ExperimentServerId[] }
    try {
      result = z.object({ record: clusterRecordSchema, waitingFor: z.array(serverIdSchema) })
        .parse(await this.call(current, 'status', { experimentId: id }))
    } catch (error) {
      if (!(error instanceof CoordinatorRequestError) || error.status !== 404 || current.receipt !== undefined) throw error
      result = { record: clusterRecordSchema.parse(await this.call(current, 'submit', current.submission)), waitingFor: [] }
    }
    if ((this.get(id).latest?.revision ?? 0) > result.record.revision) return this.get(id)
    await this.accept(current, result.record)
    if (['running', 'serving'].includes(result.record.state)) this.publicServiceChecks.changed(id)
    return this.serial(async () => {
      const current = this.get(id)
      if ((current.latest?.revision ?? 0) > result.record.revision) return current
      const next = { ...current, latest: result.record, waitingFor: result.waitingFor }
      if (JSON.stringify(next) !== JSON.stringify(current)) await this.store.table('experiments').put(id, next)
      this.archives.changed(id)
      return next
    })
  }

  /** Persist a reply at the coordinator; retrying the same answer has no execution side effect.
   * @param id - owning experiment. @param reply - exact question binding and answer. @returns current receipt.
   */
  async answer(id: ExperimentId, reply: AnswerExperimentQuestion): Promise<FleetExperiment> {
    this.assertInterruptionSettled(id)
    const input = answerExperimentQuestionSchema.parse(reply)
    const latest = clusterRecordSchema.parse(await this.call(this.get(id), 'answer-question', { experimentId: id, ...input }))
    return this.serial(async () => {
      const current = this.get(id)
      if ((current.latest?.revision ?? 0) > latest.revision) return current
      const next = { ...current, latest }
      await this.store.table('experiments').put(id, next)
      return next
    })
  }

  /**
   * Cancel the saved experiment while retaining unconfirmed allocations.
   * @param id - experiment to stop.
   * @returns saved local or remote cancellation state.
   */
  async cancel(id: ExperimentId): Promise<FleetExperiment> {
    this.interruptions.request(id)
    await this.interruptions.wait(id)
    const status = this.interruptions.status(id)
    if (status?.phase !== 'released') throw new Error(status?.detail ?? 'Experiment exit remains unconfirmed')
    return this.get(id)
  }

  /** @param id - user-selected experiment. @returns the durable interruption acknowledgement. */
  interrupt(id: ExperimentId): ExperimentInterruptionStatus { return this.interruptions.request(id) }

  private async rememberRemoteTask(record: FleetExperiment): Promise<void> {
    const identity = remoteTaskFromExperiment(record)
    if (identity === undefined) return
    const prior = this.remoteTasks.table('tasks').get(identity.experimentId)
    if (prior !== undefined && prior.work.submissionHash !== identity.work.submissionHash) throw new Error('Remote task submission identity changed')
    if (prior === undefined || prior.release === undefined && identity.release !== undefined) await this.remoteTasks.table('tasks').put(identity.experimentId,
      prior === undefined ? identity : { ...prior, release: identity.release, updatedAt: identity.updatedAt })
  }

  private interruptionTask(id: ExperimentId): InterruptionTask {
    if (!this.isRemoved(id)) return this.get(id)
    const task = this.remoteTasks.table('tasks').get(id)
    if (task === undefined) throw new Error('Remote task identity is unavailable; verify its original submission before settlement')
    return remoteTaskAsInterruption(task)
  }

  private isRemoteTaskReleased(id: ExperimentId): boolean {
    const status = this.interruptions.status(id)
    return status === undefined ? this.remoteTasks.table('tasks').get(id)?.release !== undefined : status.phase === 'released'
  }

  /** @param id - program-known remote task. @returns committed progress without contacting a server or restoring a deleted experiment. */
  remoteTaskStatus(id: ExperimentId): RemoteTaskStatus | undefined {
    const task = this.remoteTasks.table('tasks').get(id)
    if (task === undefined) return undefined
    const interruption = this.interruptions.status(id)
    const publicStatus = interruption === undefined ? undefined : (({ result: _result, ...status }) => status)(interruption)
    return { experimentId: id, name: task.name, serverIds: task.work.nodes.map(node => node.server.id), deleted: this.isRemoved(id),
      updatedAt: interruption?.updatedAt ?? task.release?.observedAt ?? task.updatedAt,
      released: interruption === undefined ? task.release !== undefined : interruption.phase === 'released', recoveryAvailable: true,
      ...(publicStatus === undefined ? {} : { interruption: publicStatus }) }
  }

  /** @param id - selected task identity. @param mode - exit verification or explicit interruption. @returns the persisted background operation. */
  settleRemoteTask(id: ExperimentId, mode: 'reconcile' | 'interrupt'): RemoteTaskStatus {
    if (this.closing) throw new Error('Experiment management is stopping')
    if (this.remoteTasks.table('tasks').get(id) === undefined) throw new Error('Remote task identity is unavailable')
    if (this.remoteTaskStatus(id)?.released) return this.remoteTaskStatus(id)!
    if (mode === 'interrupt') this.interruptions.request(id)
    else this.interruptions.reconcile(id)
    return this.remoteTaskStatus(id)!
  }

  private async originalTaskRecord(task: InterruptionTask, signal: AbortSignal): Promise<ClusterRecord> {
    let record: ClusterRecord | undefined
    try {
      record = z.object({ record: clusterRecordSchema }).parse(await this.controlRequest(task.coordinator, task.coordinatorTarget, 4,
        'status', { experimentId: task.request.experimentId }, signal)).record
    } catch (error) { signal.throwIfAborted(); this.ctx.logger.debug(`Original task status unavailable: ${redactObservation(String(error))}`) }
    if (record === undefined) {
      const connection = await this.interruptionConnection(task, task.coordinator.id)
      record = (await this.remoteInterruption.discover({ ...connection, serverId: task.coordinator.id,
        experimentIds: [task.request.experimentId] }, signal)).find(value => value.submission.experimentId === task.request.experimentId)
    }
    if (record === undefined || record.submission.protocol !== 4 || record.submission.experimentId !== task.request.experimentId
      || record.payloadHash !== task.submissionHash || createHash('sha256').update(JSON.stringify(record.submission)).digest('hex') !== task.submissionHash
      || record.submission.coordinator.id !== task.coordinator.id || record.submission.coordinator.remoteRoot !== task.coordinator.remoteRoot
      || record.submission.nodes.length !== task.servers.length || record.submission.nodes.some(node => !task.servers.some(server =>
        server.id === node.server.id && server.remoteRoot === node.server.remoteRoot))) throw new Error('Original remote task submission, nodes or digest cannot be confirmed')
    return record
  }

  /** @param id - experiment. @returns retained progress without contacting or changing remote processes. */
  interruptionStatus(id: ExperimentId): ExperimentInterruptionStatus | undefined { this.get(id); return this.interruptions.status(id) }

  private assertInterruptionSettled(id: ExperimentId): void {
    const status = this.interruptions.status(id)
    if (status !== undefined) throw new Error(status.phase === 'released' ? 'Experiment was interrupted; copy it to start another run' : 'Experiment interruption must confirm resource release before another operation')
  }

  private async cancelPreparation(id: ExperimentId): Promise<FleetExperiment> {
    const pending = await this.serial(async () => {
      const current = this.get(id)
      const preparing = this.preparing.get(id)
      if (current.submission === undefined) await this.store.table('experiments').put(id, { ...current, state: 'cancelled' })
      preparing?.abort.abort(new Error('dispatch cancelled'))
      return { done: preparing?.done }
    })
    await pending.done
    const current = this.get(id)
    if (this.installations.pending(id).length > 0) {
      const outcomes = await Promise.allSettled(this.installations.pending(id).map(async serverId => {
        const server = current.coordinator.id === serverId ? current.coordinator : current.servers.find(server => server.id === serverId)!
        const target = current.coordinator.id === serverId ? current.coordinatorTarget : current.targets[current.servers.findIndex(server => server.id === serverId)]!
        return this.installations.stop(id, serverId, this.resolvedTarget(target), await this.password(server), AbortSignal.timeout(this.connectionCheckTimeoutMs))
      }))
      if (outcomes.some(result => result.status === 'rejected' || !result.value)) await this.installations.failed(id, 'Cancellation requested; remote installer exit remains unconfirmed')
    }
    if (current.submission === undefined) return current
    throw new Error('Remote experiment cancellation must use the interruption operation')
  }

  private async interruptionConnection(record: InterruptionTask, serverId: ExperimentServerId): Promise<{ target: DeploymentConfig; password?: string }> {
    const server = record.servers.find(value => value.id === serverId)
    const target = serverId === record.coordinator.id ? record.coordinatorTarget : record.targets[record.servers.findIndex(value => value.id === serverId)]
    if (server === undefined || target === undefined) throw new Error('Interruption has an unassigned server')
    const login = this.servers().servers.find(value => value.id === serverId) ?? server
    return { target: this.connectionTarget({ ...this.resolvedTarget(target), host: login.host, sshPort: login.sshPort,
      username: login.username, authMode: login.authMode, identityFile: login.identityFile, knownHostsFile: login.knownHostsFile,
      passwordRef: sshPasswordRef(login) }), password: await this.password(login) }
  }

  private interruptionRecovery(ownerId: ExperimentId) {
    const selected = this.get(ownerId).servers.map(server => server.id)
    const submissions = new Map<ExperimentId, { submission: ClusterSubmission; payloadHash: string }>()
    for (const record of this.list()) if (record.request.experimentId !== ownerId && record.submission?.protocol === 4
      && record.servers.some(server => selected.includes(server.id))) {
      submissions.set(record.request.experimentId, { submission: record.submission,
        payloadHash: createHash('sha256').update(JSON.stringify(record.submission)).digest('hex') })
    }
    const scope = () => ({ allowedServerIds: selected, allowedExperimentIds: [...submissions.entries()]
      .filter(([, value]) => value.submission.nodes.every(node => selected.includes(node.server.id))).map(([id]) => id),
      allowedSubmissions: [...submissions.values()] })
    return { ...scope(), recoveryScope: scope,
      recordInterruptions: async (statuses: ExperimentInterruptionStatus[]) => {
        for (const status of statuses) {
          if (!scope().allowedExperimentIds.includes(status.experimentId)) throw new Error('Controller recovery attempted an unauthorized experiment')
          await this.interruptions.adopt(status)
        }
      },
      settleExperiments: async (offline: import('./controller-recovery.ts').OfflineController, signal: AbortSignal) => {
        const results: ExperimentInterruptionStatus[] = []
        const seen = new Set<ExperimentId>()
        const blockers = [...offline.blockers, ...offline.converged.map(value => ({ kind: 'experiment',
          id: value.experimentId ?? value.id, reason: 'Original task records require unified settlement' }))]
        for (const blocker of blockers) {
          if (!['experiment', 'interruption'].includes(blocker.kind) || blocker.id === undefined || blocker.id === null) continue
          const parsed = experimentIdSchema.safeParse(blocker.id)
          if (!parsed.success || parsed.data === ownerId || seen.has(parsed.data)) continue
          const id = parsed.data; seen.add(id)
          if (!submissions.has(id)) {
            if (!this.isRemoved(id) && this.remoteTasks.table('tasks').get(id) === undefined) continue
            if (this.remoteTasks.table('tasks').get(id) === undefined) await this.discoverRemovedTask(ownerId, id, signal)
            const task = this.interruptionTask(id)
            const unselected = task.servers.filter(server => !selected.includes(server.id))
            if (unselected.length > 0) {
              results.push(this.interruptions.observeBlocked(id, 'Original task includes nodes outside preparation authorization: '
                + unselected.map(server => `${server.name} (${server.id})`).join(', ')
                + '; use the server task recovery entry to interrupt and verify all original nodes'))
              continue
            }
            const submission = (await this.originalTaskRecord(task, signal)).submission
            submissions.set(id, { submission, payloadHash: createHash('sha256').update(JSON.stringify(submission)).digest('hex') })
          }
          if (!scope().allowedExperimentIds.includes(id)) {
            results.push(this.interruptions.observeBlocked(id, blocker.reason + '; use the server task recovery entry to interrupt and verify all original nodes'))
            continue
          }
          this.preparationSettlements.add(id)
          try { results.push(await this.interruptions.recover(id, signal)) }
          finally { this.preparationSettlements.delete(id) }
        }
        return results
      },
    }
  }

  private async discoverRemovedTask(ownerId: ExperimentId, id: ExperimentId, signal: AbortSignal): Promise<void> {
    if (!this.isRemoved(id)) throw new Error('Historical task has no local deletion identity')
    const owner = this.get(ownerId)
    for (const server of owner.servers) {
      const connection = await this.interruptionConnection(owner, server.id)
      const records = await this.remoteInterruption.discover({ ...connection, serverId: server.id, experimentIds: [id] }, signal)
      const original = records.find(record => record.submission.experimentId === id)
      if (original === undefined) continue
      const submission = original.submission
      const digest = createHash('sha256').update(JSON.stringify(submission)).digest('hex')
      if (digest !== original.payloadHash) throw new Error('Historical task submission digest differs from its original coordinator record')
      const nodes = submission.nodes.map(node => {
        const registered = this.servers().servers.find(value => value.id === node.server.id)
        if (registered === undefined || registered.username !== node.server.username) throw new Error('Historical task has an unconfirmed original account or node: ' + node.server.id)
        const login: ServerSettings = { ...registered, ...node.server }
        return { server: login, target: this.deployment(login) }
      })
      const removal = this.removals.table('removals').get(id)
      const identity = this.store.table('deleted').get(id) ?? removal?.identity
      if (identity === undefined) throw new Error('Historical deletion identity disappeared during discovery')
      const task = remoteTaskRecordSchema.parse({ version: 1, experimentId: id, name: removal?.name ?? id,
        work: { coordinatorId: submission.coordinator.id, protocol: 4, submissionHash: digest, nodes },
        createdAt: identity.deletedAt, updatedAt: Date.now() })
      await this.serial(async () => {
        const current = this.remoteTasks.table('tasks').get(id)
        if (current !== undefined && current.work.submissionHash !== digest) throw new Error('Another recovery registered a different original submission')
        if (current === undefined) await this.remoteTasks.table('tasks').put(id, task)
      })
      return
    }
    throw new Error('Deleted task original submission could not be found in the authorized coordinator directories: ' + id)
  }

  private async settleInterruption(record: InterruptionTask, original: ExperimentInterruptionStatus, signal: AbortSignal,
    update: (status: ExperimentInterruptionStatus) => void): Promise<ClusterRecord | undefined> {
    const id = record.request.experimentId
    if (original.stopRequested) await this.publicServiceChecks.stop(id)
    let originalRecord: ClusterRecord | undefined
    if (record.submission === undefined && record.submissionHash !== undefined) {
      originalRecord = await this.originalTaskRecord(record, signal)
      record = { ...record, submission: originalRecord.submission }
    }
    if (record.submission === undefined) {
      await this.cancelPreparation(id)
      if (this.installations.pending(id).length > 0 || this.get(id).preparation?.environments?.some(value => value.pendingCommand !== undefined)) {
        throw new Error('Preparation command exit remains unconfirmed')
      }
      return undefined
    }
    let status = structuredClone(original)
    const connections = new Map<ExperimentServerId, Awaited<ReturnType<ExperimentFleet['interruptionConnection']>>>()
    for (const server of record.servers) connections.set(server.id, await this.interruptionConnection(record, server.id))
    const execute = async (serverId: ExperimentServerId, mode: InterruptionMode, facts?: InterruptionFacts) => {
      const connection = connections.get(serverId)
      if (connection === undefined) throw new Error('Interruption has no original node connection')
      signal.throwIfAborted()
      return this.remoteInterruption.execute({ record, serverId, ...connection, status }, mode, signal, facts)
    }
    const inspect = async (serverId: ExperimentServerId) => {
      const result = await execute(serverId, 'inspect')
      if (result.facts === undefined) throw new Error('Interruption inspection returned no node facts')
      return result.facts
    }
    const progress = (phase: ExperimentInterruptionStatus['phase'], serverId?: ExperimentServerId, facts?: InterruptionFacts,
      nodePhase?: ExperimentInterruptionStatus['nodes'][number]['phase']) => {
      const now = Date.now()
      status = { ...status, phase, updatedAt: now, nodes: status.nodes.map(node => node.serverId !== serverId ? node : {
        ...node, phase: nodePhase ?? (phase === 'stopping' ? 'stopping' : 'verifying'), updatedAt: now,
        ...(facts === undefined ? {} : { agentsExited: facts.agentsExited, commandsReleased: facts.commandsReleased, servicesReleased: facts.servicesReleased,
          detail: facts.blockers.length === 0 ? undefined : facts.blockers.join('\n') }),
      }) }
      update(status)
    }
    const priorReceipts: InterruptionFacts[] = []
    for (const server of record.servers) {
      const facts = await inspect(server.id)
      priorReceipts.push(facts)
      progress('verifying', server.id, facts)
      if (!status.stopRequested) {
        if (facts.state !== undefined && !['starting', 'running', 'serving', 'cancelling', 'planning', 'waiting-reply', 'completed', 'blocked', 'failed', 'cancelled', 'interrupted'].includes(facts.state)) {
          throw new Error(`Pending experiment ${record.request.name ?? id} requires an explicit user interruption`)
        }
        if (!facts.agentsExited || !facts.commandsReady || !facts.servicesReady || facts.blockers.length > 0) {
          throw new Error(`Original work on ${server.name} has not confirmed exit: ${facts.blockers.join('; ')}`)
        }
      }
    }
    const coordinatorFacts = priorReceipts.find(facts => facts.serverId === record.coordinator.id)
    if (!status.stopRequested && coordinatorFacts?.state === undefined) throw new Error('Original task state is unavailable; retain its allocation until the original coordinator record is verified')
    if (!status.stopRequested && coordinatorFacts?.coordinatorExited !== true
      && !['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(coordinatorFacts?.state ?? '')) {
      throw new Error('Original coordinator exit or terminal task outcome remains unconfirmed; active work is retained')
    }
    const completedReceipt = priorReceipts.find(facts => facts.receipt?.phase === 'released' && facts.receipt.result !== undefined)?.receipt
    if (completedReceipt !== undefined && priorReceipts.every(facts => facts.agentsExited && facts.commandsReleased && facts.servicesReleased && facts.blockers.length === 0)
      && completedReceipt.operationId === status.operationId && completedReceipt.submissionHash === status.submissionHash) {
      const saved = completedReceipt.result!
      if (JSON.stringify(saved.submission) !== JSON.stringify(record.submission) || !saved.resourcesReleased || saved.services.some(service => !service.released)) throw new Error('Saved interruption has no original complete release evidence')
      status = { ...completedReceipt, nodes: status.nodes.map(node => ({ ...node, phase: 'released', agentsExited: true, commandsReleased: true, servicesReleased: true })) }
      for (const server of record.servers) {
        await execute(server.id, 'fence')
        await execute(server.id, 'publish', await inspect(server.id))
        await execute(server.id, 'unfence', await inspect(server.id))
      }
      return saved
    }
    for (const server of record.servers) await execute(server.id, 'fence')
    let result: ClusterRecord | undefined = originalRecord !== undefined && originalRecord.resourcesReleased
      && originalRecord.services.every(service => service.released) && ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(originalRecord.state)
      && priorReceipts.every(facts => facts.agentsExited && facts.commandsReleased && facts.servicesReleased && facts.blockers.length === 0)
      ? originalRecord : undefined
    if (status.stopRequested) {
      progress('stopping')
      try {
        while (true) {
          signal.throwIfAborted()
          const connection = connections.get(record.coordinator.id)!
          const response = await this.driver.request({ ...connection.target, remotePort: connection.target.remotePort + 1 },
            await this.token(record.coordinator, 'coordinator'), `/aspera/v${record.submission.protocol}/cancel`, 'POST',
            { experimentId: id, submission: record.submission }, signal, connection.password)
          if (response.status !== 200) throw new CoordinatorRequestError(response.status, JSON.stringify(response.value))
          const latest = clusterRecordSchema.parse(response.value)
          if (JSON.stringify(latest.submission) !== JSON.stringify(record.submission)) throw new Error('Cancellation returned another submission')
          await this.serial(async () => {
            if (this.isRemoved(id)) return
            const current = this.get(id)
            if ((current.latest?.revision ?? 0) <= latest.revision) await this.store.table('experiments').put(id, { ...current, latest })
          })
          if (latest.resourcesReleased && latest.services.every(service => service.released)
            && ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(latest.state)) { result = latest; break }
          await delay(this.resolvedTarget(record.coordinatorTarget).controlPollIntervalMs, undefined, { signal })
        }
      } catch (error) { signal.throwIfAborted(); this.ctx.logger.debug(`Original coordinator cancellation unavailable: ${redactObservation(String(error))}`) }
    }
    for (const server of record.servers) {
      progress(result === undefined && status.stopRequested ? 'stopping' : 'verifying', server.id)
      if (result === undefined) {
        const connection = connections.get(server.id)!
        const facts = await inspect(server.id)
        if (status.stopRequested || facts.agentsExited && facts.commandsReady && facts.servicesReady && facts.blockers.length === 0) {
          try {
            const token = await this.token(server, 'node')
            const released = await this.driver.request(connection.target, token, `/aspera/v${record.submission.protocol}/node/release`, 'POST', { experimentId: id }, signal, connection.password)
            if (released.status === 200) z.object({ released: z.boolean() }).parse(released.value)
          } catch (error) { signal.throwIfAborted(); this.ctx.logger.debug(`Original node release unavailable: ${redactObservation(String(error))}`) }
        }
        let fresh = await inspect(server.id)
        if (status.stopRequested && (!fresh.agentsExited || !fresh.commandsReady)) {
          await execute(server.id, 'stop', fresh)
          fresh = await inspect(server.id)
        }
        if (!fresh.agentsExited || !fresh.commandsReady || !fresh.servicesReady || fresh.blockers.length > 0) {
          throw new Error(`Release of ${server.name} remains unconfirmed: ${fresh.blockers.join('; ')}`)
        }
        await execute(server.id, 'settle', fresh)
      }
      const confirmed = await inspect(server.id)
      if (!confirmed.agentsExited || !confirmed.commandsReleased || !confirmed.servicesReleased || confirmed.blockers.length > 0) {
        throw new Error(`Original processes on ${server.name} have not confirmed release`)
      }
      progress('verifying', server.id, confirmed, 'released')
    }
    if (result === undefined) {
      const facts = await inspect(record.coordinator.id)
      const finished = await execute(record.coordinator.id, 'complete', facts)
      if (finished.record === undefined) throw new Error('Offline interruption returned no terminal record')
      result = finished.record
    }
    status = { ...status, phase: 'released', result, updatedAt: Date.now() }
    for (const server of record.servers) {
      await execute(server.id, 'publish', await inspect(server.id))
      await execute(server.id, 'unfence', await inspect(server.id))
    }
    return result
  }

  /**
   * List metadata from the experiment's assigned node.
   * @param id - experiment.
   * @param serverId - owned node.
   * @returns bounded artifact metadata.
   */
  async files(id: ExperimentId, serverId: ExperimentServerId): Promise<{ files: ClusterFile[]; truncated: boolean }> {
    return z.object({ files: z.array(clusterFileSchema), truncated: z.boolean() }).parse(await this.call(this.get(id),
      'files', { experimentId: id, serverId }))
  }

  /** Read only the requested experiment's own phase Session.
   * @param raw - phase and source-bound cursor. @param complete - request complete payloads where the pinned runtime supports them. @returns real events, never synthesized history.
   */
  async records(raw: AgentRecordRequest, complete = false): Promise<AgentRecordPage> {
    const input = agentRecordRequestSchema.parse(raw)
    if (input.phase !== 'preparation') {
      const copy = this.archives.store(input.experimentId)
      const saved = copy?.records(input)
      if (saved !== undefined && (copy?.traceCaughtUp(input.phase) || !this.archives.status(input.experimentId).runtimeAvailable)) return saved
      this.archives.request(input.experimentId)
    }
    return this.recordsRemote(input, complete)
  }

  private async recordsRemote(raw: AgentRecordRequest, complete = false, signal?: AbortSignal): Promise<AgentRecordPage> {
    const input = agentRecordRequestSchema.parse(raw)
    const record = this.get(input.experimentId)
    if (input.phase !== 'preparation') {
      if (record.submission === undefined || record.submission.protocol !== 4) return { records: [], hasMore: false, missing: true, reset: false }
      try {
        const page = agentRecordPageSchema.parse(await this.call(record, complete ? 'trace-records' : 'records', input, signal))
        if (page.records.some(event => event.experimentId !== input.experimentId || event.phase !== input.phase
          || (page.cursor !== undefined && event.sessionId !== page.cursor.sessionId))
          || (page.cursor !== undefined && (page.cursor.experimentId !== input.experimentId || page.cursor.phase !== input.phase))) throw new Error('Trajectory page belongs to another experiment or phase')
        if (complete) for (const event of page.records) {
          if (!event.truncated) continue
          let data = ''; let digest: string | undefined
          for (;;) {
            const chunk = traceEventChunkSchema.parse(await this.call(record, 'trace-event', { experimentId: event.experimentId, phase: event.phase,
              sessionId: event.sessionId, seq: event.seq, offset: data.length, ...(page.cursor?.generation === undefined ? {} : { generation: page.cursor.generation }), ...(digest === undefined ? {} : { digest }) }, signal))
            if (chunk.nextOffset !== data.length + chunk.data.length || (digest !== undefined && chunk.digest !== digest)) throw new Error('Event fragments are inconsistent')
            data += chunk.data; digest = chunk.digest
            if (data.length === chunk.length) break
            if (chunk.data.length === 0 || data.length > chunk.length) throw new Error('Event fragment did not advance')
          }
          if (createHash('sha256').update(data).digest('hex') !== digest) throw new Error('Event content failed integrity verification')
          JSON.parse(data); event.data = data; event.truncated = false
        }
        return page
      }
      catch (error) {
        if (!complete || !(error instanceof CoordinatorRequestError) || error.status !== 404) throw error
        return agentRecordPageSchema.parse(await this.call(record, 'records', input, signal))
      }
    }
    const cursor = input.cursor
    if (cursor !== undefined && (cursor.experimentId !== input.experimentId || cursor.phase !== input.phase || cursor.sessionId !== record.sessionId)) throw new Error('Agent cursor belongs to another experiment, phase or Session')
    const id = SessionId(record.sessionId)
    const stat = await this.ctx.sessionPersistence.stat(id)
    if (stat === undefined) return { records: [], hasMore: false, missing: true, reset: false }
    const handle = await this.ctx.sessionPersistence.open(id, 'read')
    try {
      const start = input.beforeSeq === undefined ? cursor?.nextSeq ?? (complete ? Math.max(0, (stat.eventCount ?? 0) - input.limit) : 0) : Math.max(0, input.beforeSeq - input.limit)
      const events = (await handle.read(start, input.limit + 1)).events
      const records: AgentRecordPage['records'] = []; let characters = 0
      const tail = complete && input.cursor === undefined
      for (const event of events) {
        if ((!tail && (records.length >= input.limit || characters >= 65536)) || (input.beforeSeq !== undefined && event.seq >= input.beforeSeq)) break
        const row = projectAgentRecord(event, { experimentId: input.experimentId, phase: input.phase, sessionId: record.sessionId }, complete ? Infinity : 65536 - characters)
        if (event.type === 'tool/call') {
          const call = z.object({ callId: z.string() }).safeParse(event.data)
          const source = call.success ? observationSources(resolve(resolveDshHome(), 'aspera-observations', input.experimentId)).find(source => source.toolCallId === call.data.callId && source.sessionId === record.sessionId) : undefined
          if (source?.commandId !== undefined) row.log = { serverId: source.serverId, commandId: source.commandId }
          else if (call.success) row.log = this.installations.commandForCall(input.experimentId, record.sessionId, call.data.callId)
        }
        records.push(row); characters += row.data.length
        if (tail) while (records.length > 1 && (characters > 65536 || records.length > input.limit)) characters -= records.shift()!.data.length
      }
      return { records, cursor: { experimentId: input.experimentId, phase: input.phase, sessionId: record.sessionId,
        nextSeq: (records.at(-1)?.seq ?? start - 1) + 1 }, hasMore: events.length > records.length, missing: false, reset: false }
    } finally { await handle.close() }
  }

  /** @param id - experiment. @param phase - saved Session role. @param seq - owning event. @param attachmentId - recorded reference.
   * @param offset - byte offset. @returns a bounded verified attachment fragment.
   */
  async traceAttachment(id: ExperimentId, phase: 'preparation' | 'planning' | 'execution', seq: number, attachmentId: string, offset: number): Promise<{ data: string; mediaType: string; name: string; nextOffset: number; size: number }> {
    const record = this.get(id)
    if (phase === 'preparation') {
      const event = (await this.records({ experimentId: id, phase, beforeSeq: seq + 1, limit: 1 }, true)).records.find(event => event.seq === seq)
      if (event === undefined || event.truncated) throw new Error('The attachment event is unavailable')
      return readTraceAttachment(resolveDshHome(), JSON.parse(event.data), attachmentId, offset, 65536)
    }
    const sessionId = phase === 'planning' ? record.latest?.planningSessionId : record.latest?.sessionId
    if (sessionId === undefined) throw new Error('The phase Session is unavailable')
    return z.object({ data: z.string(), mediaType: z.string(), name: z.string(), nextOffset: z.number(), size: z.number() }).parse(
      await this.call(record, 'trace-attachment', { experimentId: id, phase, seq, sessionId, attachmentId, offset }))
  }

  /** @param id - experiment. @param serverId - assigned node. @returns managed process directory. */
  async processes(id: ExperimentId, serverId: ExperimentServerId): Promise<ExperimentProcess[]> {
    const record = this.get(id)
    if (!record.servers.some(server => server.id === serverId)) throw new Error('Node belongs to another experiment')
    const saved = this.archives.store(id)
    if (saved?.hasFacts(serverId)) return saved.processes(serverId)
    if (!record.servers.some(server => server.id === serverId)) throw new Error('Node belongs to another experiment')
    if (record.submission?.protocol !== 4) return []
    return z.array(experimentProcessSchema).parse(await this.call(record, 'processes', { experimentId: id, serverId }))
  }

  /** @param raw - immutable process source and cursor. @returns bounded stdout or stderr bytes. */
  async processLog(raw: ProcessLogRequest): Promise<ProcessLogPage> {
    const input = processLogRequestSchema.parse(raw)
    if (!this.get(input.experimentId).servers.some(server => server.id === input.serverId)) throw new Error('Node belongs to another experiment')
    const saved = this.archives.store(input.experimentId)?.processLog(input, this.archivePolicy.archiveReadBytes)
    return saved ?? this.processLogRemote(input)
  }

  private async processLogRemote(raw: ProcessLogRequest, signal?: AbortSignal): Promise<ProcessLogPage> {
    const request = processLogRequestSchema.parse(raw)
    const record = this.get(request.experimentId)
    if (!record.servers.some(server => server.id === request.serverId)) throw new Error('Node belongs to another experiment')
    return processLogPageSchema.parse(await this.call(record, 'process-log', request, signal))
  }

  /** @param id - experiment. @param serverId - pinned node. @returns registered sources and explicit legacy availability. */
  async logSources(id: ExperimentId, serverId: ExperimentServerId): Promise<{ sources: ObservationSource[]; legacy: boolean }> {
    const record = this.get(id)
    if (!record.servers.some(server => server.id === serverId)) throw new Error('Node belongs to another experiment')
    const local = observationSources(resolve(resolveDshHome(), 'aspera-observations', id)).filter(source => source.serverId === serverId && source.experimentId === id)
    const saved = this.archives.store(id)
    if (saved?.hasFacts(serverId)) return { sources: [...local, ...saved.logSources(serverId)], legacy: false }
    if (record.receipt === undefined) return { sources: local, legacy: false }
    try {
      const remote = z.array(observationSourceSchema).parse(await this.call(record, 'observation-sources', { experimentId: id, serverId }))
      if (remote.some(source => source.experimentId !== id || source.serverId !== serverId)) throw new Error('Observation directory ownership mismatch')
      return { sources: [...local, ...remote], legacy: remote.some(source => source.kind === 'legacy') }
    } catch (error) {
      if (!(error instanceof CoordinatorRequestError) || error.status !== 404) throw error
      const source = (name: string, label: string): ObservationSource => ({ version: 1, id: observationSourceIdSchema.parse(name), experimentId: id,
        serverId, kind: 'legacy', label, createdAt: record.createdAt, streams: ['mixed'], complete: record.latest?.resourcesReleased === true })
      return { sources: [...local, source('legacy-node', 'node'), ...(record.coordinator.id === serverId ? [source('legacy-agent', 'agent')] : [])], legacy: true }
    }
  }

  /** @param raw - registered log source and bound cursor. @param signal - download cancellation. @returns bounded complete log records. */
  async logRead(raw: ObservationRead, signal?: AbortSignal): Promise<ObservationPage> {
    const input = observationReadSchema.parse(raw)
    if (!this.get(input.experimentId).servers.some(server => server.id === input.serverId)) throw new Error('Node belongs to another experiment')
    const saved = this.archives.store(input.experimentId)?.log(input)
    return saved ?? this.logReadRemote(input, signal)
  }

  private async logReadRemote(raw: ObservationRead, signal?: AbortSignal): Promise<ObservationPage> {
    const input = observationReadSchema.parse(raw); const record = this.get(input.experimentId)
    if (!record.servers.some(server => server.id === input.serverId)) throw new Error('Node belongs to another experiment')
    const secrets = await this.archiveSecrets(record)
    const publish = (page: ObservationPage): ObservationPage => ({ ...page, lines: page.lines.map(line => ({ ...line, text: redactObservation(line.text, secrets) })) })
    const cursor = input.cursor ?? input.before
    if (cursor !== undefined && (cursor.experimentId !== input.experimentId || cursor.serverId !== input.serverId || cursor.sourceId !== input.sourceId || cursor.stream !== input.stream)) throw new Error('Log cursor belongs to another source')
    if (input.sourceId.startsWith('preparation-') || input.sourceId.startsWith('installation-')) return publish(readObservation(resolve(resolveDshHome(), 'aspera-observations', input.experimentId), input))
    if (input.sourceId === 'legacy-node' || input.sourceId === 'legacy-agent') {
      if (input.sourceId === 'legacy-agent' && record.coordinator.id !== input.serverId) throw new Error('Agent log belongs to the coordinator')
      if (input.stream !== 'all' && input.stream !== 'mixed') throw new Error('Legacy logs do not identify output streams')
      const start = input.before === undefined ? input.cursor?.offset ?? 0 : Math.max(0, input.before.offset - input.limit)
      const encodedSecrets = secrets.map(secret => Buffer.from(secret).toString('latin1'))
      const context = Math.max(input.limit, ...encodedSecrets.map(secret => secret.length))
      const kind = input.sourceId === 'legacy-agent' ? 'agent-log' : 'log'
      const readStart = Math.max(0, start - context)
      let chunk = await this.read(input.experimentId, kind, readStart, input.serverId, undefined, cursor?.generation, signal)
      const reset = chunk.reset
      let beginning = chunk.reset ? chunk.offset : start
      const prefixBytes = chunk.reset ? 0 : start - readStart
      const buffers = [Buffer.from(chunk.data, 'base64')]
      let size = buffers[0]!.length
      while (!chunk.eof && size < prefixBytes + input.limit + context) {
        const next = await this.read(input.experimentId, kind, chunk.nextOffset, input.serverId, undefined, chunk.generation, signal)
        if (next.reset || next.generation !== chunk.generation) throw new Error('Legacy log rotated during reading')
        if (next.nextOffset <= chunk.nextOffset) break
        chunk = next; const bytes = Buffer.from(chunk.data, 'base64'); buffers.push(bytes); size += bytes.length
      }
      // Redaction lookbehind can start before the end of a truncated file.
      if (!reset && chunk.eof && cursor !== undefined && cursor.offset > chunk.nextOffset) {
        const { cursor: _cursor, before: _before, ...restart } = input
        return { ...await this.logRead({ ...restart, fromStart: true }, signal), reset: true }
      }
      // Redact the surrounding bytes before slicing so adjacent pages cannot reveal a split credential.
      let bytes = Buffer.from(redactObservation(Buffer.concat(buffers).toString('latin1'), encodedSecrets, true), 'latin1').subarray(prefixBytes)
      if (input.before !== undefined && beginning > 0) {
        let prefix = 0
        while (prefix < bytes.length && (bytes[prefix]! & 0xc0) === 0x80) prefix++
        beginning += prefix; bytes = bytes.subarray(prefix)
      }
      let end = Math.min(bytes.length, input.before === undefined ? input.limit : Math.max(0, input.before.offset - beginning))
      if ((!chunk.eof || end < bytes.length) && end > 0) {
        let lead = end - 1
        while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80) lead--
        const first = bytes[lead]!
        const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1
        if (lead + width > end) end = lead
      }
      const next = (offset: number) => ({ experimentId: input.experimentId, serverId: input.serverId, sourceId: input.sourceId, stream: input.stream, generation: chunk.generation, offset })
      return publish({ lines: end === 0 ? [] : [{ seq: beginning, stream: 'mixed', text: bytes.subarray(0, end).toString('utf8') }],
        cursor: next(beginning + end), before: next(beginning), hasEarlier: beginning > 0, hasMore: !chunk.eof || end < bytes.length, reset, missing: chunk.generation === '' })
    }
    const page = observationPageSchema.parse(await this.call(record, 'observation-read', input, signal))
    for (const cursor of [page.cursor, page.before]) if (cursor.experimentId !== input.experimentId || cursor.serverId !== input.serverId
      || cursor.sourceId !== input.sourceId || cursor.stream !== input.stream) throw new Error('Log response belongs to another source')
    return publish(page)
  }

  private async archiveSecrets(record: FleetExperiment): Promise<string[]> {
    const refs = new Set<string>(record.servers.flatMap(server => [sshPasswordRef(server),
      `ASPERA_CLUSTER_NODE_${server.id.replaceAll('-', '_')}`, `ASPERA_CLUSTER_COORDINATOR_${server.id.replaceAll('-', '_')}`]))
    for (const saved of record.servers) {
      const current = this.servers().servers.find(server => server.id === saved.id)
      if (current !== undefined) refs.add(sshPasswordRef(current))
    }
    const secrets: string[] = []
    for (const model of Object.values(record.models ?? {})) {
      const configuration = await this.ctx.credentials.resolve(credentialRef(model.configurationRef))
      if (configuration === undefined) continue
      const saved = privateModelConfigurationSchema.parse(JSON.parse(configuration.value)); refs.add(saved.keyRef)
      const scan = (value: unknown): void => {
        if (value === null || typeof value !== 'object') return
        for (const [key, entry] of Object.entries(value)) {
          if (/^(?:extra)?headers$/i.test(key) && entry !== null && typeof entry === 'object') secrets.push(...Object.values(entry).filter((item): item is string => typeof item === 'string'))
          else scan(entry)
        }
      }
      scan(saved.options)
    }
    for (const ref of refs) { const value = await this.ctx.credentials.resolve(credentialRef(ref)); if (value !== undefined) secrets.push(value.value) }
    return secrets
  }

  /** @param id - retained experiment. @returns local-copy health, independent of remote task success. */
  archiveStatus(id: ExperimentId): ExperimentArchiveStatus { this.get(id); return this.archives.status(id) }
  /** @param id - retained experiment. @returns remote observations or its explicitly offline copy. */
  storageUsage(id: ExperimentId): Promise<ExperimentStorageUsage> { return this.environments.usage(id) }
  /** @param id - retained experiment. @returns actual node capacity plans or an empty list before assessment. */
  storagePlan(id: ExperimentId) { return this.environments.plans(id) }
  /** @param id - retained experiment. @returns node-bound retention policies and proposals. */
  storagePolicies(id: ExperimentId) { return this.environments.storagePolicies(id) }
  /** @param id - retained experiment. @param proposalId - proposed change. @param expectedRevision - original approved revision. @param approve - operator decision. @returns saved decision after node validation. */
  decideStoragePolicy(id: ExperimentId, proposalId: string, expectedRevision: number, approve: boolean) { return this.environments.decideStoragePolicy(id, proposalId, expectedRevision, approve) }
  /** @param id - retained task. @param proposalId - rejected Agent proposal. @param expectedRevision - approved revision. @returns an explicit successor preserving the original rejection. */
  reconsiderStoragePolicy(id: ExperimentId, proposalId: string, expectedRevision: number) { return this.environments.reconsiderStoragePolicy(id, proposalId, expectedRevision) }
  /** @param id - retained experiment. @param serverId - assigned server. @param cursor - bounded scan continuation. @returns refreshed account-side storage measurements. */
  refreshStorage(id: ExperimentId, serverId: ExperimentServerId, cursor?: string) { return this.environments.refresh(id, serverId, cursor) }
  /** @param id - retained experiment. @returns reference-checked cleanup candidates. */
  previewCacheCleanup(id: ExperimentId): Promise<ExperimentCachePreview> { return this.environments.preview(id) }
  /** @param request - candidate-bound operation. @returns durable per-node results without changing training outcomes. */
  cleanupCache(request: ExperimentCacheCleanup): Promise<ExperimentCacheResult> { return this.environments.cleanup(request) }
  /** @param id - retained experiment. @returns current copy status after requesting a read-only synchronization. */
  syncArchive(id: ExperimentId): ExperimentArchiveStatus { this.get(id); return this.archives.request(id) }

  /** @param raw - experiment, node and sampled-time range. @returns only recorded measurements. */
  async metrics(raw: MetricRead): Promise<MetricSample[]> {
    const input = metricReadSchema.parse(raw); const record = this.get(input.experimentId)
    if (!record.servers.some(server => server.id === input.serverId)) throw new Error('Node belongs to another experiment')
    const saved = this.archives.store(input.experimentId)
    if (saved?.hasFacts(input.serverId)) return saved.metrics(input)
    if (record.receipt === undefined) return []
    try {
      const samples = z.array(metricSampleSchema).parse(await this.call(record, 'observation-metrics', input))
      if (samples.some(sample => sample.experimentId !== input.experimentId || sample.serverId !== input.serverId)) throw new Error('Metrics belong to another experiment or node')
      return samples
    }
    catch (error) { if (error instanceof CoordinatorRequestError && error.status === 404) return []; throw error }
  }

  /** @param id - saved experiment. @returns progress bound to its pinned plan and Session; unsupported releases remain unchanged. */
  async executionProgress(id: ExperimentId): Promise<import('@aspera/experiments').ExecutionProgressRead> {
    const record = this.get(id)
    const saved = this.archives.store(id)?.progress()
    const remote = record.latest ?? record.receipt
    if (saved !== undefined && (saved.progress === undefined || (saved.progress.planRevision === remote?.plan?.revision
      && saved.progress.sessionId === (remote?.sessionId ?? `aspera-execution-${id}`)))) return saved
    if (record.receipt === undefined) return { supported: false }
    try {
      const result = executionProgressReadSchema.parse(await this.call(record, 'execution-progress', { experimentId: id }))
      const current = this.get(id)
      const remote = current.latest ?? current.receipt!
      if (result.progress !== undefined && (result.progress.experimentId !== id || result.progress.planRevision !== remote.plan?.revision
        || result.progress.sessionId !== (remote.sessionId ?? `aspera-execution-${id}`))) throw new Error('Execution progress belongs to another experiment, plan or Session')
      return result
    } catch (error) {
      if (error instanceof CoordinatorRequestError && error.status === 404 && error.message === 'cluster route not found') return { supported: false }
      throw error
    }
  }

  /**
   * Read bounded bytes from one experiment and source.
   * @param id - experiment.
   * @param kind - stream or artifact.
   * @param offset - byte cursor.
   * @param serverId - node for log or file.
   * @param path - artifact name.
   * @param generation - prior file identity.
   * @param signal - cancels an HTTP download and its active SSH read.
   * @returns bounded bytes with a resumable cursor.
   */
  async read(id: ExperimentId, kind: 'log' | 'file' | 'events' | 'agent-log', offset: number, serverId?: ExperimentServerId,
    path?: string, generation?: string, signal?: AbortSignal): Promise<ClusterChunk> {
    return clusterChunkSchema.parse(await this.call(this.get(id), kind, { experimentId: id, offset, serverId, path, generation }, signal))
  }

  /** Abort local preparations and flush all owned records. Remote accepted work remains independent. */
  async close(): Promise<void> {
    this.closing = true
    await this.publicServiceChecks.close()
    await this.acceptanceRecoveries.close()
    await this.completionReviews.close()
    await this.finalizationRecords.close()
    for (const pending of this.preparing.values()) pending.abort.abort(new Error('local dispatcher stopped'))
    await this.environments.close()
    await this.interruptions.close()
    await this.archives.close()
    await this.chain
    await Promise.all([...this.preparing.values()].map(pending => pending.done))
    await Promise.allSettled([...this.checks.values(), ...this.deletionWork.values()])
    await Promise.allSettled(this.acceptance.values())
    await Promise.allSettled(this.localCleanupWork.values())
    await this.removals.close()
    await this.remoteTasks.close()
    await this.installations.close()
    await this.store.close()
  }
}
