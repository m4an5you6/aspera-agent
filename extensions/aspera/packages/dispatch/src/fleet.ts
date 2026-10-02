import type {} from '@aspera/runtime'
/** Local server registry, independent dispatch Sessions, and immutable cluster submissions. */
import { randomBytes, randomUUID } from 'node:crypto'
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
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import {
  CLUSTER_HANDOVER, clusterAgentModelSchema, clusterChunkSchema, clusterFileHash, clusterFileSchema, clusterRecordSchema, clusterServerSchema,
  clusterSubmissionSchema, clusterSubmissionV2Schema, experimentIdSchema, serverIdSchema, budgetSchema, answerExperimentQuestionSchema,
} from '@aspera/runtime'
import type { ClusterChunk, ClusterFile, ClusterPrivate, ClusterRecord, ClusterServer, ExperimentId, ExperimentServerId } from '@aspera/runtime'
import { copy, remote, request, shellQuote } from './transport.ts'
import { installPrivateFile } from './deploy.ts'
import type { DeploymentConfig } from './deploy.ts'
import { snapshotSource } from './snapshot.ts'
import { sshPasswordRef } from './ssh-account.ts'
import { pinnedTargetSchema } from './deployment-settings.ts'
import { delegateClusterLogin, describeClusterNode, ensureClusterRole, prepareClusterServer } from './cluster-deploy.ts'
import type { FleetCreateRequest, FleetExperiment, FleetRegistry, FleetServerInput } from './types.ts'
import type { AnswerExperimentQuestion } from '@aspera/experiments'

const registrySchema = z.object({ coordinatorId: serverIdSchema.optional(), servers: z.array(clusterServerSchema) })
const requestSchema = z.object({ experimentId: experimentIdSchema, objective: z.string().trim().min(1).max(20_000),
  serverIds: z.array(serverIdSchema).min(1).max(32), files: z.array(z.string()).max(128).default([]),
  uploads: z.array(z.object({ name: clusterSubmissionV2Schema.shape.inputs.element.shape.name, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()).max(128).default([]), mode: z.enum(['semi', 'automatic']),
}).strict().refine(value => new Set(value.serverIds).size === value.serverIds.length, 'duplicate server selection')
  .refine(value => new Set(value.uploads.map(file => file.name)).size === value.uploads.length, 'duplicate attachment name')
const localSchema = z.object({
  request: z.union([requestSchema, requestSchema.safeExtend({ budget: budgetSchema })]), coordinator: clusterServerSchema, servers: z.array(clusterServerSchema),
  coordinatorTarget: pinnedTargetSchema, targets: z.array(pinnedTargetSchema),
  agentModel: clusterAgentModelSchema,
  createdAt: z.number().int(), state: z.enum(['staging', 'preparing', 'submitted', 'failed', 'cancelled']), detail: z.string().optional(),
  sessionId: z.string(), goalId: z.string().optional(), goalRevision: z.number().optional(),
  sourceGoal: z.object({ sessionId: z.string(), id: z.string(), revision: z.number().int() }).optional(),
  submission: clusterSubmissionSchema.optional(), receipt: clusterRecordSchema.optional(), latest: clusterRecordSchema.optional(),
  handoverRecorded: z.boolean().default(false),
  waitingFor: z.array(serverIdSchema).default([]),
})
const storeSpec = defineDomain({ name: 'aspera_fleet', version: 2, compatibleVersions: [1], layout: 'per-record', tables: {
  registry: domainTable<string, FleetRegistry>(registrySchema),
  experiments: domainTable<ExperimentId, FleetExperiment>(localSchema),
} })
type Store = Domain<typeof storeSpec>

/** Deployment provider for release transfer, private credentials and authenticated control requests. */
export interface FleetDriver {
  snapshotSource: typeof snapshotSource
  prepareClusterServer: typeof prepareClusterServer
  ensureClusterRole: typeof ensureClusterRole
  describeClusterNode: typeof describeClusterNode
  delegateClusterLogin: typeof delegateClusterLogin
  installPrivateFile: typeof installPrivateFile
  remote: typeof remote
  copy: typeof copy
  request: typeof request
}

const productionDriver: FleetDriver = { snapshotSource, prepareClusterServer, ensureClusterRole, describeClusterNode,
  delegateClusterLogin, installPrivateFile, remote, copy, request }

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
  private closing = false
  private readonly uploadRoot = resolve(resolveDshHome(), 'aspera-inputs')

  private constructor(private readonly ctx: Context, private readonly store: Store,
    private readonly deployment: (server: ClusterServer) => DeploymentConfig, private readonly driver: FleetDriver) {}

  /**
   * Open durable records and reconcile interrupted local preparation.
   * @param ctx - dispatch host.
   * @param deployment - resolves shared policy against a selected server.
   * @param driver - release and transport provider; the default uses password SSH.
   * @returns effect-owned fleet service.
   */
  static async open(ctx: Context, deployment: (server: ClusterServer) => DeploymentConfig, driver: FleetDriver = productionDriver): Promise<ExperimentFleet> {
    const store = await ctx.storage.domain.open(storeSpec)
    const fleet = new ExperimentFleet(ctx, store, deployment, driver)
    ctx.effect(() => () => fleet.close(), 'experiment fleet: local preparations')
    if (store.table('registry').get('servers') === undefined) {
      await store.table('registry').put('servers', { servers: [] })
    }
    for (const [id, record] of store.table('experiments').entries()) {
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

  private async onServer<T>(id: ExperimentServerId, operation: () => Promise<T>): Promise<T> {
    const prior = this.serverChains.get(id) ?? Promise.resolve()
    const result = prior.then(operation)
    const done = result.then(() => {}, () => {})
    this.serverChains.set(id, done)
    try { return await result } finally { if (this.serverChains.get(id) === done) this.serverChains.delete(id) }
  }

  /**
   * Read configured servers without credential values.
   * @returns server list and coordinator identity.
   */
  servers(): FleetRegistry {
    const registry = this.store.table('registry').get('servers')
    if (registry === undefined) throw new Error('server registry is missing')
    return registry
  }

  /**
   * Save server settings while retaining the original coordinator.
   * @param raw - complete server definition.
   * @returns persisted registry; the first server remains coordinator.
   */
  saveServer(raw: FleetServerInput): Promise<FleetRegistry> {
    const server = clusterServerSchema.parse(raw)
    if (server.authMode !== 'password' || server.identityFile !== undefined) throw new Error('Aspera server configuration supports password login only')
    return this.serial(async () => {
      const registry = this.servers()
      const previous = registry.servers.find(other => other.id === server.id)
      if (server.id === registry.coordinatorId && previous !== undefined
        && (previous.host !== server.host || previous.sshPort !== server.sshPort
          || previous.remoteRoot !== server.remoteRoot || previous.remotePort !== server.remotePort)) {
        throw new Error('the coordinator address and state directory are fixed; automatic coordinator relocation is not supported')
      }
      if (registry.servers.some(other => other.id !== server.id && other.host === server.host && other.sshPort === server.sshPort)) {
        throw new Error('this SSH server is already configured')
      }
      const servers = registry.servers.some(other => other.id === server.id)
        ? registry.servers.map(other => other.id === server.id ? server : other) : [...registry.servers, server]
      const next = { coordinatorId: registry.coordinatorId ?? server.id, servers }
      await this.store.table('registry').put('servers', next)
      return next
    })
  }

  /**
   * Remove an unused server from future selections.
   * @param id - server to remove.
   * @returns registry after safe removal.
   */
  removeServer(id: ExperimentServerId): Promise<FleetRegistry> {
    return this.serial(async () => {
      const current = this.servers()
      if (id === current.coordinatorId) throw new Error('the coordinator cannot be removed or changed automatically')
      if (this.list().some(record => record.servers.some(server => server.id === id) && (record.state === 'preparing'
        || (record.latest !== undefined && (!record.latest.resourcesReleased || record.latest.state === 'queued'))))) {
        throw new Error('server belongs to a pending or running experiment')
      }
      const next = { ...current, servers: current.servers.filter(server => server.id !== id) }
      await this.store.table('registry').put('servers', next)
      return next
    })
  }

  private async password(server: ClusterServer): Promise<string | undefined> {
    if (server.authMode !== 'password') return undefined
    const value = await this.ctx.credentials.resolve(sshPasswordRef(server))
    if (value === undefined) throw new Error(`SSH password is missing for ${server.name}`)
    return value.value
  }

  private async token(server: ClusterServer, role: 'coordinator' | 'node'): Promise<string> {
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
   * Check SSH connectivity and report GPU and allocation facts.
   * @param id - configured server.
   * @returns GPU inventory and allocation visibility.
   */
  async probe(id: ExperimentServerId): Promise<{ gpuInfo: string; allocations: string[] }> {
    const server = this.servers().servers.find(server => server.id === id)
    if (server === undefined) throw new Error('server not found')
    const target = this.deployment(server)
    const password = await this.password(server)
    const gpuInfo = await this.driver.remote(target, 'nvidia-smi -L', undefined, password)
    let allocations: string[] = []
    try {
      const health = await this.driver.request(target, await this.token(server, 'node'), '/aspera/v1/health', 'GET', undefined, undefined, password)
      if (health.status === 200) {
        allocations = z.object({ node: z.object({ allocations: z.array(z.string()) }) }).parse(health.value).node.allocations
      }
    } catch (error) { this.ctx.logger.debug(`experiment node has no ready control process: ${String(error)}`) }
    return { gpuInfo, allocations }
  }

  /**
   * Read experiments in their durable display order.
   * @returns independent experiments in most-recent-first order.
   */
  list(): FleetExperiment[] { return [...this.store.table('experiments').entries()].map(([, record]) => record).sort((a,
    b) => b.createdAt - a.createdAt) }

  private get(id: ExperimentId): FleetExperiment {
    const record = this.store.table('experiments').get(id)
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
    const submitted = this.store.table('experiments').get(id)
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
      const previous = this.store.table('experiments').get(input.experimentId) ?? (sourceGoal === undefined ? undefined
        : this.list().find(row => row.sourceGoal?.sessionId === sourceGoal.sessionId
          && row.sourceGoal.id === sourceGoal.id && row.sourceGoal.revision === sourceGoal.revision))
      if (previous !== undefined) {
        if (JSON.stringify(previous.request) !== JSON.stringify({ ...input,
          experimentId: previous.request.experimentId })) throw new Error('experiment id is bound to different requirements')
        return previous
      }
      const registry = this.servers()
      const coordinator = registry.servers.find(server => server.id === registry.coordinatorId)
      if (coordinator === undefined) throw new Error('configure the coordinator server before submitting an experiment')
      const selected = input.serverIds.map((id) => {
        const server = registry.servers.find(server => server.id === id)
        if (server === undefined) throw new Error('selected server is no longer configured')
        return server
      })
      const pinned = new Map<ExperimentServerId, ClusterServer>()
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
        agentModel: { ...this.ctx.agentDefaultModel.currentSelection() },
        state: input.uploads.length > 0 ? 'staging' : 'preparing', sessionId, waitingFor: [], handoverRecorded: false,
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
   * @param files - admitted local data files.
   * @returns independent experiment, deduplicated by the caller's Goal revision.
   */
  async createForGoal(agent: Agent, objective: string, serverIds: string[], files: string[], mode: FleetCreateRequest['mode']): Promise<FleetExperiment> {
    const goal = this.ctx.goals.get(agent)
    if (goal === undefined || goal.phase === 'complete') throw new Error('cluster dispatch requires an active local Goal')
    return this.create({ experimentId: randomUUID(), objective, serverIds, files, mode }, { sessionId: agent.id, id: goal.id,
      revision: goal.revision })
  }

  private beginPreparation(id: ExperimentId): void {
    const abort = new AbortController()
    const done = Promise.resolve().then(() => this.prepare(id, abort.signal))
    void done.catch((error: unknown) => { this.ctx.logger.error(`Aspera preparation cleanup failed: ${String(error)}`) })
    this.preparing.set(id, { abort, done })
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

  private async prepare(id: ExperimentId, signal: AbortSignal): Promise<void> {
    let source: Awaited<ReturnType<typeof snapshotSource>> | undefined
    try {
      let record = this.get(id)
      const target = record.coordinatorTarget
      const selection = record.agentModel
      const handle = await this.ctx.agents.create({ sessionId: SessionId(record.sessionId), meta: { cwd: target.localRepo },
        agentOptions: { provider: selection.provider, model: selection.model } })
      this.handles.set(id, handle)
      signal.throwIfAborted()
      const goal = this.ctx.goals.create(handle.agent, { objective: record.request.objective })
      this.ctx.goals.disarm(handle.agent)
      record = await this.serial(async () => {
        signal.throwIfAborted()
        const next = { ...this.get(id), goalId: goal.id, goalRevision: goal.revision }
        await this.store.table('experiments').put(id, next)
        return next
      })
      await this.ctx.sessionPersistence.flush()
      source = await this.driver.snapshotSource(target.localRepo, target.toolTimeoutMs, signal)
      const snapshot = source
      const coordinatorPassword = await this.password(record.coordinator)
      const coordinatorToken = await this.token(record.coordinator, 'coordinator')
      const preparedCoordinator = await this.onServer(record.coordinator.id, async () => {
        const prepared = await this.driver.prepareClusterServer(target, snapshot, coordinatorPassword, signal)
        await this.driver.ensureClusterRole(target, prepared, 'coordinator', coordinatorToken, coordinatorPassword, signal)
        return prepared
      })
      const preparedNodes = await Promise.allSettled(record.servers.map((server, index) => this.onServer(server.id, async () => {
        const nodeTarget = record.targets[index]
        if (nodeTarget === undefined) throw new Error('selected server has no pinned deployment settings')
        const password = await this.password(server)
        const prepared = server.id === record.coordinator.id ? preparedCoordinator : await this.driver.prepareClusterServer(nodeTarget,
          snapshot, password, signal)
        await this.driver.ensureClusterRole(nodeTarget, prepared, 'node', await this.token(server, 'node'), password, signal)
        return this.driver.describeClusterNode(server, prepared, nodeTarget, password, signal)
      })))
      const nodes = preparedNodes.map((result) => {
        if (result.status === 'rejected') throw result.reason
        return result.value
      })
      const inputs: { name: string; sha256: string }[] = []
      const files = record.request.files.map(path => this.localInput(path, target.dataRoots))
      for (const file of record.request.uploads) {
        files.push(resolve(this.uploadRoot, id, file.name))
      }
      const incoming = `${target.remoteRoot}/runs/${id}/inputs`
      await this.driver.remote(target, `umask 077; mkdir -p ${shellQuote(incoming)}`, signal, coordinatorPassword)
      for (const file of files) {
        const name = basename(file)
        if (inputs.some(input => input.name === name)) throw new Error('input file names must be unique')
        const sha256 = await clusterFileHash(file)
        await this.driver.copy(target, file, `${incoming}/${name}`, signal, coordinatorPassword)
        inputs.push({ name, sha256 })
      }
      if (record.request.budget !== undefined) throw new Error('Legacy preparation cannot be converted to protocol 2; copy it to a new experiment')
      const submission = clusterSubmissionV2Schema.parse({ protocol: 2, experimentId: id, deploymentId: snapshot.digest,
        objective: record.request.objective, coordinator: record.coordinator, nodes, inputs, createdAt: record.createdAt,
        strategy: { mode: record.request.mode, coordinator: 'single-agent' },
        versions: { dsh: '0.2.0-rc.2', extension: '0.2.0', harness: snapshot.digest, data: inputs.map(input => input.sha256) } })
      const modelCredentialFile = `${target.remoteRoot}/secrets/${id}-model.json`
      const credentials: Record<string, string> = {}
      for (const name of target.agentCredentialRefs) {
        const credential = await this.ctx.credentials.resolve(credentialRef(name))
        if (credential === undefined) throw new Error(`model credential ${name} is not configured`)
        credentials[name] = credential.value
      }
      await this.driver.installPrivateFile(target, modelCredentialFile, JSON.stringify({ version: 1, refs: credentials }), signal, coordinatorPassword)
      const connections = await Promise.all(record.servers.map(async server => ({ serverId: server.id,
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
      let receipt: ClusterRecord
      try { receipt = clusterRecordSchema.parse(await this.call(record, 'submit', submission)) }
      catch (error) { signal.throwIfAborted(); void error; receipt = clusterRecordSchema.parse(await this.call(record,
        'submit', submission)) }
      await this.accept(record, receipt)
    } catch (error) {
      const current = this.get(id)
      if (current.receipt === undefined) await this.store.table('experiments').put(id, { ...current,
        state: signal.aborted && current.submission === undefined ? 'cancelled' : 'failed', detail: String(error) })
    } finally {
      source?.dispose()
      const handle = this.handles.get(id)
      this.handles.delete(id)
      try { await handle?.dispose() } finally { this.preparing.delete(id) }
    }
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
      `/aspera/v${record.submission?.protocol ?? 2}/${operation}`, 'POST', body, signal, await this.password(record.coordinator))
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
    await Promise.allSettled(this.acceptance.values())
    await this.store.close()
  }
}
