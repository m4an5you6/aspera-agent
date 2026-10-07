import type { ServerConnectionCheck, ExperimentDeletionPreview, ExperimentDeletion, DeleteExperimentsRequest, ServerDeletionPreview } from './types.ts'
/** Aspera's DSH adapter: public Remote methods and effect-owned dispatch tools. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { ExperimentId } from '@aspera/experiments'
import { experimentIdSchema, serverIdSchema, experimentModelsSchema } from '@aspera/experiments'
import type { ClusterChunk, ClusterFile, ServerSettings, AnswerExperimentQuestion, ServiceAccessInfo, ExperimentModels, ExperimentModelDirectory } from '@aspera/experiments/types'
import { experimentModelDirectory, validateExperimentModels } from './models.ts'
import type { AgentRecordRequest, AgentRecordPage, ExperimentProcess, ProcessLogRequest, ProcessLogPage } from '@aspera/experiments/types'
import type { ObservationSource, ObservationRead, ObservationPage, MetricRead, MetricSample } from '@aspera/experiments/types'
import { ExperimentFleet } from './fleet.ts'
import { installationPolicySchema } from './installation-model.ts'
import { claimErrorNotice, type ErrorNoticeScope } from './error-notices.ts'
import { ExperimentDownloads } from './downloads.ts'
import { sshPasswordRef } from './ssh-account.ts'
import type { ExperimentPasswordStatus, ExperimentSshAccount, FleetCreateRequest, FleetExperiment, FleetRegistry, FleetServerInput, FleetSnapshot } from './types.ts'
export type * from './types.ts'

/** Host policy; the profile owns directories and operation limits. */
export interface Config {
  extensionRoot: string
  dataRoots: string[]
  preparationOutputChars: number
  agentCredentialRefs: string[]
  toolTimeoutMs: number
  connectionCheckTimeoutMs: number
  pollIntervalMs: number
  downloadTtlMs: number
  minimumFreeBytes: number
  installationTotalTimeoutMs: number
  installationIdleTimeoutMs: number
  installationMaxRetries: number
}
/** Validated Host policy supplied by the independent profile. */
export const Config: z<Config> = z.object({
  extensionRoot: z.string().required(), dataRoots: z.array(z.string()).default([]),
  preparationOutputChars: z.number().step(1).min(1024).max(2_000_000).default(65536),
  agentCredentialRefs: z.array(z.string()).default(['DEEPSEEK_API_KEY']),
  toolTimeoutMs: z.number().step(1).min(1000).default(300000),
  connectionCheckTimeoutMs: z.number().step(1).min(1000).default(20000),
  pollIntervalMs: z.number().step(1).min(100).default(1000),
  downloadTtlMs: z.number().step(1).min(1000).default(60000),
  minimumFreeBytes: z.number().step(1).min(1).default(1073741824),
  installationTotalTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(1_800_000),
  installationIdleTimeoutMs: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(300_000),
  installationMaxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(2),
})

/** Experiment API shared by the independent page and Agent tool consumers. */
export class AsperaRemote extends TypertRemoteService {
  constructor(private readonly host: Context, private readonly fleet: ExperimentFleet,
    private readonly downloads: ExperimentDownloads, private readonly config: Config) { super(host, 'aspera') }
  /** @returns saved peer servers and connection observations. */
  @Remote
  servers(): FleetRegistry { return this.fleet.servers() }
  /** @param scope - object and normalized operation failure. @returns whether its first notification was claimed. */
  @Remote
  claimErrorNotice(scope: ErrorNoticeScope): Promise<boolean> { return claimErrorNotice(this.host, scope) }
  /** @param server - complete server settings. @returns saved registry. */
  @Remote
  saveServer(server: FleetServerInput): Promise<FleetRegistry> { return this.fleet.saveServer(server) }
  /** @param id - server registration. @param allowLinked - acknowledgement of retained work. @returns saved registry; experiment destinations remain pinned. */
  @Remote
  removeServer(id: string, allowLinked?: boolean): Promise<FleetRegistry> { return this.fleet.removeServer(serverIdSchema.parse(id), allowLinked ?? false) }

  /** @param id - server registration. @returns retained experiments and unconfirmed remote work without connecting. */
  @Remote
  previewServerRemoval(id: string): ServerDeletionPreview { return this.fleet.previewServerRemoval(serverIdSchema.parse(id)) }

  /** @param id - current registration. @returns deleted experiments still awaiting remote release evidence after a bounded read-only check. */
  @Remote
  reconcileRemovedWork(id: string): Promise<ExperimentId[]> { return this.fleet.reconcileRemovedWork(serverIdSchema.parse(id)) }
  /** @param id - configured server. @returns connection, GPU and allocation facts within the configured check deadline. */
  @Remote
  probeServer(id: string): Promise<ServerConnectionCheck> { return this.fleet.probe(serverIdSchema.parse(id)) }
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
    await this.fleet.invalidatePassword(sshPasswordRef(account))
  }
  /** @param id - saved server. @returns its password after an explicit editor reveal. */
  @Remote
  revealServerPassword(id: string): Promise<string> { return this.fleet.revealPassword(serverIdSchema.parse(id)) }
  /** @param ids - selected records. @returns eligibility and owned cleanup locations. */
  @Remote
  previewExperimentDeletion(ids: string[]): ExperimentDeletionPreview[] { return this.fleet.previewDeletion(ids) }
  /** @param request - confirmed batch and cleanup policy. @returns individual durable outcomes. */
  @Remote
  deleteExperiments(request: DeleteExperimentsRequest): Promise<ExperimentDeletion[]> { return this.fleet.deleteExperiments(request) }
  /** @returns complete reconnect state, including removed identities. */
  @Remote
  experimentSnapshot(): FleetSnapshot { return this.fleet.snapshot() }
  /** @returns independent local dispatch records. */
  @Remote
  experiments(): FleetExperiment[] { return this.fleet.list() }
  /** @returns configured Agent models and credential readiness, without secrets. */
  @Remote
  experimentModels(): Promise<ExperimentModelDirectory> { return experimentModelDirectory(this.host) }
  /** @param models - explicit phase choices. @returns choices after provider and credential validation. */
  @Remote
  validateExperimentModels(models: ExperimentModels): Promise<ExperimentModels> { return validateExperimentModels(this.host, models) }
  /** @param request - phase and Session-bound cursor. @returns real events and the next sequence. */
  @Remote
  experimentRecords(request: AgentRecordRequest): Promise<AgentRecordPage> { return this.fleet.records(request) }
  /** @param request - experiment, phase and cursor. @returns complete events; legacy truncated records remain explicitly marked. */
  @Remote
  experimentTrace(request: AgentRecordRequest): Promise<AgentRecordPage> { return this.fleet.records(request, true) }
  /** @param id - experiment. @param phase - saved Session role. @param seq - original event sequence. @returns complete event detail if retained. */
  @Remote
  async experimentTraceEvent(id: string, phase: 'preparation' | 'planning' | 'execution', seq: number): Promise<import('@aspera/experiments/types').AgentRecord | null> {
    const page = await this.fleet.records({ experimentId: id, phase, beforeSeq: seq + 1, limit: 1 }, true)
    return page.records.find(record => record.seq === seq) ?? null
  }
  /** @param id - experiment. @param phase - owning Session role. @param seq - original event sequence. @param attachmentId - recorded attachment.
   * @param offset - byte continuation. @returns bounded verified attachment bytes.
   */
  @Remote
  experimentTraceAttachment(id: string, phase: 'preparation' | 'planning' | 'execution', seq: number, attachmentId: string, offset: number): Promise<{ data: string; mediaType: string; name: string; nextOffset: number; size: number }> {
    return this.fleet.traceAttachment(experimentIdSchema.parse(id), phase, seq, attachmentId, offset)
  }
  /** @param id - experiment. @param serverId - assigned node. @returns durable process directory. */
  @Remote
  experimentProcesses(id: string, serverId: string): Promise<ExperimentProcess[]> { return this.fleet.processes(experimentIdSchema.parse(id), serverIdSchema.parse(serverId)) }
  /** @param request - source-bound stdout or stderr cursor. @returns bounded log bytes and continuation. */
  @Remote
  experimentProcessLog(request: ProcessLogRequest): Promise<ProcessLogPage> { return this.fleet.processLog(request) }
  /** @param id - experiment. @param serverId - pinned node. @returns dynamically registered log sources. */
  @Remote
  experimentLogSources(id: string, serverId: string): Promise<{ sources: ObservationSource[]; legacy: boolean }> { return this.fleet.logSources(experimentIdSchema.parse(id), serverIdSchema.parse(serverId)) }
  /** @param request - source, direction and owned cursor. @returns bounded public output. */
  @Remote
  experimentLog(request: ObservationRead): Promise<ObservationPage> { return this.fleet.logRead(request) }
  /** @param request - measured time range. @returns retained real resource and training observations. */
  @Remote
  experimentMetrics(request: MetricRead): Promise<MetricSample[]> { return this.fleet.metrics(request) }
  /** @param id - owning experiment. @returns exact-plan Agent reports or explicit old-release availability. */
  @Remote
  experimentExecutionProgress(id: string): Promise<import('@aspera/experiments/types').ExecutionProgressRead> { return this.fleet.executionProgress(experimentIdSchema.parse(id)) }
  /** @param request - selected source and stream. @returns a one-use complete-log download URL. */
  @Remote
  downloadExperimentLog(request: ObservationRead): Promise<string> { return this.downloads.issueLog(request) }
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
  /** @param id - interrupted v4 preparation. @returns original record and the new explicit recovery budget. */
  @Remote
  async retryPreparation(id: string): Promise<import('./types.ts').PreparationRetryResult> {
    const record = await this.fleet.retry(experimentIdSchema.parse(id))
    return { record, installations: this.fleet.snapshot().installations.filter(value => value.experimentId === record.request.experimentId) }
  }
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
      const snapshot = this.fleet.snapshot()
      const encoded = JSON.stringify(snapshot)
      if (encoded !== previous) { previous = encoded; yield snapshot }
      try { await delay(this.config.pollIntervalMs, undefined, { signal }) }
      catch (error) { if (!signal.aborted) throw error }
    }
  }
}
export const inject = ['storage', 'storageDomain', 'agents', 'agentLoop', 'goals', 'credentials', 'agentDefaultModel', 'sessionPersistence', 'tools', 'llm', 'settings']
/** Mount the published DSH adapter without changing the Agent loop. @param ctx - Host services. @param config - resolved policy. */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (!isAbsolute(config.extensionRoot) || config.dataRoots.some(path => !isAbsolute(path))) throw new Error('Aspera directories must be absolute')
  const fleet = await ExperimentFleet.open(ctx, (server: ServerSettings) => ({ ...server,
    localRepo: config.extensionRoot, dataRoots: config.dataRoots, preparationOutputChars: config.preparationOutputChars,
    agentCredentialRefs: config.agentCredentialRefs, tokenRef: 'ASPERA_COORDINATOR', toolTimeoutMs: config.toolTimeoutMs,
    controlPollIntervalMs: config.pollIntervalMs, minimumFreeBytes: config.minimumFreeBytes }), config.connectionCheckTimeoutMs,
    undefined, installationPolicySchema.parse(config))
  new AsperaRemote(ctx, fleet, new ExperimentDownloads(ctx, fleet, config.downloadTtlMs), config)
  const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
  const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera experiment', kind: 'other' as const, rawInput: args })
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'list_experiment_servers', description: 'Read configured peer Aspera servers and their latest connection checks. No credentials are returned.', parameters: {}, output, presentCall,
    execute: async () => JSON.stringify(fleet.servers()) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'list_experiment_models', description: 'List configured Agent models, reasoning options and credential readiness. Select a provider and model independently for preparation, planning and execution.', parameters: {}, output, presentCall,
    execute: async () => JSON.stringify(await experimentModelDirectory(ctx)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'dispatch_experiment', description: 'Dispatch one independent experiment to explicitly selected servers. They jointly execute the same Goal. Captures this Goal revision; retries reuse it. Semi mode confirms the plan and pauses for unresolved decisions; automatic mode continues within immutable requirements.',
    parameters: { objective: { type: 'string', required: true }, coordinator_id: { type: 'string', required: true, description: 'Coordinator chosen from server_ids.' }, server_ids: { type: 'array', items: { type: 'string' }, required: true },
      files: { type: 'array', items: { type: 'string' } }, name: { type: 'string', description: 'Short experiment title.' },
      models_json: { type: 'string', required: true, description: 'JSON object with preparation, planning and execution, each containing provider, model and optional reasoningEffort from list_experiment_models.' },
      mode: { type: 'string', enum: ['semi', 'automatic'], required: true } },
    output, presentCall, execute: async (args, execution) => {
      const agent = execution.agent
      const models = experimentModelsSchema.parse(JSON.parse(args.models_json))
      const record = agent === undefined || ctx.goals.get(agent) === undefined ? await fleet.create({ experimentId: randomUUID(), objective: args.objective, serverIds: args.server_ids, coordinatorId: args.coordinator_id, files: args.files ?? [], mode: args.mode === 'semi' ? 'semi' : 'automatic', models, ...(args.name === undefined ? {} : { name: args.name }) })
        : await fleet.createForGoal(agent, args.objective, args.server_ids, args.coordinator_id, args.files ?? [], args.mode === 'semi' ? 'semi' : 'automatic', models, args.name)
      return JSON.stringify(record)
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_experiment', description: 'Refresh a saved Aspera experiment, including its plan, handover, queue blockers and services.', parameters: { experiment_id: { type: 'string', required: true } }, output, presentCall,
    execute: async args => JSON.stringify(await fleet.refresh(experimentIdSchema.parse(args.experiment_id))) })))
}
