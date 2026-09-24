/** Authenticated, durable experiment receiver mounted by the worker profile. */
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { isAbsolute, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { brandString } from '@deepseek-ai/dsh-brand'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import { createUserMessage, boundContextSummary } from '@deepseek-ai/dsh-llm'
import type { GoalView } from '@deepseek-ai/dsh-goal'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, KvTable } from '@deepseek-ai/dsh-storage-domain'
import { experimentRecordSchema, submissionSchema } from './protocol.ts'
import type { ExperimentHealth, ExperimentRecord, ExperimentSubmission } from './protocol.ts'

export { experimentHealthSchema, experimentRecordSchema, experimentSpecSchema, submissionSchema } from './protocol.ts'
export type { ExperimentHealth, ExperimentSpec, ExperimentSubmission, ExperimentRecord } from './protocol.ts'

export const name = 'experiment-worker'
export const inject = ['agents', 'agentDefaultModel', 'goals', 'sessions', 'storageDomain', 'webServer']

/** Worker deployment settings; secrets stay in an owner-only file. */
export interface Config {
  /** Absolute writable directory assigned to the experiment. */
  readonly workspaceRoot: string
  /** Owner-only file containing the receiver Bearer token. */
  readonly tokenFile: string
  /** Absolute path receiving worker process logs. */
  readonly logFile: string
  /** Content digest of the immutable deployed source release. */
  readonly deploymentId: string
  /** Explicitly granted NVIDIA character devices. */
  readonly devicePaths: string[]
}

export const Config: z<Config> = z.object({
  workspaceRoot: z.string().required(),
  tokenFile: z.string().required(),
  logFile: z.string().required(),
  deploymentId: z.string().required(),
  devicePaths: z.array(z.string()).required(),
})

const storeSpec = defineDomain({
  name: 'experiments', version: 1, layout: 'per-record',
  tables: { runs: domainTable<string, ExperimentRecord>(experimentRecordSchema) },
})

type Store = Domain<typeof storeSpec>
const BASE = '/experiment/v1'
const MAX_BODY = 1024 * 1024

/**
 * Hash the validated request for idempotent conflict detection.
 * @param value - submitted deployment and experiment requirements.
 * @returns a stable content digest after schema normalization.
 */
export function submissionHash(value: ExperimentSubmission): string {
  return createHash('sha256').update(JSON.stringify(submissionSchema.parse(value))).digest('hex')
}

/**
 * Constrain outputs to the experiment workspace.
 * @param root - worker workspace root.
 * @param candidate - relative output directory requested by the dispatcher.
 * @returns the absolute output directory after traversal checks.
 */
export function outputPath(root: string, candidate: string): string {
  if (isAbsolute(candidate)) throw new Error('outputPath must be relative to the experiment workspace')
  if (candidate.split(/[\\/]/).includes('..')) throw new Error('outputPath may not traverse the workspace')
  const path = resolve(root, candidate)
  if (!path.startsWith(resolve(root) + sep)) throw new Error('outputPath escapes the experiment workspace')
  let prefix = resolve(root)
  for (const component of candidate.split(/[\\/]/)) {
    if (component === '' || component === '.') continue
    prefix = resolve(prefix, component)
    if (existsSync(prefix) && lstatSync(prefix).isSymbolicLink()) {
      throw new Error('outputPath may not traverse a symbolic link')
    }
  }
  return path
}

function authenticated(req: IncomingMessage, tokenFile: string): boolean {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
  const actual = Buffer.from(header.slice(7))
  const expected = Buffer.from(readFileSync(tokenFile, 'utf8').trim())
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk as Uint8Array)
    size += bytes.length
    if (size > MAX_BODY) throw new Error('request body exceeds 1 MiB')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

function respond(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}

function artifactFiles(root: string): { files: { path: string; sizeBytes: number }[]; truncated: boolean } {
  const files: { path: string; sizeBytes: number }[] = []
  if (!existsSync(root) || !lstatSync(root).isDirectory()) return { files, truncated: false }
  const pending = ['']
  while (pending.length > 0) {
    const prefix = pending.shift() as string
    let children
    try {
      children = readdirSync(resolve(root, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const child of children) {
      if (files.length >= 128) return { files, truncated: true }
      if (child.isSymbolicLink()) continue
      const path = prefix === '' ? child.name : `${prefix}/${child.name}`
      if (child.isDirectory()) { pending.push(path); continue }
      if (!child.isFile()) continue
      try {
        files.push({ path, sizeBytes: statSync(resolve(root, path)).size })
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return { files, truncated: false }
}

/** One receiver process owns the accepted Agent handles and durable records. */
export class ExperimentReceiver {
  private readonly table: KvTable<string, ExperimentRecord>
  private readonly handles = new Map<string, AgentHandle>()
  private readonly listeners = new Map<string, () => void>()
  private chain: Promise<void> = Promise.resolve()
  private closing = false

  constructor(private readonly ctx: Context, private readonly config: Config, private readonly store: Store) {
    this.table = store.table('runs')
  }

  /** Mark pre-crash work interrupted without rerunning training. */
  async recover(): Promise<void> {
    for (const [id, record] of this.table.entries()) {
      if (record.state === 'reserved' || record.state === 'accepted') {
        await this.table.put(id, { ...record, state: 'interrupted', detail: 'worker process stopped before a terminal result', updatedAt: Date.now() })
      }
    }
  }

  /** Serialize all submissions and cancellations for the single-target first stage. */
  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job)
    this.chain = result.then(() => {}, () => {})
    return result
  }

  /**
   * Persist a reservation before publishing an Agent; return only after Session durability.
   * @param raw - untrusted receiver JSON body.
   * @returns the durable receipt or an existing record for the same submission.
   */
  submit(raw: unknown): Promise<ExperimentRecord> {
    return this.serialize(async () => {
      if (this.closing) throw new Error('worker is stopping')
      const request = submissionSchema.parse(raw)
      if (request.deploymentId !== this.config.deploymentId) throw new Error('deployment version changed; prepare again')
      const hash = submissionHash(request)
      const existing = this.table.get(request.submissionId)
      if (existing !== undefined) {
        if (existing.payloadHash !== hash) throw new Error('submission id already belongs to different requirements')
        return existing
      }
      if ([...this.table.entries()].some(([, record]) => record.state === 'accepted')) {
        throw new Error('this worker already owns an active experiment')
      }
      const gpuCount = this.config.devicePaths.filter(path => /^\/dev\/nvidia[0-9]+$/.test(path)).length
      if (request.spec.requiredGpus !== undefined && gpuCount < request.spec.requiredGpus) {
        throw new Error(`experiment requires ${request.spec.requiredGpus} GPUs but only ${gpuCount} are allocated`)
      }
      outputPath(this.config.workspaceRoot, request.spec.outputPath)
      const workspace = realpathSync(this.config.workspaceRoot)
      for (const ref of request.spec.datasetRefs) {
        if (isAbsolute(ref) || ref.split(/[\\/]/).includes('..')) {
          throw new Error(`dataset reference must stay inside the worker workspace: ${ref}`)
        }
        const path = resolve(workspace, ref)
        if (!existsSync(path) || !realpathSync(path).startsWith(workspace + sep)) {
          throw new Error(`dataset reference is missing or escapes the worker workspace: ${ref}`)
        }
      }
      const sessionId = `experiment-${request.submissionId}`
      const now = Date.now()
      const reserved: ExperimentRecord = {
        ...request, payloadHash: hash, sessionId,
        artifactPath: outputPath(this.config.workspaceRoot, request.spec.outputPath),
        workerLogPath: this.config.logFile,
        state: 'reserved', createdAt: now, updatedAt: now,
      }
      await this.table.put(request.submissionId, reserved)
      let handle: AgentHandle | undefined
      try {
        mkdirSync(outputPath(this.config.workspaceRoot, request.spec.outputPath), { recursive: true })
        const selection = request.spec.agentModel ?? this.ctx.agentDefaultModel.currentSelection()
        handle = await this.ctx.agents.create({
          sessionId: brandString<SessionId>(sessionId),
          meta: { cwd: this.config.workspaceRoot },
          agentOptions: { provider: selection.provider, model: selection.model },
          setup: (agentCtx) => { installModelSelection(agentCtx, { current: selection, assembled: undefined }) },
        })
        this.handles.set(request.submissionId, handle)
        const goal = this.ctx.goals.create(handle.agent, { objective: request.spec.objective })
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: this.prompt(request) }],
          source: { kind: 'plugin', plugin: 'experiment-worker', form: 'notice', summary: boundContextSummary(`Experiment ${request.submissionId}`) },
        }))
        if (!await this.ctx.sessions.flush(handle.agent.session)) {
          throw new Error('Session has no durable flush listener; refusing remote ownership')
        }
        const accepted: ExperimentRecord = {
          ...reserved, goalId: goal.id, state: 'accepted', updatedAt: Date.now(),
        }
        await this.table.put(request.submissionId, accepted)
        this.observe(request.submissionId, handle.agent)
        return accepted
      } catch (error: unknown) {
        let detail = error instanceof Error ? error.message : String(error)
        try {
          await handle?.dispose()
        } catch (cleanupError: unknown) {
          detail += `; Agent cleanup failed: ${String(cleanupError)}`
        }
        this.handles.delete(request.submissionId)
        const failed: ExperimentRecord = { ...reserved, state: 'failed', detail, updatedAt: Date.now() }
        await this.table.put(request.submissionId, failed)
        return failed
      }
    })
  }

  private prompt(request: ExperimentSubmission): string {
    const spec = request.spec
    return `Run the independent experiment. Goal: ${spec.objective}\n`
      + `Explicit requirements: ${JSON.stringify({ trainingModel: spec.trainingModel, datasetRefs: spec.datasetRefs, trainingMethod: spec.trainingMethod, requiredGpus: spec.requiredGpus, constraints: spec.constraints })}\n`
      + `Write outputs under ${outputPath(this.config.workspaceRoot, spec.outputPath)}. `
      + 'Choose unspecified values from available authorized resources, record choices and changes in this Session, and preserve every explicit requirement. '
      + 'Try small recoverable adjustments when useful. If the requirements cannot be met without more authority, mark the goal blocked with the concrete cause. '
      + 'Run long training through managed jobs and wait for its real exit code; do not detach shell processes yourself. '
      + 'Do not ask a human or request approval. Report process results, logs, and artifact paths before marking complete.'
  }

  private observe(id: string, agent: Agent): void {
    let settling = false
    const fail = async (error: unknown): Promise<void> => {
      await this.serialize(async () => {
        const record = this.table.get(id)
        if (record?.state === 'accepted') {
          await this.table.put(id, { ...record, state: 'failed', detail: String(error), updatedAt: Date.now() })
        }
      })
      this.listeners.get(id)?.()
      this.listeners.delete(id)
      const handle = this.handles.get(id)
      this.handles.delete(id)
      await handle?.dispose()
    }
    const settle = async (goal: GoalView): Promise<void> => {
      await agent.whenIdle()
      if (!await this.ctx.sessions.flush(agent.session)) {
        throw new Error('Session lost its durable flush listener')
      }
      await this.serialize(async () => {
        const record = this.table.get(id)
        if (record?.state !== 'accepted') return
        const state = goal.phase === 'complete' ? 'complete' : 'blocked'
        await this.table.put(id, {
          ...record, state, detail: goal.blockedReason?.message, updatedAt: Date.now(),
        })
      })
      const handle = this.handles.get(id)
      this.handles.delete(id)
      this.listeners.get(id)?.()
      this.listeners.delete(id)
      await handle?.dispose()
    }
    const offGoal = this.ctx.on('goal/changed', ({ agent: changed, change }) => {
      if (changed !== agent || change.goal === undefined) return
      if (change.goal.phase !== 'complete' && change.goal.phase !== 'blocked') return
      if (settling) return
      settling = true
      void settle(change.goal).catch((error: unknown) => {
        void fail(error).catch((cleanupError: unknown) => {
          this.ctx.logger.error(`experiment-worker: terminal settlement failed: ${String(error)}; cleanup failed: ${String(cleanupError)}`)
        })
      })
    })
    const offError = this.ctx.on('agent/error', ({ agent: failed }) => {
      if (failed !== agent || settling) return
      settling = true
      void agent.whenIdle().then(() => fail('agent execution failed; inspect the Session log'))
        .catch((error: unknown) => { this.ctx.logger.error(`experiment-worker: failed Agent cleanup: ${String(error)}`) })
    })
    this.listeners.set(id, () => { offGoal(); offError() })
    const current = this.ctx.goals.get(agent)
    if (current !== undefined && (current.phase === 'complete' || current.phase === 'blocked')) {
      settling = true
      void settle(current).catch((error: unknown) => {
        void fail(error).catch((cleanupError: unknown) => {
          this.ctx.logger.error(`experiment-worker: terminal settlement failed: ${String(error)}; cleanup failed: ${String(cleanupError)}`)
        })
      })
    }
  }

  /**
   * Read one authoritative receipt; active Goal fields come from the live Session.
   * @param id - submitted experiment id.
   * @returns the current record, or undefined when no submission exists.
   */
  status(id: string): ExperimentRecord | undefined {
    const record = this.table.get(id)
    if (record === undefined) return undefined
    const agent = this.handles.get(id)?.agent
    const goal = agent === undefined ? undefined : this.ctx.goals.get(agent)
    const artifacts = artifactFiles(record.artifactPath)
    return {
      ...record,
      ...(goal === undefined ? {} : { goalPhase: goal.phase }),
      ...(goal?.phase === 'blocked' ? { detail: goal.blockedReason?.message } : {}),
      workerLogAvailable: existsSync(record.workerLogPath),
      artifactFiles: artifacts.files, artifactListTruncated: artifacts.truncated,
    }
  }

  /**
   * Read whether this worker process still owns a submitted experiment.
   * @returns true while an accepted Agent remains active.
   */
  busy(): boolean {
    return this.handles.size > 0
  }

  /**
   * Stop an owned Agent and persist the cancellation.
   * @param id - submitted experiment id.
   * @returns its terminal record, or undefined when unknown.
   */
  cancel(id: string): Promise<ExperimentRecord | undefined> {
    return this.serialize(async () => {
      const record = this.table.get(id)
      if (record?.state !== 'accepted') return record
      const handle = this.handles.get(id)
      if (handle !== undefined) {
        this.listeners.get(id)?.()
        this.listeners.delete(id)
        handle.agent.cancel({ kind: 'hook', reason: 'experiment receiver cancellation' })
        await handle.dispose()
        this.handles.delete(id)
      }
      const cancelled: ExperimentRecord = { ...record, state: 'cancelled', updatedAt: Date.now() }
      await this.table.put(id, cancelled)
      return cancelled
    })
  }

  /** Drain active Agents and the durable store when this worker unloads. */
  async close(): Promise<void> {
    this.closing = true
    await this.chain
    for (const off of this.listeners.values()) off()
    this.listeners.clear()
    for (const handle of this.handles.values()) await handle.dispose()
    this.handles.clear()
    await this.store.close()
  }
}

/** Mount the authenticated loopback route and recover interrupted records. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!isAbsolute(config.workspaceRoot) || !isAbsolute(config.tokenFile) || !isAbsolute(config.logFile)
    || !/^[a-f0-9]{64}$/.test(config.deploymentId)) {
    throw new Error('experiment-worker requires absolute workspace/token paths and a deployment digest')
  }
  mkdirSync(config.workspaceRoot, { recursive: true })
  const token = readFileSync(config.tokenFile, 'utf8').trim()
  if (token.length < 32) throw new Error('experiment-worker requires an existing receiver token of at least 32 characters')
  const store = await ctx.storageDomain.open(storeSpec)
  const receiver = new ExperimentReceiver(ctx, config, store)
  await receiver.recover()
  ctx.effect(() => () => receiver.close(), 'experiment-worker: owned runs')
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: BASE,
    handler: async (req, res) => {
      if (!authenticated(req, config.tokenFile)) { respond(res, 401, { error: 'unauthorized' }); return }
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
      try {
        if (req.method === 'GET' && pathname === `${BASE}/health`) {
          respond(res, 200, { deploymentId: config.deploymentId, ready: true, busy: receiver.busy() } satisfies ExperimentHealth)
        } else if (req.method === 'POST' && pathname === `${BASE}/submit`) {
          const record = await receiver.submit(await readBody(req))
          respond(res, record.goalId === undefined ? 409 : 200, record)
        } else if (req.method === 'GET' && pathname.startsWith(`${BASE}/status/`)) {
          const id = pathname.slice(`${BASE}/status/`.length)
          const record = receiver.status(id)
          respond(res, record === undefined ? 404 : 200, record ?? { error: 'not found' })
        } else if (req.method === 'POST' && pathname.startsWith(`${BASE}/cancel/`)) {
          const id = pathname.slice(`${BASE}/cancel/`.length)
          const record = await receiver.cancel(id)
          respond(res, record === undefined ? 404 : 200, record ?? { error: 'not found' })
        } else if (req.method === 'POST' && pathname === `${BASE}/shutdown`) {
          if (receiver.busy()) { respond(res, 409, { error: 'active experiment' }); return }
          respond(res, 200, { stopping: true })
          setImmediate(() => { process.kill(process.pid, 'SIGTERM') })
        } else {
          respond(res, 404, { error: 'not found' })
        }
      } catch (error: unknown) {
        respond(res, 400, { error: error instanceof Error ? error.message : 'invalid request' })
      }
    },
  }), 'experiment-worker: authenticated receiver')
}
