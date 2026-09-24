/** Model-facing local preparation and dispatch over an independent DSH worker. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, existsSync, lstatSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { experimentHealthSchema, experimentRecordSchema, experimentSpecSchema } from '@deepseek-ai/dsh-experiment-worker'
import type { ExperimentRecord, ExperimentSpec, ExperimentSubmission } from '@deepseek-ai/dsh-experiment-worker'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { deploy } from './deploy.ts'
import type { DeploymentConfig, PreparedEnvironment } from './deploy.ts'
import { snapshotSource } from './snapshot.ts'
import type { SourceSnapshot } from './snapshot.ts'
import { copy, remote, request, shellQuote } from './transport.ts'

export const name = 'experiment-dispatch'
export const inject = ['agents', 'credentials', 'tools', 'storageDomain', 'systemPrompt']

/** Fixed deployment target and bounded setup operations. */
export interface Config {
  /** Known-hosts-verified OpenSSH destination for the GPU target. */
  readonly host: string
  /** Remote SSH listener port. */
  readonly sshPort: number
  /** Loopback HTTP receiver port reached through an SSH tunnel. */
  readonly remotePort: number
  /** Absolute private deployment directory on the target. */
  readonly remoteRoot: string
  /** Absolute local checkout whose current source is deployed. */
  readonly localRepo: string
  /** Optional OpenSSH private identity file for non-interactive login. */
  readonly identityFile?: string
  /** Local directories from which dataset files may be transferred. */
  readonly dataRoots?: string[]
  /** System packages permitted for extraction into the private tools directory. */
  readonly allowedSystemPackages?: string[]
  /** Credential reference for the receiver Bearer token. */
  readonly tokenRef: string
  /** Credential references copied into the remote worker's private model store. */
  readonly agentCredentialRefs?: string[]
  /** Preparation/submission tool deadline and process timeout for archives, SSH and SCP, in milliseconds. */
  readonly toolTimeoutMs?: number
}

export const Config: z<Config> = z.object({
  host: z.string().required(),
  sshPort: z.number().step(1).min(1).max(65535).required(),
  remotePort: z.number().step(1).min(1).max(65535).required(),
  remoteRoot: z.string().required(),
  localRepo: z.string().required(),
  identityFile: z.string(),
  dataRoots: z.array(z.string()).default([]),
  allowedSystemPackages: z.array(z.string()).default(['bubblewrap']),
  tokenRef: z.string().required(),
  agentCredentialRefs: z.array(z.string()).default(['DEEPSEEK_API_KEY']),
  toolTimeoutMs: z.number().step(1).min(60_000).default(1_800_000),
})

const preparationSchema = zod.object({
  state: zod.literal('ready'),
  deploymentId: zod.string(), preparationId: zod.string(), backend: zod.literal('bwrap'),
  backendPath: zod.string(),
  sandboxWriteProbe: zod.literal('passed'), cudaProbe: zod.literal('passed'),
  devicePaths: zod.array(zod.string()), hiddenPaths: zod.array(zod.string()), workspaceRoot: zod.string(),
  createdAt: zod.number().int(),
})
const preparationFailureSchema = zod.object({
  state: zod.literal('failed'), preparationId: zod.string(),
  deploymentId: zod.string().optional(), detail: zod.string(), createdAt: zod.number().int(),
})
type PreparationFailure = zod.infer<typeof preparationFailureSchema>
const localSubmissionSchema = zod.object({
  submissionId: zod.string(), preparationId: zod.string(),
  specHash: zod.string(), spec: experimentSpecSchema,
})
const storeSpec = defineDomain({
  name: 'experiment_dispatch', version: 1, layout: 'per-record',
  tables: {
    preparations: domainTable<string, zod.infer<typeof preparationSchema>>(preparationSchema),
    preparation_failures: domainTable<string, PreparationFailure>(preparationFailureSchema),
    submissions: domainTable<string, zod.infer<typeof localSubmissionSchema>>(localSubmissionSchema),
  },
})
type Store = Domain<typeof storeSpec>

function validateConfig(config: Config): DeploymentConfig {
  if (!/^[a-zA-Z0-9_.@-]+$/.test(config.host) || config.host.startsWith('-')
    || !/^\/[a-zA-Z0-9_./-]+$/.test(config.remoteRoot)
    || config.remoteRoot.split('/').includes('..')
    || !isAbsolute(config.localRepo)
    || !Number.isSafeInteger(config.sshPort) || config.sshPort < 1 || config.sshPort > 65535
    || !Number.isSafeInteger(config.remotePort) || config.remotePort < 1 || config.remotePort > 65535) {
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
  credentialRef(config.tokenRef)
  for (const ref of config.agentCredentialRefs ?? []) credentialRef(ref)
  return {
    host: config.host,
    sshPort: config.sshPort,
    remotePort: config.remotePort,
    remoteRoot: config.remoteRoot,
    localRepo: config.localRepo,
    ...(config.identityFile === undefined ? {} : { identityFile: config.identityFile }),
    tokenRef: config.tokenRef,
    dataRoots: config.dataRoots ?? [],
    allowedSystemPackages: config.allowedSystemPackages ?? ['bubblewrap'],
    agentCredentialRefs: config.agentCredentialRefs ?? ['DEEPSEEK_API_KEY'],
    toolTimeoutMs: config.toolTimeoutMs ?? 1_800_000,
  }
}

function caller(ctx: Context, exec: ToolRunContext): string {
  const agent = exec.agent
  if (agent === undefined || ctx.agents.get(agent.id) !== agent
    || ctx.agents.currentInitiator() !== agent || !ctx.agents.roots().includes(agent)) {
    throw new Error('experiment dispatch requires the active root agent')
  }
  return agent.id
}

/** Trusted local dispatcher; one submission belongs to one local Session. */
export class ExperimentDispatcher {
  private chain: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: Context, private readonly config: DeploymentConfig, private readonly store: Store) {}

  private serialize<T>(job: () => Promise<T>): Promise<T> {
    const result = this.chain.then(job)
    this.chain = result.then(() => {}, () => {})
    return result
  }

  private async token(): Promise<string> {
    const credential = await this.ctx.credentials.resolve(credentialRef(this.config.tokenRef))
    if (credential === undefined) throw new Error(`credential ${this.config.tokenRef} is not configured`)
    return credential.value
  }

  private async modelCredentials(): Promise<Record<string, string>> {
    const values = Object.create(null) as Record<string, string>
    for (const name of this.config.agentCredentialRefs) {
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
      snapshot = await snapshotSource(this.config.localRepo, this.config.toolTimeoutMs, signal)
      const token = await this.token()
      const previous = this.store.table('preparations').get(snapshot.digest)
      if (previous !== undefined) {
        try {
          const health = await request(this.config, token, '/experiment/v1/health', 'GET', undefined, signal)
          const body = experimentHealthSchema.safeParse(health.value)
          if (health.status === 200 && body.success && body.data.deploymentId === snapshot.digest) {
            return previous
          }
        } catch (error: unknown) {
          signal?.throwIfAborted()
          this.ctx.logger.warn(`experiment-dispatch: cached receiver health failed; rerunning deployment probes: ${String(error)}`)
        }
      }
      const prepared = await deploy(this.config, snapshot, token, await this.modelCredentials(), signal)
      await this.store.table('preparations').put(prepared.preparationId, {
        ...prepared, devicePaths: [...prepared.devicePaths], hiddenPaths: [...prepared.hiddenPaths], createdAt: Date.now(),
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

  private async datasetRefs(refs: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const staged: string[] = []
    const workspace = `${this.config.remoteRoot}/workspace`
    for (const ref of refs) {
      const local = isAbsolute(ref) ? ref : resolve(this.config.localRepo, ref)
      if (existsSync(local)) {
        const path = realpathSync(local)
        if (!this.config.dataRoots.some(root => path.startsWith(realpathSync(root) + sep)) || !lstatSync(path).isFile()) {
          throw new Error(`dataset is outside configured local data roots or is not a file: ${ref}`)
        }
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
        const digest = hash.digest('hex')
        const name = basename(path).replaceAll(/[^a-zA-Z0-9._-]/g, '_')
        const target = `${workspace}/inputs/${digest}-${name}`
        const incoming = `${target}.partial-${randomUUID()}`
        await remote(this.config, `umask 077; mkdir -p ${shellQuote(workspace + '/inputs')}`, signal)
        try {
          await copy(this.config, path, incoming, signal)
          await remote(this.config, `set -eu; test "$(sha256sum ${shellQuote(incoming)} | cut -d ' ' -f 1)" = ${shellQuote(digest)}; if [ -e ${shellQuote(target)} ]; then test "$(sha256sum ${shellQuote(target)} | cut -d ' ' -f 1)" = ${shellQuote(digest)}; rm -- ${shellQuote(incoming)}; else mv -- ${shellQuote(incoming)} ${shellQuote(target)}; fi`, signal)
        } catch (error: unknown) {
          await remote(this.config, `rm -f -- ${shellQuote(incoming)}`, signal).catch((cleanupError: unknown) => {
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
   * @param preparationId - successful preparation id.
   * @param input - explicit experiment requirements.
   * @param signal - stops transport and automatic retries while retaining the retry identity; remote acceptance may already have occurred.
   * @returns the receiver's durable acceptance record.
   */
  async submit(sessionId: string, preparationId: string, input: Omit<ExperimentSpec, 'outputPath'>, signal?: AbortSignal): Promise<ExperimentRecord> {
    return this.serialize(() => this.submitOnce(sessionId, preparationId, input, signal))
  }

  private async submitOnce(sessionId: string, preparationId: string, input: Omit<ExperimentSpec, 'outputPath'>, signal?: AbortSignal): Promise<ExperimentRecord> {
    signal?.throwIfAborted()
    const preparation = this.store.table('preparations').get(preparationId)
    if (preparation === undefined) throw new Error('unknown preparation; run prepare_experiment_environment first')
    const token = await this.token()
    const healthy = await request(this.config, token, '/experiment/v1/health', 'GET', undefined, signal)
    const health = experimentHealthSchema.safeParse(healthy.value)
    if (healthy.status !== 200 || !health.success || health.data.deploymentId !== preparation.deploymentId) {
      throw new Error('prepared worker did not return valid health for the expected version')
    }
    const previous = this.store.table('submissions').get(sessionId)
    const requestedHash = createHash('sha256').update(JSON.stringify({ ...input, datasetRefs: input.datasetRefs })).digest('hex')
    if (previous !== undefined && (previous.specHash !== requestedHash || previous.preparationId !== preparationId)) {
      throw new Error('this local Session already submitted different experiment requirements')
    }
    const refs = previous?.spec.datasetRefs ?? await this.datasetRefs(input.datasetRefs, signal)
    const requested = { ...input, datasetRefs: refs }
    const submissionId = previous?.submissionId ?? createHash('sha256').update(sessionId + '\0' + preparationId).digest('hex')
    const spec = experimentSpecSchema.parse({
      ...requested, outputPath: `artifacts/${submissionId}`,
    })
    if (previous === undefined) {
      await this.store.table('submissions').put(sessionId, { submissionId, preparationId, specHash: requestedHash, spec })
    }
    const submission: ExperimentSubmission = { submissionId, deploymentId: preparation.deploymentId, spec: previous?.spec ?? spec }
    let response
    try {
      signal?.throwIfAborted()
      response = await request(this.config, token, '/experiment/v1/submit', 'POST', submission, signal)
    } catch (error: unknown) {
      signal?.throwIfAborted()
      if (error instanceof Error && error.name === 'AbortError') throw error
      // The response may have been lost after acceptance. Replay the exact id.
      response = await request(this.config, token, '/experiment/v1/submit', 'POST', submission, signal)
    }
    const record = experimentRecordSchema.parse(response.value)
    if (response.status !== 200 || record.goalId === undefined) {
      throw new Error(`remote experiment was not accepted: ${record.detail ?? record.state}`)
    }
    return record
  }

  /**
   * Query the remote record without relying on the local Agent lifetime.
   * @param submissionId - receiver submission id.
   * @param signal - aborts the query.
   * @returns the receiver's current durable record.
   */
  async status(submissionId: string, signal?: AbortSignal): Promise<ExperimentRecord> {
    const response = await request(this.config, await this.token(), `/experiment/v1/status/${encodeURIComponent(submissionId)}`, 'GET', undefined, signal)
    if (response.status !== 200) throw new Error('experiment record was not found on the remote worker')
    return experimentRecordSchema.parse(response.value)
  }

  /**
   * Cancel an owned remote experiment; the receiver awaits Agent teardown.
   * @param submissionId - receiver submission id.
   * @param signal - aborts the control request.
   * @returns the receiver's terminal cancellation record.
   */
  async cancel(submissionId: string, signal?: AbortSignal): Promise<ExperimentRecord> {
    const response = await request(this.config, await this.token(), `/experiment/v1/cancel/${encodeURIComponent(submissionId)}`, 'POST', {}, signal)
    if (response.status !== 200) throw new Error('experiment record was not found on the remote worker')
    return experimentRecordSchema.parse(response.value)
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
  const config = validateConfig(input)
  const store = await ctx.storageDomain.open(storeSpec)
  const dispatcher = new ExperimentDispatcher(ctx, config, store)
  ctx.effect(() => () => store.close(), 'experiment-dispatch: local records')
  ctx.systemPrompt.section({
    name: 'experiment:dispatch', order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: 'For a requested remote training experiment, prepare the environment, then submit explicit requirements only when preparation returns state ready. '
      + 'Preserve the user\'s chosen model, data, method and constraints. Choose missing details within authorized resources and record them. '
      + 'After submit returns accepted, the remote Goal owns execution; complete this local Goal by reporting its identifiers and status lookup. '
      + 'Never wait for a human response or claim the training finished from the acceptance receipt.',
  })
  ctx.tools.register(defineTool({
    name: 'prepare_experiment_environment',
    description: 'Deploy this DSH source to the configured GPU target and verify real sandbox and CUDA access before submission.',
    parameters: {}, output, timeoutMs: config.toolTimeoutMs,
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
    }, output, timeoutMs: config.toolTimeoutMs,
    execute: async (args, exec) => {
      const sessionId = caller(ctx, exec)
      if ((args.agent_model_provider === undefined) !== (args.agent_model_id === undefined)) {
        throw new Error('agent model provider and id must be supplied together')
      }
      return toolJson(await dispatcher.submit(sessionId, args.preparation_id, {
        objective: args.objective,
        ...args.agent_model_provider === undefined ? {} : {
          agentModel: { provider: args.agent_model_provider, model: args.agent_model_id as string },
        },
        ...args.training_model === undefined ? {} : { trainingModel: args.training_model },
        ...args.training_method === undefined ? {} : { trainingMethod: args.training_method },
        ...args.required_gpus === undefined ? {} : { requiredGpus: args.required_gpus },
        datasetRefs: args.dataset_refs ?? [], constraints: args.constraints ?? [],
      }, exec.signal))
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
