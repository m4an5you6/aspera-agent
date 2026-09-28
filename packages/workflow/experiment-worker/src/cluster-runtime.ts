/** Remote coordinator execution and private node connections. */
import { createHash } from 'node:crypto'
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type {} from '@deepseek-ai/dsh-subprocess'
import { clusterCommandResultSchema, clusterSubmissionSchema, serverIdSchema } from './cluster-protocol.ts'
import type { ClusterCommandResult, ClusterRecord, ClusterSubmission, ExperimentId, ExperimentServerId } from './cluster-protocol.ts'
import type { ClusterExecutor, ClusterOutcome } from './cluster-queue.ts'
import { request } from './transport.ts'
import { readClusterChunk } from './cluster-files.ts'

/** Credentials travel separately from public receipts. */
export const clusterPrivateSchema = z.object({
  submission: clusterSubmissionSchema,
  connections: z.array(z.object({
    serverId: serverIdSchema, token: z.string().min(32), password: z.string().optional(),
    knownHostsFile: z.string(), identityFile: z.string().optional(),
  }).strict()),
  modelCredentialFile: z.string(), toolTimeoutMs: z.number().int().positive(),
  agentModel: z.object({ provider: z.string(), model: z.string() }),
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
}

/**
 * Load private credentials for the identified experiment only.
 * @param root - coordinator root.
 * @param id - experiment.
 * @returns checked private settings.
 */
export function readClusterPrivate(root: string, id: ExperimentId): ClusterPrivate {
  const value = clusterPrivateSchema.parse(JSON.parse(readFileSync(resolve(root, 'secrets', `${id}.json`), 'utf8')) as unknown)
  if (value.submission.experimentId !== id || value.submission.coordinator.remoteRoot !== root) throw new Error('private experiment settings do not match this coordinator')
  return value
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
    toolTimeoutMs: runtime.toolTimeoutMs }, connection.token, `/experiment/v2/node/${operation}`, 'POST',
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
  if (!existsSync(resolve(config.root, 'releases', submission.deploymentId,
    '.ready'))) throw new Error('experiment source release is not ready')
  if (!existsSync(runtime.modelCredentialFile)) throw new Error('experiment model credentials have not been transferred')
  for (const node of submission.nodes) {
    const connection = runtime.connections.find(connection => connection.serverId === node.server.id)
    if (connection === undefined || !existsSync(connection.knownHostsFile)) throw new Error('node credentials have not been transferred')
    if (node.server.authMode === 'password' && !connection.password) throw new Error('node password is missing')
    if (node.server.authMode === 'key' && (connection.identityFile === undefined || !existsSync(connection.identityFile))) throw new Error('node identity file is missing')
  }
  for (const input of submission.inputs) {
    if (await clusterFileHash(resolve(config.root, 'runs', submission.experimentId, 'inputs', input.name)) !== input.sha256) throw new Error(`input digest mismatch: ${input.name}`)
  }
  return runtime
}

/** Allocate all nodes before validating their communication and staged inputs. */
async function prepareNodes(config: ClusterRuntimeConfig, runtime: ClusterPrivate, signal: AbortSignal): Promise<void> {
  const submission = runtime.submission
  const allocated = await Promise.allSettled(submission.nodes.map(node => clusterNodeRequest(runtime, node.server.id, 'allocate', {
    deploymentId: submission.deploymentId, node,
  }, signal)))
  for (const result of allocated) if (result.status === 'rejected') throw result.reason
  if (submission.nodes.length > 1) {
    for (const node of submission.nodes) {
      if (node.server.trainingAddress === undefined) throw new Error(`Training address is required for ${node.server.name}; configure node-to-node networking before joint execution.`)
    }
    const listening = await Promise.allSettled(submission.nodes.map(async node => ({ node,
      port: z.object({ port: z.number().int() }).parse(await clusterNodeRequest(runtime, node.server.id, 'listen', {}, signal)).port })))
    const listeners = listening.map((result) => { if (result.status === 'rejected') throw result.reason; return result.value })
    const connected = await Promise.allSettled(listeners.flatMap(peer => submission.nodes
      .filter(node => node.server.id !== peer.node.server.id).map(node =>
        clusterNodeRequest(runtime, node.server.id, 'connect', { host: peer.node.server.trainingAddress, port: peer.port }, signal))))
    for (const result of connected) if (result.status === 'rejected') throw result.reason
  }
  for (const node of submission.nodes) {
    for (const input of submission.inputs) {
      let offset = 0
      const path = resolve(config.root, 'runs', submission.experimentId, 'inputs', input.name)
      do {
        const chunk = readClusterChunk(path, offset, undefined, config.chunkBytes)
        const result = z.object({ nextOffset: z.number().int() }).parse(await clusterNodeRequest(runtime, node.server.id, 'input', {
          path: `inputs/${input.name}`, offset, data: chunk.data,
        }, signal))
        if (result.nextOffset !== chunk.nextOffset) throw new Error('input transfer returned a different cursor')
        offset = chunk.nextOffset
        if (chunk.eof) break
      } while (true)
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
  name: 'started.json' | 'outcome.json' | 'execution.json'): void {
  const path = resolve(root, 'runs', id, name)
  writeFileSync(`${path}.incoming`, JSON.stringify(value), { mode: 0o600 })
  renameSync(`${path}.incoming`, path)
}

/** Launches an experiment's immutable source through the supported worker profile. */
export class RemoteClusterExecutor implements ClusterExecutor {
  constructor(private readonly ctx: Context, private readonly config: ClusterRuntimeConfig) {}

  /**
   * @param record - interrupted allocation.
   * @returns whether every selected node confirmed release.
   */
  async reconcile(record: ClusterRecord): Promise<boolean> {
    const runtime = readClusterPrivate(this.config.root, record.submission.experimentId)
    const results = await Promise.allSettled(runtime.submission.nodes.map(node => clusterNodeRequest(runtime, node.server.id, 'release')))
    const execution = resolve(this.config.root, 'runs', record.submission.experimentId, 'execution.json')
    const confirmed = !existsSync(execution) || z.object({ cleanupConfirmed: z.boolean() }).parse(JSON.parse(readFileSync(execution, 'utf8')) as unknown).cleanupConfirmed
    return confirmed && results.every(result => result.status === 'fulfilled' && z.object({ released: z.boolean() }).parse(result.value).released)
  }

  /**
   * Execute the whole allocated group and report execution identity.
   * @param record - allocated task.
   * @param signal - cancellation intent.
   * @param started - persists execution identity.
   * @returns execution and cleanup facts.
   */
  async run(record: ClusterRecord, signal: AbortSignal, started: (sessionId: string,
    goalId: string) => Promise<void>): Promise<ClusterOutcome> {
    const submission = record.submission
    const firstNode = submission.nodes[0]
    if (firstNode === undefined) throw new Error('experiment requires at least one node')
    const runtime = await validateClusterAdmission(this.config, submission)
    await prepareNodes(this.config, runtime, signal)
    signal.throwIfAborted()
    const runRoot = resolve(this.config.root, 'runs', submission.experimentId)
    const workspace = resolve(runRoot, 'agent-workspace')
    mkdirSync(workspace, { recursive: true, mode: 0o700 })
    writeClusterReceipt(this.config.root, submission.experimentId, { cleanupConfirmed: false }, 'execution.json')
    const child = this.ctx.subprocess.spawn({
      argv: [process.execPath, resolve(this.config.root, 'releases', submission.deploymentId, 'apps/cli/lib/bin.js'),
        '--profile', 'experiment-worker'],
      cwd: workspace, graceMs: this.config.cleanupTimeoutMs, signal,
      env: {
        DSH_HOME: resolve(this.config.root, 'state', 'experiments', submission.experimentId),
        DSH_EXPERIMENT_ROLE: 'agent', DSH_CLUSTER_ROOT: this.config.root, DSH_CLUSTER_EXPERIMENT: submission.experimentId,
        DSH_CLUSTER_GENERATION: readFileSync(resolve(this.config.root, 'state', 'coordinator.generation'), 'utf8'),
        DSH_CLUSTER_CHUNK_BYTES: String(this.config.chunkBytes), DSH_CLUSTER_FILE_LIMIT: String(this.config.fileLimit),
        DSH_CLUSTER_CLEANUP_MS: String(this.config.cleanupTimeoutMs), DSH_CLUSTER_POLL_MS: String(this.config.pollIntervalMs),
        DSH_EXPERIMENT_WORKSPACE: workspace, DSH_EXPERIMENT_TOKEN_FILE: resolve(this.config.root, 'secrets', 'coordinator.token'),
        DSH_EXPERIMENT_MODEL_CREDENTIAL_FILE: runtime.modelCredentialFile,
        DSH_EXPERIMENT_DEPLOYMENT_ID: submission.deploymentId, DSH_EXPERIMENT_LOG_FILE: resolve(runRoot, 'agent.log'),
        DSH_EXPERIMENT_PORT: '0', DSH_EXPERIMENT_DEVICES: '', DSH_EXPERIMENT_BWRAP: firstNode.backendPath,
        DSH_EXPERIMENT_HIDDEN_PATHS: [resolve(this.config.root, 'secrets'), resolve(this.config.root, 'state')].join(','),
      }, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
    const append = (chunk: Buffer) => {
      try { appendFileSync(resolve(runRoot, 'agent.log'), chunk, { mode: 0o600 }) }
      catch (error) { this.ctx.logger.error(String(error)); child.terminate() }
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    let reported = false
    let report: Promise<void> = Promise.resolve()
    const poll = () => {
      const path = resolve(runRoot, 'started.json')
      if (reported || !existsSync(path)) return
      const value = z.object({ sessionId: z.string(), goalId: z.string() }).parse(JSON.parse(readFileSync(path, 'utf8')) as unknown)
      reported = true
      report = started(value.sessionId, value.goalId)
      void report.catch((error: unknown) => { this.ctx.logger.error(String(error)); child.terminate() })
    }
    const timer = setInterval(() => {
      try { poll() } catch (error) { this.ctx.logger.error(String(error)); child.terminate() }
    }, this.config.pollIntervalMs)
    try {
      await child.done
      poll()
      await report
      if (!await child.waitForExit(AbortSignal.timeout(this.config.cleanupTimeoutMs))) throw new Error('experiment Agent cleanup is unconfirmed')
    } finally {
      clearInterval(timer)
      child.terminate()
      await child.done.catch((error: unknown) => { this.ctx.logger.debug(String(error)) })
      if (await child.waitForExit(AbortSignal.timeout(this.config.cleanupTimeoutMs))) {
        writeClusterReceipt(this.config.root, submission.experimentId, { cleanupConfirmed: true }, 'execution.json')
      }
    }
    const outcomePath = resolve(runRoot, 'outcome.json')
    const outcome = existsSync(outcomePath)
      ? z.object({ state: z.enum(['completed', 'blocked', 'failed']),
        detail: z.string().optional() }).parse(JSON.parse(readFileSync(outcomePath, 'utf8')) as unknown)
      : { state: signal.aborted ? 'cancelled' as const : 'interrupted' as const,
        detail: 'Experiment Agent stopped without a terminal receipt.' }
    return { ...outcome, resourcesReleased: await this.reconcile(record) }
  }
}
