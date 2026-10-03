/** Remote coordinator execution and private node connections. */
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { setupWorkerProfile } from './profiles.ts'
import type { Context } from '@deepseek-ai/cordis'
import { serverRunRoot, serverReleaseRoot } from './storage.ts'
import { networkProofSchema } from './network-probes.ts'
import { z } from 'zod'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subprocess'
import { clusterCommandResultSchema, clusterSubmissionSchema, serverIdSchema, planSchema, serviceSchema, executionEntrySchema, progressSchema } from '@aspera/experiments'
import type { ClusterCommandResult, ClusterRecord, ClusterSubmission, ExperimentId, ExperimentServerId, InferenceService, ExperimentPlan } from '@aspera/experiments'
import type { ClusterExecutor, ClusterOutcome } from '@aspera/experiments'
import { request } from './transport.ts'
import { readClusterChunk } from '@aspera/experiments'

/** Complete model selection captured before dispatch, including provider-owned reasoning effort. */
export const clusterAgentModelSchema = z.object({ provider: z.string(), model: z.string(),
  reasoningEffort: z.string().min(1).max(200).transform(ReasoningEffortId).optional() }).strict()

/** Credentials travel separately from public receipts. */
export const clusterPrivateSchema = z.object({
  submission: clusterSubmissionSchema,
  connections: z.array(z.object({
    serverId: serverIdSchema, token: z.string().min(32), password: z.string().optional(),
    knownHostsFile: z.string(), identityFile: z.string().optional(),
  }).strict()),
  modelCredentialFile: z.string(), toolTimeoutMs: z.number().int().positive(),
  agentModel: clusterAgentModelSchema,
}).strict()
/** Host-only settings kept outside Agent workspaces. */
export type ClusterPrivate = z.infer<typeof clusterPrivateSchema>

/** Bounds shared by coordinator and execution processes. */
export interface ClusterRuntimeConfig {
  root: string
  chunkBytes: number
  fileLimit: number
  cleanupTimeoutMs: number
  pollIntervalMs: number
  documentationHosts: string[]
  documentationBytes: number
  goalContinuationWindow: number
}

/**
 * Load private credentials for the identified experiment only.
 * @param root - coordinator root.
 * @param id - experiment.
 * @returns checked private settings.
 */
export function readClusterPrivate(root: string, id: ExperimentId): ClusterPrivate {
  const value = clusterPrivateSchema.parse(JSON.parse(readFileSync(resolve(root, 'secrets', `${id}.json`), 'utf8')))
  if (value.submission.experimentId !== id || value.submission.coordinator.remoteRoot !== root) throw new Error('private experiment settings do not match this coordinator')
  return value
}

/** Resolve coordinator artifacts through the saved private submission.
 * @param root - control-state directory. @param id - experiment. @returns pinned run directory.
 */
export function clusterRunRoot(root: string, id: ExperimentId): string {
  return serverRunRoot(readClusterPrivate(root, id).submission.coordinator, id)
}

/**
 * Send an authenticated operation to an assigned node.
 * @param runtime - saved credentials.
 * @param serverId - allocated node.
 * @param operation - node operation.
 * @param body - fields.
 * @param signal - cancellation.
 * @returns node response.
 */
export async function clusterNodeRequest(runtime: ClusterPrivate, serverId: ExperimentServerId, operation: string,
  body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
  const node = runtime.submission.nodes.find(node => node.server.id === serverId)
  const connection = runtime.connections.find(connection => connection.serverId === serverId)
  if (node === undefined || connection === undefined) throw new Error('server is outside this experiment allocation')
  const result = await request({ ...node.server, knownHostsFile: connection.knownHostsFile,
    ...(connection.identityFile === undefined ? {} : { identityFile: connection.identityFile }),
    toolTimeoutMs: runtime.toolTimeoutMs }, connection.token, `/aspera/v${runtime.submission.protocol}/node/${operation}`, 'POST',
  { ...body, experimentId: runtime.submission.experimentId }, signal, connection.password)
  if (result.status !== 200) {
    const error = z.object({ error: z.string() }).safeParse(result.value)
    throw new Error(error.success ? error.data.error : `node ${node.server.name} returned HTTP ${result.status}`)
  }
  return result.value
}

/**
 * Hash file content without retaining the whole file in memory.
 * @param path - staged input.
 * @returns content digest.
 */
export async function clusterFileHash(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Verify the complete source, input and credential transfer before ownership.
 * @param config - coordinator paths.
 * @param submission - admission request.
 * @returns settings after inputs and release are verified.
 */
export async function validateClusterAdmission(config: ClusterRuntimeConfig, submission: ClusterSubmission): Promise<ClusterPrivate> {
  const runtime = readClusterPrivate(config.root, submission.experimentId)
  if (JSON.stringify(runtime.submission) !== JSON.stringify(submission)) throw new Error('private settings differ from submitted requirements')
  if (!existsSync(resolve(serverReleaseRoot(submission.coordinator, submission.deploymentId), '.ready'))) throw new Error('experiment source release is not ready')
  if (!existsSync(runtime.modelCredentialFile)) throw new Error('experiment model credentials have not been transferred')
  for (const node of submission.nodes) {
    const connection = runtime.connections.find(connection => connection.serverId === node.server.id)
    if (connection === undefined || !existsSync(connection.knownHostsFile)) throw new Error('node credentials have not been transferred')
    if (node.server.authMode === 'password' && !connection.password) throw new Error('node password is missing')
    if (node.server.authMode === 'key' && (connection.identityFile === undefined || !existsSync(connection.identityFile))) throw new Error('node identity file is missing')
  }
  for (const input of submission.inputs) {
    if (await clusterFileHash(resolve(serverRunRoot(submission.coordinator, submission.experimentId), 'inputs', input.name)) !== input.sha256) throw new Error(`input digest mismatch: ${input.name}`)
  }
  return runtime
}

/** Allocate all nodes before validating their communication and staged inputs. */
async function prepareNodes(config: ClusterRuntimeConfig, runtime: ClusterPrivate, signal: AbortSignal, deadline?: number): Promise<void> {
  const submission = runtime.submission
  const allocated = await Promise.allSettled(submission.nodes.map(node => clusterNodeRequest(runtime, node.server.id, 'allocate', {
    deploymentId: submission.deploymentId, node,
    ...(submission.protocol === 1 ? { budget: submission.strategy.budget, deadline } : { protocol: submission.protocol }),
  }, signal)))
  for (const result of allocated) if (result.status === 'rejected') throw result.reason
  if (submission.nodes.length > 1) {
    for (const node of submission.nodes) {
      if (node.server.trainingAddress === undefined) throw new Error(`Training address is required for ${node.server.name}; configure node-to-node networking before joint execution.`)
    }
    try {
      const listening = await Promise.allSettled(submission.nodes.map(async node => ({ node,
        proof: networkProofSchema.parse(await clusterNodeRequest(runtime, node.server.id, 'probe-network-start', { serverId: node.server.id }, signal)) })))
      const listeners = listening.map(result => { if (result.status === 'rejected') throw result.reason; return result.value })
      const connected = await Promise.allSettled(listeners.flatMap(peer => submission.nodes
        .filter(node => node.server.id !== peer.node.server.id).map(node =>
          clusterNodeRequest(runtime, node.server.id, 'probe-network-connect', { host: peer.node.server.trainingAddress, proof: peer.proof }, signal)
            .then(value => z.object({ connected: z.literal(true) }).parse(value)))))
      for (const result of connected) if (result.status === 'rejected') throw result.reason
    } finally {
      const closed = await Promise.allSettled(submission.nodes.map(node => clusterNodeRequest(runtime, node.server.id, 'probe-network-stop')))
      // oxlint-disable-next-line no-unsafe-finally -- A failed cleanup must prevent training even after successful connectivity checks.
      for (const result of closed) if (result.status === 'rejected') throw new Error(`Network probe cleanup failed: ${String(result.reason)}`)
    }
  }
  for (const node of submission.nodes) {
    for (const input of submission.inputs) {
      let offset = 0
      const path = resolve(serverRunRoot(submission.coordinator, submission.experimentId), 'inputs', input.name)
      for (;;) {
        const chunk = readClusterChunk(path, offset, undefined, config.chunkBytes)
        const result = z.object({ nextOffset: z.number().int() }).parse(await clusterNodeRequest(runtime, node.server.id, 'input', {
          path: `inputs/${input.name}`, offset, data: chunk.data,
        }, signal))
        if (result.nextOffset !== chunk.nextOffset) throw new Error('input transfer returned a different cursor')
        offset = chunk.nextOffset
        if (chunk.eof) break
      }
      await clusterNodeRequest(runtime, node.server.id, 'verify-input', { name: input.name, sha256: input.sha256 }, signal)
    }
  }
}

/**
 * Read settled command facts from every assigned node.
 * @param runtime - node credentials.
 * @returns all command exit and cleanup facts.
 */
export async function clusterCommandStatuses(
  runtime: ClusterPrivate,
): Promise<{ serverId: ExperimentServerId; commands: ClusterCommandResult[] }[]> {
  return Promise.all(runtime.submission.nodes.map(async node => ({ serverId: node.server.id,
    commands: z.array(clusterCommandResultSchema).parse(await clusterNodeRequest(runtime, node.server.id, 'status')) })))
}

/**
 * Atomically replace one execution identity or cleanup receipt.
 * @param root - private root.
 * @param id - experiment.
 * @param value - identity or outcome.
 * @param name - fixed receipt name.
 */
export function writeClusterReceipt(root: string, id: ExperimentId, value: object,
  name: 'started.json' | 'outcome.json' | 'execution.json' | 'planning-started.json' | 'planning-outcome.json' | 'plan.json' | 'approved-plan.json' | 'progress.json'): void {
  const path = resolve(clusterRunRoot(root, id), name)
  writeFileSync(`${path}.incoming`, JSON.stringify(value), { mode: 0o600 })
  renameSync(`${path}.incoming`, path)
}

type Update = (patch: Pick<Partial<ClusterRecord>, 'state' | 'services' | 'progress' | 'executions'>) => Promise<void>

/** Launches immutable profiles and observes inference independently of Agent lifetime. */
export class RemoteClusterExecutor implements ClusterExecutor {
  constructor(private readonly ctx: Context, private readonly config: ClusterRuntimeConfig) {}

  /** @param record - submitted task. @param signal - cancellation. @returns durable read-only plan. */
  async prepare(record: ClusterRecord, signal: AbortSignal): Promise<{ plan: ExperimentPlan; sessionId: string }> {
    if (record.submission.protocol !== 4) throw new Error('Legacy experiments must execute on their original release')
    await this.agent(record, signal, true)
    const root = serverRunRoot(record.submission.coordinator, record.submission.experimentId)
    const outcome = z.object({ state: z.enum(['completed', 'blocked', 'failed']), detail: z.string().optional() }).parse(JSON.parse(readFileSync(resolve(root, 'planning-outcome.json'), 'utf8')))
    if (outcome.state !== 'completed') throw new Error(outcome.detail ?? 'Agent could not prepare a plan within the assigned constraints')
    return z.object({ plan: planSchema, sessionId: z.string() }).parse(JSON.parse(readFileSync(resolve(root, 'plan.json'), 'utf8')))
  }

  /** @param record - interrupted allocation. @returns whether every node and execution process confirmed cleanup. */
  async reconcile(record: ClusterRecord): Promise<boolean> {
    const runtime = readClusterPrivate(this.config.root, record.submission.experimentId)
    const results = await Promise.allSettled(runtime.submission.nodes.map(node => clusterNodeRequest(runtime, node.server.id, 'release')))
    const path = resolve(serverRunRoot(record.submission.coordinator, record.submission.experimentId), 'execution.json')
    const confirmed = !existsSync(path) || z.object({ cleanupConfirmed: z.boolean() }).parse(JSON.parse(readFileSync(path, 'utf8'))).cleanupConfirmed
    return confirmed && results.every(result => result.status === 'fulfilled' && z.object({ released: z.boolean() }).parse(result.value).released)
  }

  /** @param record - recovered service allocation. @param signal - monitor lifetime. @param update - durable facts. @returns service or cleanup state, without restarting any process. */
  async restore(record: ClusterRecord, signal: AbortSignal, update: Update): Promise<ClusterOutcome> {
    return this.monitorServices(record, signal, update)
  }

  /** @param record - allocated immutable task. @param signal - cancellation. @param started - execution Session identity. @param update - durable progress and services. @returns cleanup facts. */
  async run(record: ClusterRecord, signal: AbortSignal, started: (sessionId: string, goalId: string) => Promise<void>, update: Update): Promise<ClusterOutcome> {
    if (record.plan === undefined || record.approval?.planRevision !== record.plan.revision) throw new Error('execution requires the exact approved plan')
    const runtime = await validateClusterAdmission(this.config, record.submission)
    if (record.submission.protocol !== 4) throw new Error('Legacy experiments must execute on their original release')
    const lifetime = signal
    try {
      await prepareNodes(this.config, runtime, lifetime)
      writeClusterReceipt(this.config.root, record.submission.experimentId, record.plan, 'approved-plan.json')
      await this.agent(record, lifetime, false, started, update)
      const path = resolve(serverRunRoot(record.submission.coordinator, record.submission.experimentId), 'outcome.json')
      const outcome = z.object({ state: z.enum(['completed', 'blocked', 'failed', 'serving']), detail: z.string().optional() }).parse(JSON.parse(readFileSync(path, 'utf8')))
      if (outcome.state === 'serving') return await this.monitorServices(record, signal, update)
      return { ...outcome, resourcesReleased: await this.reconcile(record) }
    } catch (error) {
      return { state: signal.aborted ? 'cancelled' : 'failed', detail: String(error), resourcesReleased: await this.reconcile(record) }
    }
  }

  private async services(record: ClusterRecord): Promise<InferenceService[]> {
    const runtime = readClusterPrivate(this.config.root, record.submission.experimentId)
    return (await Promise.all(runtime.submission.nodes.map(async node => z.array(serviceSchema).parse(await clusterNodeRequest(runtime, node.server.id, 'services'))))).flat()
  }

  private async monitorServices(record: ClusterRecord, signal: AbortSignal, update: Update): Promise<ClusterOutcome> {
    try {
      while (!signal.aborted) {
        const services = await this.services(record)
        await update({ state: 'serving', services })
        const failed = services.find(service => ['failed', 'interrupted'].includes(service.state))
        if (failed !== undefined) return { state: failed.state === 'interrupted' ? 'interrupted' : 'failed', detail: failed.detail ?? 'Inference service failed.', resourcesReleased: await this.reconcile(record) }
        if (services.length === 0) return { state: 'interrupted', detail: 'Registered service identities are missing; execution was not restarted.', resourcesReleased: await this.reconcile(record) }
        if (services.every(service => service.released)) return { state: 'completed', resourcesReleased: await this.reconcile(record) }
        await delay(this.config.pollIntervalMs, undefined, { signal })
      }
    } catch (error) {
      if (!signal.aborted) return { state: 'failed', detail: `Service observation failed: ${String(error)}`, resourcesReleased: await this.reconcile(record) }
    }
    if (signal.reason instanceof Error && signal.reason.message === 'coordinator stopped') return { state: 'serving', resourcesReleased: false }
    const released = await this.reconcile(record)
    await update({ services: await this.services(record).catch(() => record.services) })
    return { state: 'cancelled', resourcesReleased: released }
  }

  private async agent(record: ClusterRecord, signal: AbortSignal, planning: boolean,
    started?: (sessionId: string, goalId: string) => Promise<void>, update?: Update): Promise<void> {
    const submission = record.submission
    const runtime = await validateClusterAdmission(this.config, submission)
    const runRoot = serverRunRoot(submission.coordinator, submission.experimentId)
    const workspace = resolve(runRoot, 'agent-workspace')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    const home = resolve(runRoot, 'agent-homes', planning ? 'plan' : 'execution')
    const release = serverReleaseRoot(submission.coordinator, submission.deploymentId)
    // Profiles are installed before launching; no mutable checkout or CLI argv escape is used.
    await setupWorkerProfile(home, release)
    if (!planning) writeClusterReceipt(this.config.root, submission.experimentId, { cleanupConfirmed: false }, 'execution.json')
    const child = this.ctx.subprocess.spawn({ argv: [process.execPath, resolve(release, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'aspera-worker'],
      cwd: workspace, graceMs: this.config.cleanupTimeoutMs, signal,
      env: { DSH_HOME: home, DSH_EXPERIMENT_ROLE: planning ? 'planner' : 'agent', DSH_CLUSTER_ROOT: this.config.root,
        DSH_CLUSTER_EXPERIMENT: submission.experimentId, DSH_CLUSTER_GENERATION: readFileSync(resolve(this.config.root, 'state', 'coordinator.generation'), 'utf8'),
        DSH_CLUSTER_CHUNK_BYTES: String(this.config.chunkBytes), DSH_CLUSTER_FILE_LIMIT: String(this.config.fileLimit),
        DSH_CLUSTER_CLEANUP_MS: String(this.config.cleanupTimeoutMs), DSH_CLUSTER_POLL_MS: String(this.config.pollIntervalMs),
        DSH_CLUSTER_DOCUMENTATION_HOSTS: JSON.stringify(this.config.documentationHosts), DSH_CLUSTER_DOCUMENTATION_BYTES: String(this.config.documentationBytes),
        DSH_CLUSTER_GOAL_WINDOW: String(this.config.goalContinuationWindow),
        DSH_EXPERIMENT_TOKEN_FILE: resolve(this.config.root, 'secrets/coordinator.token'),
        DSH_EXPERIMENT_MODEL_CREDENTIAL_FILE: runtime.modelCredentialFile, DSH_EXPERIMENT_DEPLOYMENT_ID: submission.deploymentId,
        DSH_EXPERIMENT_PORT: '0', DSH_EXPERIMENT_DEVICES: '', DSH_TELEMETRY_DISABLED: '1' },
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    const append = (chunk: Buffer) => { try { appendFileSync(resolve(runRoot, 'agent.log'), chunk, { mode: 0o600 }) } catch (error) { this.ctx.logger.error(String(error)); child.terminate() } }
    child.stdout?.on('data', append); child.stderr?.on('data', append)
    let reported = false
    let observation: Promise<void> = Promise.resolve()
    const observe = async () => {
      const path = resolve(runRoot, planning ? 'planning-started.json' : 'started.json')
      if (!reported && existsSync(path)) {
        const value = z.object({ sessionId: z.string(), goalId: z.string() }).parse(JSON.parse(readFileSync(path, 'utf8')))
        reported = true; await started?.(value.sessionId, value.goalId)
      }
      if (update !== undefined) {
        const executions = resolve(runRoot, 'executions.jsonl'); const progress = resolve(runRoot, 'progress.json')
        await update({ ...(existsSync(executions) ? { executions: readFileSync(executions, 'utf8').split('\n').filter(Boolean).map(line => executionEntrySchema.parse(JSON.parse(line))) } : {}),
          ...(existsSync(progress) ? { progress: progressSchema.parse(JSON.parse(readFileSync(progress, 'utf8'))) } : {}) })
      }
    }
    const timer = setInterval(() => { observation = observation.then(observe).catch((error: unknown) => { this.ctx.logger.error(String(error)); child.terminate() }) }, this.config.pollIntervalMs)
    try {
      await child.done; clearInterval(timer); await observation; await observe()
      if (!await child.waitForExit(AbortSignal.timeout(this.config.cleanupTimeoutMs))) throw new Error('Agent process cleanup is unconfirmed')
    } finally {
      clearInterval(timer); child.terminate(); await child.done.catch((error: unknown) => { this.ctx.logger.debug(String(error)) }); await observation
      if (!planning && await child.waitForExit(AbortSignal.timeout(this.config.cleanupTimeoutMs))) writeClusterReceipt(this.config.root, submission.experimentId, { cleanupConfirmed: true }, 'execution.json')
    }
    signal.throwIfAborted()
  }
}
