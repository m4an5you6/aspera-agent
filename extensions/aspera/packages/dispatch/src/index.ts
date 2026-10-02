/** Aspera's DSH adapter: public Remote methods and effect-owned dispatch tools. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import type { ClusterChunk, ClusterFile, ServerSettings, ServerProbe, AnswerExperimentQuestion, ServiceAccessInfo } from '@aspera/experiments/types'
import { ExperimentFleet } from './fleet.ts'
import { ExperimentDownloads } from './downloads.ts'
import { sshPasswordRef } from './ssh-account.ts'
import type { ExperimentPasswordStatus, ExperimentSshAccount, FleetCreateRequest, FleetExperiment, FleetRegistry, FleetServerInput, FleetSnapshot } from './types.ts'
export type * from './types.ts'

/** Host policy; the profile owns directories and operation limits. */
export interface Config {
  extensionRoot: string
  dataRoots: string[]
  allowedSystemPackages: string[]
  agentCredentialRefs: string[]
  toolTimeoutMs: number
  pollIntervalMs: number
  downloadTtlMs: number
  minimumFreeBytes: number
}
/** Validated Host policy supplied by the independent profile. */
export const Config: z<Config> = z.object({
  extensionRoot: z.string().required(), dataRoots: z.array(z.string()).default([]),
  allowedSystemPackages: z.array(z.string()).default([]),
  agentCredentialRefs: z.array(z.string()).default(['DEEPSEEK_API_KEY']),
  toolTimeoutMs: z.number().step(1).min(1000).default(300000),
  pollIntervalMs: z.number().step(1).min(100).default(1000),
  downloadTtlMs: z.number().step(1).min(1000).default(60000),
  minimumFreeBytes: z.number().step(1).min(1).default(1073741824),
})

/** Experiment API shared by the independent page and Agent tool consumers. */
export class AsperaRemote extends TypertRemoteService {
  constructor(private readonly host: Context, private readonly fleet: ExperimentFleet,
    private readonly downloads: ExperimentDownloads, private readonly config: Config) { super(host, 'aspera') }
  /** @returns saved non-secret servers and fixed coordinator identity. */
  @Remote
  servers(): FleetRegistry { return this.fleet.servers() }
  /** @param server - complete server settings. @returns saved registry. */
  @Remote
  saveServer(server: FleetServerInput): Promise<FleetRegistry> { return this.fleet.saveServer(server) }
  /** @param id - unused non-coordinator server. @returns saved registry. */
  @Remote
  removeServer(id: string): Promise<FleetRegistry> { return this.fleet.removeServer(serverIdSchema.parse(id)) }
  /** @param id - configured server. @returns connection, GPU and allocation facts. */
  @Remote
  probeServer(id: string): Promise<ServerProbe> { return this.fleet.probe(serverIdSchema.parse(id)) }
  /** @param account - configured SSH account. @returns presence and writability, without plaintext. */
  @Remote
  async passwordStatus(account: ExperimentSshAccount): Promise<ExperimentPasswordStatus> {
    const ref = sshPasswordRef(account)
    const info = await this.host.credentials.describe(ref)
    return { configured: info.configured, writable: info.writable }
  }
  /** @param account - SSH account. @param password - write-only secret. @returns durable credential write. */
  @Remote
  async setPassword(account: ExperimentSshAccount, password: string): Promise<void> {
    if (password.length === 0) throw new Error('password is required')
    await this.host.credentials.set(sshPasswordRef(account), password)
  }
  /** @returns independent local dispatch records. */
  @Remote
  experiments(): FleetExperiment[] { return this.fleet.list() }
  /** @param input - immutable Goal, resources and strategy. @returns saved preparation immediately. */
  @Remote
  createExperiment(input: FleetCreateRequest): Promise<FleetExperiment> { return this.fleet.create(input) }
  /** @param id - staging experiment. @param name - declared basename. @param offset - byte position. @param data - bounded base64 bytes. @returns accepted offset. */
  @Remote
  uploadExperimentInput(id: string, name: string, offset: number, data: string): { nextOffset: number } {
    return this.fleet.upload(experimentIdSchema.parse(id), name, offset, data)
  }
  /** @param id - staged experiment. @returns preparation record after committing inputs. */
  @Remote
  commitExperimentInputs(id: string): Promise<FleetExperiment> { return this.fleet.commitInputs(experimentIdSchema.parse(id)) }
  /** @param id - experiment. @returns reconciled remote state. */
  @Remote
  refreshExperiment(id: string): Promise<FleetExperiment> { return this.fleet.refresh(experimentIdSchema.parse(id)) }
  /** @param id - interrupted v3 preparation. @returns resumed preparation with the same identity and directories. */
  @Remote
  retryPreparation(id: string): Promise<FleetExperiment> { return this.fleet.retry(experimentIdSchema.parse(id)) }
  /** @param id - experiment. @param revision - displayed plan revision. @returns queued state. */
  @Remote
  approvePlan(id: string, revision: number): Promise<FleetExperiment> { return this.fleet.approve(experimentIdSchema.parse(id), revision) }
  /** @param id - experiment. @param reply - exact question and decision. @returns persisted reply receipt. */
  @Remote
  answerExperimentQuestion(id: string, reply: AnswerExperimentQuestion): Promise<FleetExperiment> { return this.fleet.answer(experimentIdSchema.parse(id), reply) }
  /** @param id - experiment. @returns durable cancellation state. */
  @Remote
  cancelExperiment(id: string): Promise<FleetExperiment> { return this.fleet.cancel(experimentIdSchema.parse(id)) }
  /** @param id - experiment. @param serverId - assigned server. @returns bounded output metadata. */
  @Remote
  experimentFiles(id: string, serverId: string): Promise<{ files: ClusterFile[]; truncated: boolean }> {
    return this.fleet.files(experimentIdSchema.parse(id), serverIdSchema.parse(serverId))
  }
  /** @param id - experiment. @param kind - source stream. @param offset - byte position. @param serverId - assigned node. @param path - relative file. @param generation - previous stream identity. @returns continuation cursor and bytes. */
  @Remote
  readExperiment(id: string, kind: 'log' | 'file' | 'events' | 'agent-log', offset: number, serverId?: string,
    path?: string, generation?: string): Promise<ClusterChunk> {
    return this.fleet.read(experimentIdSchema.parse(id), kind, offset, serverId === undefined ? undefined : serverIdSchema.parse(serverId), path, generation)
  }
  /** @param id - experiment. @param serverId - assigned node. @param path - relative output. @returns one-use bounded-lifetime download URL. */
  @Remote
  downloadExperimentFile(id: string, serverId: string, path: string): Promise<string> {
    return this.downloads.issue(experimentIdSchema.parse(id), serverIdSchema.parse(serverId), path)
  }
  /** @param id - experiment. @param serviceId - registered service. @returns current experiment after stop intent. */
  @Remote
  stopService(id: string, serviceId: string): Promise<FleetExperiment> { return this.fleet.stopService(experimentIdSchema.parse(id), serviceId) }
  /** @param id - experiment. @param serviceId - registered service. @param path - endpoint path. @param method - HTTP method. @param body - optional JSON. @returns bounded private response. */
  @Remote
  async accessService(id: string, serviceId: string, path: string, method: 'GET' | 'POST', body?: string): Promise<string> {
    return JSON.stringify(await this.fleet.accessService(experimentIdSchema.parse(id), serviceId, path, method, body))
  }
  /** @param id - owning experiment. @param serviceId - public service. @returns service-only credential after an explicit operator action. */
  @Remote
  serviceAccessInfo(id: string, serviceId: string): Promise<ServiceAccessInfo> {
    return this.fleet.serviceAccessInfo(experimentIdSchema.parse(id), serviceId)
  }
  /** @param signal - physical stream lifetime. @returns fresh snapshot followed by durable changes; reconnect starts from current records. */
  @Remote({ mode: 'stream' })
  async *watch(signal: AbortSignal): AsyncIterable<FleetSnapshot> {
    let previous = ''
    while (!signal.aborted) {
      const snapshot = { registry: this.fleet.servers(), experiments: this.fleet.list() }
      const encoded = JSON.stringify(snapshot)
      if (encoded !== previous) { previous = encoded; yield snapshot }
      try { await delay(this.config.pollIntervalMs, undefined, { signal }) }
      catch (error) { if (!signal.aborted) throw error }
    }
  }
}
export const inject = ['storage', 'storageDomain', 'agents', 'goals', 'credentials', 'agentDefaultModel', 'sessionPersistence', 'tools']
/** Mount the published DSH adapter without changing the Agent loop. @param ctx - Host services. @param config - resolved policy. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!isAbsolute(config.extensionRoot) || config.dataRoots.some(path => !isAbsolute(path))) throw new Error('Aspera directories must be absolute')
  const fleet = await ExperimentFleet.open(ctx, (server: ServerSettings) => ({ ...server,
    localRepo: config.extensionRoot, dataRoots: config.dataRoots, allowedSystemPackages: config.allowedSystemPackages,
    agentCredentialRefs: config.agentCredentialRefs, tokenRef: 'ASPERA_COORDINATOR', toolTimeoutMs: config.toolTimeoutMs,
    controlPollIntervalMs: config.pollIntervalMs, minimumFreeBytes: config.minimumFreeBytes }))
  new AsperaRemote(ctx, fleet, new ExperimentDownloads(ctx, fleet, config.downloadTtlMs), config)
  const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
  const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera experiment', kind: 'other' as const, rawInput: args })
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'list_experiment_servers', description: 'Read configured Aspera servers and their fixed coordinator. No credentials are returned.', parameters: {}, output, presentCall,
    execute: async () => JSON.stringify(fleet.servers()) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'dispatch_experiment', description: 'Dispatch one independent experiment to explicitly selected servers. They jointly execute the same Goal. Captures this Goal revision; retries reuse it. Semi mode confirms the plan and pauses for unresolved decisions; automatic mode continues within immutable requirements.',
    parameters: { objective: { type: 'string', required: true }, server_ids: { type: 'array', items: { type: 'string' }, required: true },
      files: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['semi', 'automatic'], required: true } },
    output, presentCall, execute: async (args, execution) => {
      const agent = execution.agent
      const record = agent === undefined || ctx.goals.get(agent) === undefined ? await fleet.create({ experimentId: randomUUID(), objective: args.objective, serverIds: args.server_ids, files: args.files ?? [], mode: args.mode === 'semi' ? 'semi' : 'automatic' })
        : await fleet.createForGoal(agent, args.objective, args.server_ids, args.files ?? [], args.mode === 'semi' ? 'semi' : 'automatic')
      return JSON.stringify(record)
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_experiment', description: 'Refresh a saved Aspera experiment, including its plan, handover, queue blockers and services.', parameters: { experiment_id: { type: 'string', required: true } }, output, presentCall,
    execute: async args => JSON.stringify(await fleet.refresh(experimentIdSchema.parse(args.experiment_id))) })))
}
