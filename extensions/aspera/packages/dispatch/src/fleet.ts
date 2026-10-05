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
import type { ClusterChunk, ClusterFile, ClusterNode, ClusterPrivate, ClusterRecord, ClusterServer, ExperimentId, ExperimentServerId, ServerSettings, ServerProbe } from '@aspera/runtime'
import { copy, remote, remoteResult, request, shellQuote, prepareSshHostKey } from './transport.ts'
import { installPrivateFile } from './deploy.ts'
import type { DeploymentConfig, PreparedEnvironment } from './deploy.ts'
import { snapshotSource } from './snapshot.ts'
import { sshPasswordRef } from './ssh-account.ts'
import { pinnedTargetSchema } from './deployment-settings.ts'
import { fleetExperimentV5Schema, fleetRegistryV5Schema, fleetRequestV5Schema } from './fleet-schema-v5.ts'
import { serverConnectionCheckSchema, deletedExperimentSchema, experimentDeletionSchema, deleteRequestSchema } from './management-schema.ts'
import { cleanupLocalInputs } from './cleanup.ts'
import type { ServerConnectionCheck, DeletedExperiment, ExperimentDeletion, ExperimentDeletionPreview, DeleteExperimentsRequest, FleetSnapshot } from './types.ts'
import { delegateClusterLogin, describeClusterNode, ensureClusterRole, prepareClusterServer } from './cluster-deploy.ts'
import type { DeploymentRelease } from './cluster-deploy.ts'
import { EnvironmentPreparation, UnconfirmedPreparationCommand } from './environment-preparation.ts'
import type { EnvironmentPreparationInput } from './environment-preparation.ts'
import type { EnvironmentProgress } from './types.ts'
import { environmentRequirements, installedEnvironmentRequirements, inspectEnvironment, checkEnvironment } from './environment.ts'
import type { FleetCreateRequest, FleetExperiment, FleetRegistry, FleetServerInput, PinnedDeployment } from './types.ts'
import type { AnswerExperimentQuestion, ExperimentModels } from '@aspera/experiments'
import { experimentRemovalBlocker, serverRemovalBlockers } from './server-usage.ts'
import { StorageSelection } from './storage-selection.ts'
import { resolveTrainingNetwork } from './network-selection.ts'
import { captureExperimentModels } from './models.ts'
import { experimentPhases } from '@aspera/experiments'
import { openPhaseModelContext, privateModelConfigurationSchema } from '@aspera/runtime'
import { agentRecordRequestSchema, agentRecordPageSchema, projectAgentRecord, experimentProcessSchema, processLogRequestSchema, processLogPageSchema, traceEventChunkSchema } from '@aspera/experiments'
import type { AgentRecordRequest, AgentRecordPage, ExperimentProcess, ProcessLogRequest, ProcessLogPage } from '@aspera/experiments'
import { observationReadSchema, observationSourceSchema, observationSourceIdSchema, observationPageSchema, metricReadSchema, metricSampleSchema } from '@aspera/experiments'
import type { ObservationSource, ObservationRead, ObservationPage, MetricRead, MetricSample } from '@aspera/experiments'
import { observationSources, readObservation, redactObservation, readTraceAttachment } from '@aspera/runtime'

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

const productionDriver: FleetDriver = { prepareSshHostKey, snapshotSource, prepareClusterServer, ensureClusterRole, describeClusterNode,
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
  private closing = false
  private readonly uploadRoot = resolve(resolveDshHome(), 'aspera-inputs')

  private constructor(private readonly ctx: Context, private readonly store: Store,
    private readonly deployment: (server: ServerSettings) => PinnedDeployment,
    private readonly connectionCheckTimeoutMs: number, private readonly driver: FleetDriver) {}

  /**
   * Open durable records and reconcile interrupted local preparation.
   * @param ctx - dispatch host.
   * @param deployment - resolves shared policy against a selected server.
   * @param connectionCheckTimeoutMs - total connection-check deadline, independent of preparation command timeouts.
   * @param driver - release and transport provider; the default uses password SSH.
   * @returns effect-owned fleet service.
   */
  static async open(ctx: Context, deployment: (server: ServerSettings) => PinnedDeployment,
    connectionCheckTimeoutMs: number, driver: FleetDriver = productionDriver): Promise<ExperimentFleet> {
    const store = await ctx.storage.domain.open(storeSpec)
    const fleet = new ExperimentFleet(ctx, store, deployment, connectionCheckTimeoutMs, driver)
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
      if (store.table('deleted').get(id) !== undefined) {
        await store.table('deletions').put(id, { experimentId: id, operationId: job.operationId, cleanupRemote: job.cleanupRemote, started: job.started, state: 'deleted', nodes: [], updatedAt: job.updatedAt })
      } else if (job.state === 'deleting') await store.table('deletions').put(id, { ...job, state: 'failed', detail: 'Cleanup was interrupted; retry to resume saved progress', updatedAt: Date.now() })
    }
    for (const [id, record] of store.table('experiments').entries()) {
      if (store.table('deleted').get(id) !== undefined) { await store.table('experiments').delete(id); continue }
      if (record.state === 'preparing') await store.table('experiments').put(id, { ...record, state: 'failed', detail:
        record.submission === undefined ? 'Local preparation was interrupted before remote handover.' : 'Submission outcome is unknown; refresh to reconcile the saved experiment id.' })
    }
    ctx.on('domain/changed', (change) => {
      if (change.domain === 'aspera_fleet') ctx.emit('experiment-fleet/changed',
        { kind: change.table === 'registry' ? 'servers' : 'experiments' })
    })
    return fleet
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => {}, () => {})
    return result
  }

  private async onServer<T>(id: ExperimentServerId, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const prior = this.serverChains.get(id) ?? Promise.resolve()
    const result = prior.then(async () => {
      signal.throwIfAborted()
      for (const record of this.list()) {
        const environment = record.preparation?.environments?.find(value => value.serverId === id)
        if (environment?.pendingCommand === undefined) continue
        const server = record.coordinator.id === id ? record.coordinator : record.servers.find(value => value.id === id)
        const target = record.coordinator.id === id ? record.coordinatorTarget : record.targets[record.servers.findIndex(value => value.id === id)]
        if (server === undefined || target === undefined) throw new Error('Pending preparation command has no saved server')
        const directory = environment.pendingCommand.directory
        const exit = await this.driver.remote(target, `if [ -f ${shellQuote(directory + '/exited')} ]; then cat ${shellQuote(directory + '/exited')}; else printf unknown; fi`, signal, await this.password(server))
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
    return registry
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
   * Remove an unused server from future selections.
   * @param id - server registration to remove; historical snapshots and remote files remain.
   * @returns registry after safe removal.
   */
  removeServer(id: ExperimentServerId): Promise<FleetRegistry> {
    return this.serial(async () => {
      const current = this.servers()
      if (serverRemovalBlockers(id, this.list(), current.checks?.[id]?.result ?? current.checks?.[id]?.lastSuccess?.result ?? current.probes?.[id], [...this.store.table('deleted').entries()].map(([key]) => key)).length > 0) {
        throw new Error('Server has pending work or unconfirmed cleanup; stop or reconcile that work before removing its registration')
      }
      const servers = current.servers.filter(server => server.id !== id)
      const { [id]: _removedProbe, ...probes } = current.probes ?? {}
      if ([...this.store.table('deletions').entries()].some(([, job]) => job.state === 'deleting' && job.nodes.some(node => node.serverId === id))) throw new Error('Experiment file cleanup is still in progress')
      const { [id]: _removedCheck, ...checks } = current.checks ?? {}
      const next = { servers, probes, checks }
      await this.store.table('registry').put('servers', next)
      const removed = current.servers.find(server => server.id === id)
      if (removed !== undefined) await this.removeUnusedCredential(sshPasswordRef(removed))
      return next
    })
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
    const key = credentialRef(ref)
    if ((await this.ctx.credentials.describe(key)).writable) await this.ctx.credentials.unset(key)
  }

  /** Complete snapshots include deletion identities so stale replies cannot restore rows. @returns public management state. */
  snapshot(): FleetSnapshot {
    return { registry: this.servers(), experiments: this.list(), deletedIds: [...this.store.table('deleted').entries()].map(([id]) => id),
      deletions: [...this.store.table('deletions').entries()].map(([, job]) => job) }
  }

  /** Compute removal eligibility without changing tasks or remote files.
   * @param rawIds - selected experiments. @returns node directories and outstanding obligations.
   */
  previewDeletion(rawIds: string[]): ExperimentDeletionPreview[] {
    const ids = z.array(experimentIdSchema).max(100).parse(rawIds)
    return ids.map(id => {
      const record = this.get(id)
      const reason = this.preparing.has(id) ? 'active' : experimentRemovalBlocker(record)
      const servers = [...new Map([record.coordinator, ...record.servers].map(server => [server.id, server])).values()]
      const nodes = servers.flatMap(server => {
        const placement = server.storagePlacement ?? record.preparation?.placements.find(value => value.serverId === server.id)
        return placement === undefined ? [] : [{ serverId: server.id, name: server.name, path: placement.runRoot }]
      })
      return { experimentId: id, name: record.request.name ?? record.request.objective.split('\n')[0]!.slice(0, 120),
        eligible: reason === undefined, ...(reason === undefined ? {} : { reason }), cleanupAvailable: nodes.length === servers.length, nodes }
    })
  }

  /** Remove confirmed terminal records, retaining failures and per-node cleanup receipts.
   * @param raw - explicit batch identity and cleanup choice. @returns independent outcomes, including skipped active records.
   */
  async deleteExperiments(raw: DeleteExperimentsRequest): Promise<ExperimentDeletion[]> {
    const input = deleteRequestSchema.parse(raw)
    return Promise.all(input.experimentIds.map(id => {
      const existing = this.deletionWork.get(id)
      if (existing !== undefined) return existing.then(job => {
        if (job.cleanupRemote !== input.cleanupRemote) throw new Error('Cleanup is already running with a different policy')
        return job
      })
      const work = this.deleteOne(id, input).finally(() => { this.deletionWork.delete(id) })
      this.deletionWork.set(id, work)
      return work
    }))
  }

  private async deleteOne(id: ExperimentId, input: z.infer<typeof deleteRequestSchema>): Promise<ExperimentDeletion> {
    let job = await this.serial(async () => {
      if (this.closing) throw new Error('Experiment management is stopping')
      const prior = this.store.table('deletions').get(id)
      if (this.store.table('deleted').get(id) !== undefined && prior !== undefined) return { ...prior, state: 'deleted' as const }
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
      if (job.cleanupRemote) for (const node of job.nodes) {
        if (node.state === 'cleaned') continue
        const server = [record.coordinator, ...record.servers].find(value => value.id === node.serverId)!
        const placement = server.storagePlacement ?? record.preparation?.placements.find(value => value.serverId === server.id)
        if (placement === undefined) throw new Error('Saved directory assignment is missing')
        const target = server.id === record.coordinator.id ? record.coordinatorTarget : record.targets[record.servers.findIndex(value => value.id === server.id)]!
        const names = server.id !== record.coordinator.id ? [] : [`${id}.json`, `${id}-model.json`,
          ...record.servers.flatMap(value => [`${id}-${value.id}.known_hosts`, ...(value.identityFile === undefined ? [] : [`${id}-${value.id}.identity`])])]
        const password = await this.password(server)
        try { await this.driver.cleanupServerStorage(target, placement, names, password) } catch (error) {
          const detail = password ? String(error).replaceAll(password, '[redacted]') : String(error)
          job = { ...job, nodes: job.nodes.map(value => value.serverId === node.serverId ? { ...value, detail } : value) }
          throw new Error(detail)
        }
        job = { ...job, nodes: job.nodes.map(value => value.serverId === node.serverId ? { ...value, state: 'cleaned' } : value), updatedAt: Date.now() }
        await this.store.table('deletions').put(id, job)
      }
      cleanupLocalInputs(this.uploadRoot, id)
      cleanupLocalInputs(resolve(resolveDshHome(), 'aspera-observations'), id)
      await this.serial(async () => {
        if (experimentRemovalBlocker(this.get(id)) !== undefined) throw new Error('Experiment state changed before deletion')
        for (const server of [record.coordinator, ...record.servers]) await this.removeUnusedCredential(sshPasswordRef(server), id)
        if (record.models !== undefined) for (const phase of experimentPhases) {
          await this.removeUnusedCredential(record.models[phase].configurationRef, id)
          await this.removeUnusedCredential(`ASPERA_KEY_${id.replaceAll('-', '_')}_${phase}`.toUpperCase(), id)
        }
        await this.store.table('deleted').put(id, { experimentId: id, requestHash: createHash('sha256').update(JSON.stringify(record.request)).digest('hex'),
          deletedAt: Date.now(), ...(record.sourceGoal === undefined ? {} : { sourceGoal: record.sourceGoal }) })
        await this.store.table('experiments').delete(id)
      })
      job = { ...job, nodes: [], state: 'deleted', updatedAt: Date.now() }
    } catch (error) {
      job = this.store.table('deleted').get(id) !== undefined ? { ...job, state: 'deleted', updatedAt: Date.now() }
        : { ...job, state: 'failed', detail: String(error), updatedAt: Date.now() }
    }
    await this.store.table('deletions').put(id, job)
    return job
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
    } finally { clearTimeout(timer) }
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
  list(): FleetExperiment[] { return [...this.store.table('experiments').entries()].filter(([id]) => this.store.table('deleted').get(id) === undefined).map(([, record]) => record).sort((a,
    b) => b.createdAt - a.createdAt) }

  private get(id: ExperimentId): FleetExperiment {
    const record = this.store.table('deleted').get(id) === undefined ? this.store.table('experiments').get(id) : undefined
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
      if (this.store.table('deleted').get(input.experimentId) !== undefined || (sourceGoal !== undefined && [...this.store.table('deleted').entries()].some(([, value]) =>
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
      const coordinator = registry.servers.find(server => server.id === input.coordinatorId)
      const conflict = this.list().find(row => row.coordinator.id !== input.coordinatorId && (experimentRemovalBlocker(row) !== undefined || this.preparing.has(row.request.experimentId) || this.deletionWork.has(row.request.experimentId))
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
      if (placements.length !== serverIds.length || serverIds.some(serverId =>
        !placements.some(placement => placement.serverId === serverId && /\/[a-f0-9]{64}$/.test(placement.releaseRoot)))) {
        throw new Error('Original release directories are missing from the preparation record; copy this experiment')
      }
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
      modelScope = await openPhaseModelContext(this.ctx, record.models.preparation)
      const storage = new StorageSelection()
      const environment = new EnvironmentPreparation()
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
        if (server.id === record.coordinator.id) return record.coordinatorTarget
        const index = record.servers.findIndex(value => value.id === server.id)
        const target = record.targets[index]
        if (target === undefined) throw new Error('Selected server has no pinned preparation settings')
        return target
      }
      for (const server of unique) await this.driver.prepareSshHostKey(targetFor(server), signal)
      const savedDigest = preparation.placements[0]?.releaseRoot.split('/').at(-1)
      if (savedDigest === undefined) source = await this.driver.snapshotSource(pendingTarget.localRepo, pendingTarget.toolTimeoutMs, signal)
      const snapshot: DeploymentRelease = source ?? { digest: z.string().regex(/^[a-f0-9]{64}$/).parse(savedDigest), reuse: true }
      if (preparation.placements.some(placement => !placement.releaseRoot.endsWith('/' + snapshot.digest))) throw new Error('Saved server releases differ; copy this experiment')
      const savedRelease = preparation.placements.find(value => value.serverId === record.coordinator.id)?.releaseRoot
      const requirements = savedRelease === undefined ? this.driver.environmentRequirements(pendingTarget.localRepo)
        : await this.driver.installedEnvironmentRequirements(pendingTarget, savedRelease, snapshot.digest, await this.password(record.coordinator), signal)
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
        experimentId: id, serverId: server.id, serverName: server.name, target, requirements, operation,
        controlRoot: target.remoteRoot, password: await this.password(server),
        directories: target.storagePlacement === undefined ? undefined : {
          workspace: target.storagePlacement.workspaceRoot, release: target.storagePlacement.releaseRoot, control: target.storagePlacement.controlRoot,
        },
        observation: await this.driver.inspectEnvironment(target, await this.password(server), signal),
        pendingCommand: this.get(id).preparation?.environments?.find(value => value.serverId === server.id)?.pendingCommand,
        outputChars: target.preparationOutputChars,
        progress: value => this.environmentProgress(id, value),
      })
      for (const server of unique) {
        await this.onServer(server.id, signal, async () => {
          const target = this.reuseExecutablePaths(server.id, targetFor(server))
          if ('reuse' in snapshot && server.id !== record.coordinator.id) {
            const release = preparation.placements.find(value => value.serverId === server.id)?.releaseRoot
            if (release === undefined) throw new Error('Saved node release is missing; copy this experiment')
            const original = await this.driver.installedEnvironmentRequirements(target, release, snapshot.digest, await this.password(server), signal)
            if (original.node !== requirements.node || original.pnpm !== requirements.pnpm) throw new Error('Saved node release requirements differ; copy this experiment')
          }
          const result = await environment.ensure(handle.agent, await environmentInput(server, target, 'bootstrap'), this.driver,
            async (candidate, observed) => {
              const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
              if (!checked.ready) throw new Error(checked.failures.join('\n'))
              return checked.toolchain
            }, signal)
          record = await this.saveExecutablePaths(id, server.id, result.value.pathEntries)
        })
      }
      let inventories = record.preparation?.inventories ?? []
      if (inventories.length === 0) {
        const observations = await Promise.allSettled(unique.map(async server => {
          const directory = server.storagePreference?.mode === 'manual' ? server.storagePreference.directory
            : server.storagePreference === undefined ? server.remoteRoot : undefined
          return { serverId: server.id, inventory: await this.driver.inspectServerStorage(targetFor(server), directory, await this.password(server), signal) }
        }))
        inventories = observations.map(result => { if (result.status === 'rejected') throw result.reason; return result.value })
        record = await this.preparationStage(id, 'selecting-storage', { inventories })
      }
      let placements = record.preparation?.placements ?? []
      if (placements.length === 0) {
        if (pendingTarget.minimumFreeBytes === undefined) throw new Error('Storage reserve is absent from the pinned deployment policy')
        placements = await storage.run(handle.agent, id, snapshot.digest, unique.map(server => {
          const observed = inventories.find(value => value.serverId === server.id)
          if (observed === undefined) throw new Error('Server inventory is missing')
          return { server, inventory: observed.inventory }
        }), pendingTarget.minimumFreeBytes, signal)
        await this.ctx.sessionPersistence.flush()
        record = await this.preparationStage(id, 'preparing-storage', { placements })
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
      const startRole = async (server: ServerSettings, pending: PinnedDeployment, prepared: PreparedEnvironment, role: 'coordinator' | 'node', token: string, password: string | undefined) => {
        const result = await environment.ensure(handle.agent, await environmentInput(server, pending, 'controller'), this.driver,
          async (candidate, observed, operationSignal) => {
            const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
            if (!checked.ready) throw new Error(checked.failures.join('\n'))
            await this.driver.ensureClusterRole({ ...this.resolvedTarget(pending), pathEntries: checked.toolchain.pathEntries }, prepared, role, token, password, operationSignal)
            return checked.toolchain
          }, signal)
        record = await this.saveExecutablePaths(id, server.id, result.value.pathEntries)
        return { ...this.resolvedTarget(pending), pathEntries: result.value.pathEntries }
      }
      const preparedCoordinator = await this.onServer(record.coordinator.id, signal, async () => {
        const placement = resolvedCoordinator.storagePlacement
        if (placement === undefined) throw new Error('Coordinator storage is missing')
        await this.preparationStage(id, 'deploying')
        const result = await environment.ensure(handle.agent, await environmentInput(record.coordinator, record.coordinatorTarget, 'deployment'), this.driver,
          async (candidate, observed, operationSignal) => {
            const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
            if (!checked.ready) throw new Error(checked.failures.join('\n'))
            const configured = { ...target, pathEntries: checked.toolchain.pathEntries }
            await this.driver.prepareServerStorage(configured, placement, coordinatorPassword, operationSignal)
            return this.driver.prepareClusterServer(configured, snapshot, coordinatorPassword, operationSignal)
          }, signal)
        const prepared = result.value
        target = { ...target, pathEntries: result.pathEntries }
        record = await this.saveExecutablePaths(id, record.coordinator.id, result.pathEntries)
        target = await startRole(record.coordinator, record.coordinatorTarget, prepared, 'coordinator', coordinatorToken, coordinatorPassword)
        return prepared
      })
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
            async (candidate, observed, operationSignal) => {
              const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
              if (!checked.ready) throw new Error(checked.failures.join('\n'))
              const configured = { ...nodeTarget, pathEntries: checked.toolchain.pathEntries }
              await this.driver.prepareServerStorage(configured, nodePlacement, password, operationSignal)
              return this.driver.prepareClusterServer(configured, snapshot, password, operationSignal)
            }, signal)
        const prepared = result.value
        nodeTarget = { ...nodeTarget, pathEntries: result.pathEntries }
        record = await this.saveExecutablePaths(id, server.id, result.pathEntries)
        nodeTarget = await startRole(server, record.targets[index], prepared, 'node', await this.token(server, 'node'), password)
        return this.driver.describeClusterNode(server, prepared, nodeTarget, password, signal)
      }))
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
      })
      for (const server of unique) await this.onServer(server.id, signal, async () => {
        const pending = targetFor(server)
        const expected = server.id === record.coordinator.id ? preparedCoordinator : preparedNodes.find(node => node.server.id === server.id)
        if (expected === undefined) throw new Error('Node has no verified deployment')
        await environment.ensure(handle.agent, await environmentInput(server, pending, 'deployment'), this.driver,
          async (candidate, observed, operationSignal) => {
            if (JSON.stringify(candidate.pathEntries) !== JSON.stringify(pending.pathEntries)) {
              throw new Error('Final acceptance must use the executable directories saved for the running controller')
            }
            const checked = checkEnvironment(observed, requirements, candidate.pathEntries)
            if (!checked.ready) throw new Error(checked.failures.join('\n'))
            const verified = await this.driver.prepareClusterServer({ ...this.resolvedTarget(pending), pathEntries: checked.toolchain.pathEntries },
              { digest: snapshot.digest, reuse: true }, await this.password(server), operationSignal)
            if (verified.backendPath !== expected.backendPath || JSON.stringify(verified.devicePaths) !== JSON.stringify(expected.devicePaths)) {
              throw new Error('Sandbox executable or GPU allocation changed after controller startup')
            }
            return verified
          }, signal)
      })
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
      for (const file of files) {
        const name = basename(file)
        const sha256 = await clusterFileHash(file)
        if (inputs.find(input => input.name === name)?.sha256 !== sha256) throw new Error('Input changed during preparation')
        await this.driver.copy(target, file, `${incoming}/${name}`, signal, coordinatorPassword)
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
        agentModel: selection }
      await this.driver.installPrivateFile(target, `${target.remoteRoot}/secrets/${id}.json`, JSON.stringify(runtime), signal, coordinatorPassword)
      record = await this.serial(async () => {
        const next = { ...this.get(id), submission }
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
      const current = this.get(id)
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
    return { ...target, remoteRoot: target.remoteRoot }
  }

  private reuseExecutablePaths(serverId: ExperimentServerId, target: PinnedDeployment): PinnedDeployment {
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
    const target = record.coordinatorTarget
    const response = await this.driver.request({ ...target, remotePort: target.remotePort + 1 }, await this.token(record.coordinator, 'coordinator'),
      `/aspera/v${record.submission?.protocol ?? 4}/${operation}`, 'POST', body, signal, await this.password(record.coordinator))
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
    return this.serial(async () => {
      const current = this.get(id)
      if ((current.latest?.revision ?? 0) > result.record.revision) return current
      const next = { ...current, latest: result.record, waitingFor: result.waitingFor }
      if (JSON.stringify(next) !== JSON.stringify(current)) await this.store.table('experiments').put(id, next)
      return next
    })
  }

  /** Persist a reply at the coordinator; retrying the same answer has no execution side effect.
   * @param id - owning experiment. @param reply - exact question binding and answer. @returns current receipt.
   */
  async answer(id: ExperimentId, reply: AnswerExperimentQuestion): Promise<FleetExperiment> {
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
    const pending = await this.serial(async () => {
      const current = this.get(id)
      const preparing = this.preparing.get(id)
      if (current.submission === undefined) await this.store.table('experiments').put(id, { ...current, state: 'cancelled' })
      preparing?.abort.abort(new Error('dispatch cancelled'))
      return { done: preparing?.done }
    })
    await pending.done
    const current = this.get(id)
    if (current.submission === undefined) return current
    const latest = clusterRecordSchema.parse(await this.call(current, 'cancel', { experimentId: id, submission: current.submission }))
    return this.serial(async () => {
      const current = this.get(id)
      if ((current.latest?.revision ?? 0) > latest.revision) return current
      const next = { ...current, latest }
      await this.store.table('experiments').put(id, next)
      return next
    })
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
    const record = this.get(input.experimentId)
    if (input.phase !== 'preparation') {
      if (record.submission === undefined || record.submission.protocol !== 4) return { records: [], hasMore: false, missing: true, reset: false }
      try {
        const page = agentRecordPageSchema.parse(await this.call(record, complete ? 'trace-records' : 'records', input))
        if (page.records.some(event => event.experimentId !== input.experimentId || event.phase !== input.phase
          || (page.cursor !== undefined && event.sessionId !== page.cursor.sessionId))
          || (page.cursor !== undefined && (page.cursor.experimentId !== input.experimentId || page.cursor.phase !== input.phase))) throw new Error('Trajectory page belongs to another experiment or phase')
        if (complete) for (const event of page.records) {
          if (!event.truncated) continue
          let data = ''; let digest: string | undefined
          for (;;) {
            const chunk = traceEventChunkSchema.parse(await this.call(record, 'trace-event', { experimentId: event.experimentId, phase: event.phase,
              sessionId: event.sessionId, seq: event.seq, offset: data.length, ...(page.cursor?.generation === undefined ? {} : { generation: page.cursor.generation }), ...(digest === undefined ? {} : { digest }) }))
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
        return agentRecordPageSchema.parse(await this.call(record, 'records', input))
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
    if (record.submission?.protocol !== 4) return []
    return z.array(experimentProcessSchema).parse(await this.call(record, 'processes', { experimentId: id, serverId }))
  }

  /** @param raw - immutable process source and cursor. @returns bounded stdout or stderr bytes. */
  async processLog(raw: ProcessLogRequest): Promise<ProcessLogPage> {
    const request = processLogRequestSchema.parse(raw)
    const record = this.get(request.experimentId)
    if (!record.servers.some(server => server.id === request.serverId)) throw new Error('Node belongs to another experiment')
    return processLogPageSchema.parse(await this.call(record, 'process-log', request))
  }

  /** @param id - experiment. @param serverId - pinned node. @returns registered sources and explicit legacy availability. */
  async logSources(id: ExperimentId, serverId: ExperimentServerId): Promise<{ sources: ObservationSource[]; legacy: boolean }> {
    const record = this.get(id)
    if (!record.servers.some(server => server.id === serverId)) throw new Error('Node belongs to another experiment')
    const local = observationSources(resolve(resolveDshHome(), 'aspera-observations', id)).filter(source => source.serverId === serverId && source.experimentId === id)
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
    const input = observationReadSchema.parse(raw); const record = this.get(input.experimentId)
    if (!record.servers.some(server => server.id === input.serverId)) throw new Error('Node belongs to another experiment')
    const refs = new Set<string>(record.servers.flatMap(server => [sshPasswordRef(server),
      `ASPERA_CLUSTER_NODE_${server.id.replaceAll('-', '_')}`, `ASPERA_CLUSTER_COORDINATOR_${server.id.replaceAll('-', '_')}`]))
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
    const publish = (page: ObservationPage): ObservationPage => ({ ...page, lines: page.lines.map(line => ({ ...line, text: redactObservation(line.text, secrets) })) })
    const cursor = input.cursor ?? input.before
    if (cursor !== undefined && (cursor.experimentId !== input.experimentId || cursor.serverId !== input.serverId || cursor.sourceId !== input.sourceId || cursor.stream !== input.stream)) throw new Error('Log cursor belongs to another source')
    if (input.sourceId.startsWith('preparation-')) return publish(readObservation(resolve(resolveDshHome(), 'aspera-observations', input.experimentId), input))
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

  /** @param raw - experiment, node and sampled-time range. @returns only recorded measurements. */
  async metrics(raw: MetricRead): Promise<MetricSample[]> {
    const input = metricReadSchema.parse(raw); const record = this.get(input.experimentId)
    if (!record.servers.some(server => server.id === input.serverId)) throw new Error('Node belongs to another experiment')
    if (record.receipt === undefined) return []
    try {
      const samples = z.array(metricSampleSchema).parse(await this.call(record, 'observation-metrics', input))
      if (samples.some(sample => sample.experimentId !== input.experimentId || sample.serverId !== input.serverId)) throw new Error('Metrics belong to another experiment or node')
      return samples
    }
    catch (error) { if (error instanceof CoordinatorRequestError && error.status === 404) return []; throw error }
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
    await this.chain
    for (const pending of this.preparing.values()) pending.abort.abort(new Error('local dispatcher stopped'))
    await Promise.all([...this.preparing.values()].map(pending => pending.done))
    await Promise.allSettled([...this.checks.values(), ...this.deletionWork.values()])
    await Promise.allSettled(this.acceptance.values())
    await this.store.close()
  }
}
