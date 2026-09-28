/** Model-facing local preparation and dispatch over an independent DSH worker. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import type {} from '@deepseek-ai/dsh-goal'
import type { GoalRef } from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { experimentHealthSchema, experimentRecordSchema, experimentSpecSchema, submissionHash } from '@deepseek-ai/dsh-experiment-worker'
import type { ExperimentRecord, ExperimentSpec, ExperimentSubmission } from '@deepseek-ai/dsh-experiment-worker'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { deploy } from './deploy.ts'
import type { DeploymentConfig, PreparedEnvironment } from './deploy.ts'
import { snapshotSource } from './snapshot.ts'
import type { SourceSnapshot } from './snapshot.ts'
import { copy, remote, request, shellQuote } from './transport.ts'
import { sshAddress, sshPasswordRef } from './ssh-account.ts'
import { installGoalUnattended } from './unattended.ts'
import type { ExperimentDispatchEntry, ExperimentDispatchRecord, ExperimentPasswordStatus, ExperimentSshAccount } from './types.ts'
export type { ExperimentDispatchEntry, ExperimentDispatchRecord, ExperimentPasswordStatus, ExperimentSshAccount } from './types.ts'

export const name = 'experiment-dispatch'
export const inject = ['agents', 'credentials', 'goals', 'tools', 'storageDomain', 'systemPrompt']

/** Fixed deployment target and bounded setup operations. */
export interface Config {
  /** Known-hosts-verified OpenSSH destination for the GPU target. */
  readonly host?: string
  /** Remote SSH listener port. */
  readonly sshPort?: number
  /** SSH login name; may also be supplied by a legacy user@host destination. */
  readonly username?: string
  /** Exactly one authentication method; existing configurations use keys. */
  readonly authMode?: 'key' | 'password'
  /** Optional password reference; by default each server, port and username has its own credential. */
  readonly passwordRef?: string
  /** OpenSSH known_hosts file; defaults to the DSH host user's ~/.ssh/known_hosts. */
  readonly knownHostsFile?: string
  /** Loopback HTTP receiver port reached through an SSH tunnel. */
  readonly remotePort?: number
  /** Absolute private deployment directory on the target. */
  readonly remoteRoot?: string
  /** Absolute local checkout whose current source is deployed. */
  readonly localRepo?: string
  /** Optional OpenSSH private identity file for non-interactive login. */
  readonly identityFile?: string
  /** Local directories from which dataset files may be transferred. */
  readonly dataRoots?: string[]
  /** System packages permitted for extraction into the private tools directory. */
  readonly allowedSystemPackages?: string[]
  /** Credential reference for the receiver Bearer token. */
  readonly tokenRef?: string
  /** Credential references copied into the remote worker's private model store. */
  readonly agentCredentialRefs?: string[]
  /** Preparation/submission tool deadline and process timeout for archives, SSH and SCP, in milliseconds. */
  readonly toolTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  host: z.string(),
  sshPort: z.number().step(1).min(1).max(65535).default(22),
  username: z.string(),
  authMode: z.union(['key', 'password']).default('key'),
  passwordRef: z.string(),
  knownHostsFile: z.string(),
  remotePort: z.number().step(1).min(1).max(65535).default(43019),
  remoteRoot: z.string(),
  localRepo: z.string().default(''),
  identityFile: z.string(),
  dataRoots: z.array(z.string()).default([]),
  allowedSystemPackages: z.array(z.string()).default(['bubblewrap']),
  tokenRef: z.string().default('DSH_EXPERIMENT_TOKEN'),
  agentCredentialRefs: z.array(z.string()).default(['DEEPSEEK_API_KEY']),
  toolTimeoutMs: z.number().step(1).min(60_000).default(1_800_000),
})

const pinnedTargetSchema = zod.object({
  host: zod.string(), sshPort: zod.number().int(), remotePort: zod.number().int(),
  username: zod.string().optional(), authMode: zod.enum(['key', 'password']).optional(),
  passwordRef: zod.string().optional(), knownHostsFile: zod.string().optional(),
  remoteRoot: zod.string(), localRepo: zod.string(), identityFile: zod.string().optional(),
  dataRoots: zod.array(zod.string()), allowedSystemPackages: zod.array(zod.string()),
  tokenRef: zod.string(), agentCredentialRefs: zod.array(zod.string()), toolTimeoutMs: zod.number().int(),
})
type PinnedTarget = zod.infer<typeof pinnedTargetSchema>
const preparationSchema = zod.object({
  state: zod.literal('ready'),
  deploymentId: zod.string(), preparationId: zod.string(), backend: zod.literal('bwrap'),
  backendPath: zod.string(),
  sandboxWriteProbe: zod.literal('passed'), cudaProbe: zod.literal('passed'),
  devicePaths: zod.array(zod.string()), hiddenPaths: zod.array(zod.string()), workspaceRoot: zod.string(),
  createdAt: zod.number().int(), target: pinnedTargetSchema.optional(),
})
const preparationFailureSchema = zod.object({
  state: zod.literal('failed'), preparationId: zod.string(),
  deploymentId: zod.string().optional(), detail: zod.string(), createdAt: zod.number().int(),
})
type PreparationFailure = zod.infer<typeof preparationFailureSchema>
const HANDOVER = '本机派发完成，远端实验已接管' as const
const localSubmissionSchema = zod.object({
  submissionId: zod.string(), preparationId: zod.string(),
  specHash: zod.string(), spec: experimentSpecSchema,
  sessionId: zod.string().optional(), goalId: zod.string().optional(), goalRevision: zod.number().int().positive().optional(),
  target: pinnedTargetSchema.optional(),
  handover: zod.literal(HANDOVER).optional(),
  receipt: experimentRecordSchema.optional(), latest: experimentRecordSchema.optional(),
})
type LocalSubmission = zod.infer<typeof localSubmissionSchema>
const storeSpec = defineDomain({
  name: 'experiment_dispatch', version: 4, compatibleVersions: [1, 2, 3], layout: 'per-record',
  tables: {
    preparations: domainTable<string, zod.infer<typeof preparationSchema>>(preparationSchema),
    preparation_failures: domainTable<string, PreparationFailure>(preparationFailureSchema),
    submissions: domainTable<string, LocalSubmission>(localSubmissionSchema),
  },
})
type Store = Domain<typeof storeSpec>

function validateConfig(config: Config): DeploymentConfig {
  const localRepo = config.localRepo === undefined || config.localRepo === '' ? process.cwd() : config.localRepo
  const sshPort = config.sshPort ?? 22
  const remotePort = config.remotePort ?? 43019
  const tokenRef = config.tokenRef ?? 'DSH_EXPERIMENT_TOKEN'
  if (config.host === undefined || config.host === '' || config.remoteRoot === undefined || config.remoteRoot === '') {
    throw new Error('experiment dispatch is not configured: set the GPU target host and remote root')
  }
  const address = sshAddress(config.host, config.username)
  if (!/^\/[a-zA-Z0-9_./-]+$/.test(config.remoteRoot)
    || config.remoteRoot.split('/').includes('..')
    || !isAbsolute(localRepo)
    || !Number.isSafeInteger(sshPort) || sshPort < 1 || sshPort > 65535
    || !Number.isSafeInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new Error('experiment-dispatch requires a safe SSH target, absolute remote root, and valid ports')
  }
  for (const path of config.dataRoots ?? []) {
    if (!isAbsolute(path) || !existsSync(path) || !lstatSync(path).isDirectory()) {
      throw new Error('experiment-dispatch dataRoots must be existing absolute directories')
    }
  }
  if ((config.allowedSystemPackages ?? []).some(name => name !== 'bubblewrap')) {
    throw new Error('experiment-dispatch only supports bubblewrap in allowedSystemPackages')
  }
  credentialRef(tokenRef)
  const passwordRef = config.passwordRef
  if (config.authMode === 'password') sshPasswordRef({ ...address, username: address.username ?? '', sshPort, passwordRef })
  if (passwordRef !== undefined) credentialRef(passwordRef)
  for (const ref of config.agentCredentialRefs ?? []) credentialRef(ref)
  return {
    ...address,
    sshPort,
    ...(config.authMode === undefined ? {} : { authMode: config.authMode }),
    ...(passwordRef === undefined ? {} : { passwordRef }),
    ...(config.knownHostsFile === undefined ? {} : { knownHostsFile: config.knownHostsFile }),
    remotePort,
    remoteRoot: config.remoteRoot,
    localRepo,
    ...(config.identityFile === undefined ? {} : { identityFile: config.identityFile }),
    tokenRef,
    dataRoots: config.dataRoots ?? [],
    allowedSystemPackages: config.allowedSystemPackages ?? ['bubblewrap'],
    agentCredentialRefs: config.agentCredentialRefs ?? ['DEEPSEEK_API_KEY'],
    toolTimeoutMs: config.toolTimeoutMs ?? 1_800_000,
  }
}

function pinTarget(config: DeploymentConfig): PinnedTarget {
  return {
    host: config.host, sshPort: config.sshPort, remotePort: config.remotePort, remoteRoot: config.remoteRoot,
    ...(config.username === undefined ? {} : { username: config.username }),
    ...(config.authMode === undefined ? {} : { authMode: config.authMode }),
    ...(config.passwordRef === undefined ? {} : { passwordRef: config.passwordRef }),
    ...(config.knownHostsFile === undefined ? {} : { knownHostsFile: config.knownHostsFile }),
    localRepo: config.localRepo, allowedSystemPackages: [...config.allowedSystemPackages],
    ...(config.identityFile === undefined ? {} : { identityFile: config.identityFile }),
    dataRoots: [...config.dataRoots], tokenRef: config.tokenRef,
    agentCredentialRefs: [...config.agentCredentialRefs], toolTimeoutMs: config.toolTimeoutMs,
  }
}

function caller(ctx: Context, exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined || ctx.agents.get(agent.id) !== agent
    || ctx.agents.currentInitiator() !== agent || !ctx.agents.roots().includes(agent)) {
    throw new Error('experiment dispatch requires the active root agent')
  }
  return agent
}

/** Trusted local dispatcher; one submission belongs to one exact local Goal revision. */
export class ExperimentDispatcher {
  private chain: Promise<void> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    private readonly config: DeploymentConfig | undefined,
    private readonly store: Store,
    private readonly settings: () => Partial<Config> | undefined = () => undefined,
  ) {}

  private target(): DeploymentConfig {
    const saved = this.settings()
    const { identityFile, username, authMode, passwordRef, knownHostsFile, ...base } = { ...this.config, ...saved }
    return validateConfig({
      ...base,
      ...identityFile === undefined ? {} : { identityFile },
      ...username === undefined ? {} : { username },
      ...authMode === undefined ? {} : { authMode },
      ...passwordRef === undefined ? {} : { passwordRef },
      ...knownHostsFile === undefined ? {} : { knownHostsFile },
      dataRoots: [...(saved?.dataRoots ?? this.config?.dataRoots ?? [])],
      allowedSystemPackages: [...(saved?.allowedSystemPackages ?? this.config?.allowedSystemPackages ?? ['bubblewrap'])],
      agentCredentialRefs: [...(saved?.agentCredentialRefs ?? this.config?.agentCredentialRefs ?? ['DEEPSEEK_API_KEY'])],
    })
  }

  /** Find an owned submission and refuse records that predate target pinning. */
  private submissionFor(submissionId: string): { key: string; record: LocalSubmission & { target: PinnedTarget } } {
    for (const [key, record] of this.store.table('submissions').entries()) {
      if (record.submissionId !== submissionId) continue
      if (record.target === undefined) throw new Error('legacy submission has no pinned target; it cannot be contacted safely')
      return { key, record: { ...record, target: record.target } }
    }
    throw new Error('unknown local submission id')
  }

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job)
    this.chain = result.then(() => {}, () => {})
    return result
  }

  private async token(target: DeploymentConfig): Promise<string> {
    const credential = await this.ctx.credentials.resolve(credentialRef(target.tokenRef))
    if (credential === undefined) throw new Error(`credential ${target.tokenRef} is not configured`)
    return credential.value
  }

  private async password(target: DeploymentConfig): Promise<string | undefined> {
    if (target.authMode !== 'password') return undefined
    const ref = sshPasswordRef({ host: target.host, username: target.username ?? '', sshPort: target.sshPort, passwordRef: target.passwordRef })
    const credential = await this.ctx.credentials.resolve(ref)
    if (credential === undefined) throw new Error('SSH password is not configured for this server and username; save it in GPU experiment settings')
    return credential.value
  }

  private async modelCredentials(target: DeploymentConfig): Promise<Record<string, string>> {
    const values = Object.create(null) as Record<string, string>
    for (const name of target.agentCredentialRefs) {
      const credential = await this.ctx.credentials.resolve(credentialRef(name))
      if (credential === undefined) throw new Error(`agent model credential ${name} is not configured`)
      values[name] = credential.value
    }
    return values
  }

  /**
   * Build, probe, and activate an immutable worker release.
   * @param signal - aborts bounded setup operations.
   * @returns a ready report or a durable failure report.
   */
  async prepare(signal?: AbortSignal): Promise<PreparedEnvironment | PreparationFailure> {
    return this.serialize(() => this.prepareOnce(signal))
  }

  private async prepareOnce(signal?: AbortSignal): Promise<PreparedEnvironment | PreparationFailure> {
    let snapshot: SourceSnapshot | undefined
    try {
      const target = this.target()
      const password = await this.password(target)
      snapshot = await snapshotSource(target.localRepo, target.toolTimeoutMs, signal)
      const preparationId = createHash('sha256').update(snapshot.digest + '\0' + JSON.stringify(pinTarget(target))).digest('hex')
      const token = await this.token(target)
      const previous = this.store.table('preparations').get(preparationId)
      if (previous !== undefined) {
        try {
          const health = await request(target, token, '/experiment/v1/health', 'GET', undefined, signal, password)
          const body = experimentHealthSchema.safeParse(health.value)
          if (health.status === 200 && body.success && body.data.deploymentId === snapshot.digest) {
            return previous
          }
        } catch (error: unknown) {
          signal?.throwIfAborted()
          this.ctx.logger.warn(`experiment-dispatch: cached receiver health failed; rerunning deployment probes: ${String(error)}`)
        }
      }
      const prepared = { ...await deploy(target, snapshot, token, await this.modelCredentials(target), signal, password), preparationId }
      await this.store.table('preparations').put(prepared.preparationId, {
        ...prepared, devicePaths: [...prepared.devicePaths], hiddenPaths: [...prepared.hiddenPaths], createdAt: Date.now(),
        target: pinTarget(target),
      })
      return prepared
    } catch (error: unknown) {
      const failure: PreparationFailure = {
        state: 'failed', preparationId: randomUUID(),
        ...snapshot === undefined ? {} : { deploymentId: snapshot.digest },
        detail: error instanceof Error ? error.message : String(error), createdAt: Date.now(),
      }
      await this.store.table('preparation_failures').put(failure.preparationId, failure)
      return failure
    } finally {
      snapshot?.dispose()
    }
  }

  private async datasetRefs(
    targetConfig: DeploymentConfig, refs: readonly string[], signal?: AbortSignal, password?: string,
  ): Promise<string[]> {
    const staged: string[] = []
    const workspace = `${targetConfig.remoteRoot}/workspace`
    for (const ref of refs) {
      const local = isAbsolute(ref) ? ref : resolve(targetConfig.localRepo, ref)
      if (existsSync(local)) {
        const path = realpathSync(local)
        if (!targetConfig.dataRoots.some(root => path.startsWith(realpathSync(root) + sep)) || !lstatSync(path).isFile()) {
          throw new Error(`dataset is outside configured local data roots or is not a file: ${ref}`)
        }
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
        const digest = hash.digest('hex')
        const name = basename(path).replaceAll(/[^a-zA-Z0-9._-]/g, '_')
        const target = `${workspace}/inputs/${digest}-${name}`
        const incoming = `${target}.partial-${randomUUID()}`
        await remote(targetConfig, `umask 077; mkdir -p ${shellQuote(workspace + '/inputs')}`, signal, password)
        try {
          await copy(targetConfig, path, incoming, signal, password)
          await remote(targetConfig, `set -eu; test "$(sha256sum ${shellQuote(incoming)} | cut -d ' ' -f 1)" = ${shellQuote(digest)}; if [ -e ${shellQuote(target)} ]; then test "$(sha256sum ${shellQuote(target)} | cut -d ' ' -f 1)" = ${shellQuote(digest)}; rm -- ${shellQuote(incoming)}; else mv -- ${shellQuote(incoming)} ${shellQuote(target)}; fi`, signal, password)
        } catch (error: unknown) {
          await remote(targetConfig, `rm -f -- ${shellQuote(incoming)}`, signal, password).catch((cleanupError: unknown) => {
            this.ctx.logger.warn(`experiment-dispatch: partial dataset cleanup failed: ${String(cleanupError)}`)
          })
          throw error
        }
        staged.push(`inputs/${digest}-${name}`)
      } else {
        if (isAbsolute(ref) || ref.split(/[\\/]/).includes('..') || ref.startsWith('/') || ref === '') {
          throw new Error(`dataset reference is unavailable or escapes the remote workspace: ${ref}`)
        }
        staged.push(ref.replaceAll('\\', '/'))
      }
    }
    return staged
  }

  /**
   * Persist the retry identity before transport and return the remote receipt.
   * @param sessionId - local root Agent Session id.
   * @param goal - exact Goal revision whose requirements are being submitted.
   * @param preparationId - successful preparation id.
   * @param input - explicit experiment requirements.
   * @param signal - stops transport and automatic retries while retaining the retry identity; remote acceptance may already have occurred.
   * @returns the receiver's durable acceptance record.
   */
  async submit(sessionId: string, goal: GoalRef, preparationId: string, input: Omit<ExperimentSpec, 'outputPath'>, signal?: AbortSignal): Promise<ExperimentRecord> {
    return this.serialize(() => this.submitOnce(sessionId, goal, preparationId, input, signal))
  }

  private async submitOnce(sessionId: string, goal: GoalRef, preparationId: string, input: Omit<ExperimentSpec, 'outputPath'>, signal?: AbortSignal): Promise<ExperimentRecord> {
    signal?.throwIfAborted()
    const preparation = this.store.table('preparations').get(preparationId)
    if (preparation === undefined) throw new Error('unknown preparation; run prepare_experiment_environment first')
    if (preparation.target === undefined) throw new Error('legacy preparation has no pinned target; prepare again before submitting')
    const target = preparation.target
    const password = await this.password(target)
    const token = await this.token(target)
    const healthy = await request(target, token, '/experiment/v1/health', 'GET', undefined, signal, password)
    const health = experimentHealthSchema.safeParse(healthy.value)
    if (healthy.status !== 200 || !health.success || health.data.deploymentId !== preparation.deploymentId) {
      throw new Error('prepared worker did not return valid health for the expected version')
    }
    const submissions = this.store.table('submissions')
    const key = createHash('sha256').update(goal.id + '\0' + String(goal.revision)).digest('hex')
    const keyed = submissions.get(key)
    const legacy = submissions.get(goal.id)
    const legacyMatches = legacy?.goalId === goal.id && legacy.goalRevision === goal.revision
    const saveKey = keyed !== undefined ? key : legacyMatches ? goal.id : key
    const previous = keyed ?? (legacyMatches ? legacy : undefined)
    const requestedHash = createHash('sha256').update(JSON.stringify({ ...input, datasetRefs: input.datasetRefs })).digest('hex')
    if (previous !== undefined && (previous.sessionId !== sessionId || previous.goalId !== goal.id
      || previous.goalRevision !== goal.revision || previous.specHash !== requestedHash
      || previous.preparationId !== preparationId || JSON.stringify(previous.target) !== JSON.stringify(target))) {
      throw new Error('this local Goal revision already submitted different experiment requirements or target')
    }
    const refs = previous?.spec.datasetRefs ?? await this.datasetRefs(target, input.datasetRefs, signal, password)
    const requested = { ...input, datasetRefs: refs }
    const submissionId = previous?.submissionId ?? createHash('sha256')
      .update(goal.id + '\0' + String(goal.revision) + '\0' + preparationId).digest('hex')
    const spec = experimentSpecSchema.parse({
      ...requested, outputPath: `artifacts/${submissionId}`,
    })
    if (previous === undefined) {
      await submissions.put(saveKey, {
        submissionId, preparationId, specHash: requestedHash, spec, sessionId, goalId: goal.id,
        goalRevision: goal.revision, target,
      })
    }
    const submission: ExperimentSubmission = { submissionId, deploymentId: preparation.deploymentId, spec: previous?.spec ?? spec }
    let response
    try {
      signal?.throwIfAborted()
      response = await request(target, token, '/experiment/v1/submit', 'POST', submission, signal, password)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (error instanceof Error && error.name === 'AbortError') throw error
      // The response may have been lost after acceptance. Replay the exact id.
      response = await request(target, token, '/experiment/v1/submit', 'POST', submission, signal, password)
    }
    const record = experimentRecordSchema.parse(response.value)
    if (response.status !== 200 || record.goalId === undefined || record.submissionId !== submissionId
      || record.deploymentId !== preparation.deploymentId || record.payloadHash !== submissionHash(submission)) {
      throw new Error(`remote experiment was not accepted: ${record.detail ?? record.state}`)
    }
    const saved = submissions.get(saveKey)
    if (saved === undefined) throw new Error('local submission record disappeared before the receipt was saved')
    await submissions.put(saveKey, { ...saved, handover: HANDOVER, receipt: record, latest: record })
    this.finishLocalGoal(sessionId, goal)
    return record
  }

  /** Complete the original Goal only while it is still the agent's current Goal. */
  private finishLocalGoal(sessionId: string, goal: GoalRef): void {
    if (this.ctx.get('agents') === undefined || this.ctx.get('goals') === undefined) return
    const agent = this.ctx.agents.get(sessionId as never)
    if (agent === undefined) return
    const current = this.ctx.goals.get(agent)
    if (current === undefined || current.id !== goal.id || current.revision !== goal.revision
      || current.phase === 'complete') return
    this.ctx.goals.complete(agent, goal)
  }

  /**
   * Return saved local submissions with the full handover and latest observed records.
   * @returns Locally saved experiments for Web status and control.
   */
  list(): ExperimentDispatchEntry[] {
    return [...this.store.table('submissions').entries()].map(([, record]) => ({
      submissionId: record.submissionId,
      ...record.sessionId === undefined ? {} : { sessionId: record.sessionId },
      ...record.goalId === undefined ? {} : { goalId: record.goalId },
      ...record.goalRevision === undefined ? {} : { goalRevision: record.goalRevision },
      ...record.target === undefined ? {} : { host: record.target.host },
      ...record.handover === undefined ? {} : { handover: record.handover },
      ...record.receipt === undefined ? {} : { receipt: record.receipt },
      ...record.latest === undefined ? {} : { latest: record.latest },
    }))
  }

  /**
   * Query the remote record without relying on the local Agent lifetime.
   * @param submissionId - receiver submission id.
   * @param signal - aborts the query.
   * @returns the receiver's current durable record.
   */
  async status(submissionId: string, signal?: AbortSignal): Promise<ExperimentRecord> {
    const { key, record: submission } = this.submissionFor(submissionId)
    const response = await request(submission.target, await this.token(submission.target), `/experiment/v1/status/${encodeURIComponent(submissionId)}`, 'GET', undefined, signal, await this.password(submission.target))
    if (response.status !== 200) throw new Error('experiment record was not found on the remote worker')
    const record = experimentRecordSchema.parse(response.value)
    if (record.submissionId !== submissionId) throw new Error('remote worker returned another submission')
    await this.store.table('submissions').put(key, { ...submission, latest: record })
    return record
  }

  /**
   * Cancel an owned remote experiment; the receiver awaits Agent teardown.
   * @param submissionId - receiver submission id.
   * @param signal - aborts the control request.
   * @returns the receiver's terminal cancellation record.
   */
  async cancel(submissionId: string, signal?: AbortSignal): Promise<ExperimentRecord> {
    const { key, record: submission } = this.submissionFor(submissionId)
    const response = await request(submission.target, await this.token(submission.target), `/experiment/v1/cancel/${encodeURIComponent(submissionId)}`, 'POST', {}, signal, await this.password(submission.target))
    if (response.status !== 200) throw new Error('experiment record was not found on the remote worker')
    const record = experimentRecordSchema.parse(response.value)
    if (record.submissionId !== submissionId) throw new Error('remote worker returned another submission')
    await this.store.table('submissions').put(key, { ...submission, latest: record })
    return record
  }
}

/** Trusted browser controls over locally saved experiment identities. */
export class ExperimentDispatchRemote extends TypertRemoteService {
  constructor(ctx: Context, private readonly dispatcher: ExperimentDispatcher) {
    super(ctx, 'experimentDispatch')
  }

  /**
   * Describe the password selected by an SSH account without returning its value.
   * @param account - target server and login name from the configuration form.
   * @returns password presence and writability.
   */
  @Remote('passwordStatus')
  async passwordStatus(account: ExperimentSshAccount): Promise<ExperimentPasswordStatus> {
    const info = await this.ctx.credentials.describe(sshPasswordRef(account))
    return { configured: info.configured, writable: info.writable }
  }

  /**
   * Store a password separately from settings and Session events.
   * @param account - target server and login name from the configuration form.
   * @param value - exact password, including whitespace.
   */
  @Remote('setPassword')
  async setPassword(account: ExperimentSshAccount, value: string): Promise<void> {
    if (value === '') throw new Error('SSH password must not be empty')
    await this.ctx.credentials.set(sshPasswordRef(account), value)
  }

  /**
   * List locally saved experiments.
   * @returns Saved experiments and their latest receiver records.
   */
  @Remote('list')
  list(): ExperimentDispatchEntry[] {
    return this.dispatcher.list()
  }

  /**
   * Refresh the durable receiver record.
   * @param submissionId - locally saved submission identity.
   * @param signal - cancels the status query.
   * @returns the current receiver record, saved locally before returning.
   */
  @Remote('refresh')
  refresh(submissionId: string, signal: AbortSignal): Promise<ExperimentDispatchRecord> {
    return this.dispatcher.status(submissionId, signal)
  }

  /**
   * Cancel a locally saved remote experiment.
   * @param submissionId - locally saved submission identity.
   * @param signal - cancels the control request.
   * @returns the receiver's durable cancellation record, saved locally before returning.
   */
  @Remote('cancel')
  cancel(submissionId: string, signal: AbortSignal): Promise<ExperimentDispatchRecord> {
    return this.dispatcher.cancel(submissionId, signal)
  }
}

const output = {
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
} as const

type ToolJson = null | boolean | number | string | ToolJson[] | { [key: string]: ToolJson }

function toolJson(value: object): { [key: string]: ToolJson } {
  return JSON.parse(JSON.stringify(value)) as { [key: string]: ToolJson }
}

/** Mount the four local tools and their shared unattended dispatch guidance. */
export async function apply(ctx: Context, input: Config): Promise<void> {
  installGoalUnattended(ctx)
  let source: () => Config = () => input
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.installSection(ctx, 'experiment-dispatch', Config, input, {
      setSource: (current) => { source = current },
      onChange: () => {},
    })
  })
  const config = input.host === undefined || input.host === '' || input.remoteRoot === undefined || input.remoteRoot === ''
    ? undefined
    : validateConfig(input)
  const store = await ctx.storageDomain.open(storeSpec)
  const dispatcher = new ExperimentDispatcher(ctx, config, store, () => source())
  new ExperimentDispatchRemote(ctx, dispatcher)
  const toolTimeoutMs = input.toolTimeoutMs ?? 1_800_000
  ctx.effect(() => () => store.close(), 'experiment-dispatch: local records')
  ctx.systemPrompt.section({
    name: 'experiment:dispatch', order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: 'For a requested remote training experiment, prepare the environment, then submit explicit requirements only when preparation returns state ready. '
      + 'Preserve the user\'s chosen model, data, method and constraints. Choose missing details within authorized resources and record them. '
      + 'After submit returns accepted, the remote Goal owns execution; include the handover field verbatim when reporting its identifiers and status lookup. '
      + 'Never wait for a human response or claim the training finished from the acceptance receipt.',
  })
  ctx.tools.register(defineTool({
    name: 'prepare_experiment_environment',
    description: 'Deploy this DSH source to the configured GPU target and verify real sandbox and CUDA access before submission.',
    parameters: {}, output, timeoutMs: toolTimeoutMs,
    execute: async (_args, exec) => { caller(ctx, exec); return toolJson(await dispatcher.prepare(exec.signal)) },
  }))
  ctx.tools.register(defineTool({
    name: 'submit_experiment',
    description: 'Submit one experiment to the prepared worker. The returned accepted receipt means the remote DSH owns the run independently.',
    parameters: {
      preparation_id: { type: 'string', required: true },
      objective: { type: 'string', required: true },
      agent_model_provider: { type: 'string' }, agent_model_id: { type: 'string' },
      training_model: { type: 'string' }, training_method: { type: 'string' },
      required_gpus: { type: 'number' },
      dataset_refs: { type: 'array', items: { type: 'string' } },
      constraints: { type: 'array', items: { type: 'string' } },
    }, output, timeoutMs: toolTimeoutMs,
    execute: async (args, exec) => {
      const agent = caller(ctx, exec)
      const goal = ctx.goals.get(agent)
      if (goal === undefined || goal.phase === 'complete') {
        throw new Error('experiment dispatch requires an active local Goal')
      }
      if ((args.agent_model_provider === undefined) !== (args.agent_model_id === undefined)) {
        throw new Error('agent model provider and id must be supplied together')
      }
      const record = await dispatcher.submit(agent.id, { id: goal.id, revision: goal.revision }, args.preparation_id, {
        objective: args.objective,
        ...args.agent_model_provider === undefined ? {} : {
          agentModel: { provider: args.agent_model_provider, model: args.agent_model_id as string },
        },
        ...args.training_model === undefined ? {} : { trainingModel: args.training_model },
        ...args.training_method === undefined ? {} : { trainingMethod: args.training_method },
        ...args.required_gpus === undefined ? {} : { requiredGpus: args.required_gpus },
        datasetRefs: args.dataset_refs ?? [], constraints: args.constraints ?? [],
      }, exec.signal)
      return toolJson({ ...record, handover: HANDOVER })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'get_experiment_status', description: 'Read the durable remote status of a submitted experiment.',
    parameters: { submission_id: { type: 'string', required: true } }, output,
    execute: async (args, exec) => { caller(ctx, exec); return toolJson(await dispatcher.status(args.submission_id, exec.signal)) },
  }))
  ctx.tools.register(defineTool({
    name: 'cancel_experiment', description: 'Cancel a remote experiment and wait for its owned Agent and children to stop.',
    parameters: { submission_id: { type: 'string', required: true } }, output,
    execute: async (args, exec) => { caller(ctx, exec); return toolJson(await dispatcher.cancel(args.submission_id, exec.signal)) },
  }))
}
