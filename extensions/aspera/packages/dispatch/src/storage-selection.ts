/** A preparation Agent chooses observed storage; filesystem mutations remain in the provider. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { serverIdSchema, storageCandidateSchema } from '@aspera/experiments'
import { assessExperimentStorageSchema, inspectExperimentMaterialsSchema, experimentStoragePlanSchema, storageOperationIdSchema } from '@aspera/experiments'
import type { ExperimentStoragePlan } from '@aspera/experiments'
import { z } from 'zod'
import { posix } from 'node:path'
import type { ExperimentId, ExperimentServerId, ServerInventory, ServerSettings, StorageCandidateId, StoragePlacement } from '@aspera/experiments'
import { resolveStoragePlacement } from '@aspera/runtime'

/** Logged evidence supplied to one preparation run. */
export interface StorageSelectionInput {
  server: ServerSettings
  inventory: ServerInventory
}

/** Scoped tools settle only after every automatic server has an accepted choice. */
export class StorageSelection {
  private input: { id: ExperimentId; digest: string; minimumFreeBytes: number; observations: StorageSelectionInput[]; signal: AbortSignal } | undefined
  private readonly placements = new Map<ExperimentServerId, StoragePlacement>()
  private readonly budgets = new Map<StorageCandidateId, ExperimentStoragePlan>()
  private reject: ((error: Error) => void) | undefined
  constructor(private readonly provider?: (observation: StorageSelectionInput, id: ExperimentId, digest: string, operation: string,
    input: object, signal: AbortSignal) => Promise<{ inventory: ServerInventory; history: unknown }>) {}

  private async history(id: ExperimentServerId, operation: string, input: object = {}): Promise<unknown> {
    const selected = this.input
    if (selected === undefined || this.provider === undefined) throw new Error('Program-owned preparation storage provider is unavailable')
    const observation = this.observation(id)
    const value = await this.provider(observation, selected.id, selected.digest, operation, input, selected.signal)
    observation.inventory = value.inventory
    return value.history
  }

  /** Install only observation and selection tools on the preparation Agent.
   * @param ctx - Agent-scoped services. @param agent - exact owner of preparation errors.
   */
  install(ctx: Context, agent: Agent): void {
    ctx.tools.restrict({ allow: [] })
    const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
    const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera storage preparation', kind: 'other' as const, rawInput: args })
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_server_storage',
      description: 'Read the SSH-observed storage candidates for an assigned server. Persistence unknown is not a guarantee of durable cloud storage.',
      parameters: { server_id: { type: 'string', required: true }, cursor: { type: 'string' } }, output, presentCall,
      execute: async args => {
        const id = serverIdSchema.parse(args.server_id)
        const history = this.provider === undefined ? undefined : await this.history(id, 'history-inspect', args.cursor === undefined ? {} : { cursor: args.cursor })
        return JSON.stringify({ inventory: this.observation(id).inventory, ...(history === undefined ? {} : { history }) })
      } })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'assess_experiment_storage',
      description: 'Assess known training needs against one observed candidate before choosing storage. json includes operationId, materialIds, environmentId, requirements, outputBytes and checkpointBytes. Program reads fixed manifests and measures each filesystem; unknown dependency space stays pending.',
      parameters: { server_id: { type: 'string', required: true }, candidate_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output, presentCall,
      execute: async args => {
        const id = serverIdSchema.parse(args.server_id); const observation = this.observation(id)
        const candidate = observation.inventory.candidates.find(row => row.id === args.candidate_id)
        if (candidate === undefined) throw new Error('Storage candidate is not in this server inventory')
        const request = assessExperimentStorageSchema.parse(JSON.parse(args.json))
        const value = await this.history(id, 'history-assess', { request, storageLocation: posix.join(candidate.directory, '.aspera', id, 'runs', this.input!.id, 'workspace') })
        const parsed = experimentStoragePlanSchema.safeParse(value)
        if (parsed.success) this.budgets.set(candidate.id, parsed.data)
        return JSON.stringify(value)
      } })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_experiment_materials',
      description: 'Read canonical fixed-revision model/data file metadata before selecting storage. json: kind, provider, repository, immutable revision, optional files and HTTPS mirror. No model weights are downloaded.',
      parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output, presentCall,
      execute: async args => JSON.stringify(await this.history(serverIdSchema.parse(args.server_id), 'history-material-inspect', { request: inspectExperimentMaterialsSchema.parse(JSON.parse(args.json)) })) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'preview_experiment_cache_cleanup',
      description: 'Preview confirmed exited historical installation residue on this selected server. Environments, model/data files, checkpoints, logs and fixed releases are retained. Unconfirmed ownership or exit cannot authorize cleanup.',
      parameters: { server_id: { type: 'string', required: true } }, output, presentCall,
      execute: async args => JSON.stringify(await this.history(serverIdSchema.parse(args.server_id), 'history-preview')) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'cleanup_experiment_cache',
      description: 'Clean selected historical candidates from the program preview. Pass operation_id, fingerprint and candidate_ids as a JSON array. Repeating an operation reads its receipt; unknown process outcomes require confirmation before another cleanup.',
      parameters: { server_id: { type: 'string', required: true }, operation_id: { type: 'string', required: true }, fingerprint: { type: 'string', required: true }, candidate_ids: { type: 'string', required: true } }, output, presentCall,
      execute: async args => JSON.stringify(await this.history(serverIdSchema.parse(args.server_id), 'history-cleanup', { request: {
        operationId: storageOperationIdSchema.parse(args.operation_id), fingerprint: z.string().regex(/^[a-f0-9]{64}$/).parse(args.fingerprint),
        candidateIds: z.array(z.string()).min(1).max(1024).parse(JSON.parse(args.candidate_ids)) } })) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'select_experiment_storage',
      description: 'Choose one observed writable disk for an assigned server and explain why. Prefer persistent data storage. Automatic system-disk fallback requires a ready per-volume training assessment, not only the deployment minimum; inspect historical reuse and cleanup first when data storage is full. Do not choose ephemeral filesystems. This records paths but does not install or train.',
      parameters: { server_id: { type: 'string', required: true }, candidate_id: { type: 'string', required: true }, reason: { type: 'string', required: true } }, output, presentCall,
      execute: async args => {
        const chosen = this.choose(serverIdSchema.parse(args.server_id), storageCandidateSchema.shape.id.parse(args.candidate_id), args.reason)
        return JSON.stringify(chosen)
      } })))
    ctx.on('agent/error', ({ agent: owner, error }) => { if (owner === agent) this.reject?.(new Error(String(error))) })
  }

  private observation(id: ExperimentServerId): StorageSelectionInput {
    const found = this.input?.observations.find(input => input.server.id === id)
    if (found === undefined) throw new Error('Server is outside this preparation')
    return found
  }

  private choose(id: ExperimentServerId, candidate: StorageCandidateId, reason: string): StoragePlacement {
    const input = this.input
    if (input === undefined) throw new Error('Storage observations are not ready')
    const observation = this.observation(id)
    const selectedCandidate = observation.inventory.candidates.find(value => value.id === candidate)
    if (observation.server.storagePreference?.mode === 'auto' && selectedCandidate?.systemVolume
      && observation.inventory.candidates.some(value => !value.systemVolume && value.persistence !== 'ephemeral')) {
      throw new Error('Keep the experiment workspace, models, data and outputs on observed data storage. Only an unused training environment can fall back separately through assess_experiment_storage after historical reuse and per-filesystem capacity verification.')
    }
    const previous = this.placements.get(id)
    if (previous !== undefined) {
      if (previous.candidate.id !== candidate) throw new Error('Storage choice is already fixed for this experiment')
      return previous
    }
    const placement = resolveStoragePlacement(observation.server, input.id, input.digest, observation.inventory,
      candidate, reason, input.minimumFreeBytes)
    this.placements.set(id, placement)
    return placement
  }

  /** Run selection with an explicit completion result, independently of generic Agent idle events.
   * @param agent - dispatch Agent. @param id - experiment. @param digest - release identity.
   * @param observations - bounded SSH results. @param minimumFreeBytes - configured storage reserve.
   * @param signal - preparation cancellation. @returns selected paths in observation order.
   */
  async run(agent: Agent, id: ExperimentId, digest: string, observations: StorageSelectionInput[], minimumFreeBytes: number,
    signal: AbortSignal): Promise<StoragePlacement[]> {
    this.input = { id, digest, observations, minimumFreeBytes, signal }
    for (const { server, inventory } of observations) {
      if (this.provider === undefined && !inventory.candidates.some(candidate => candidate.writable && candidate.persistence !== 'ephemeral' && candidate.availableBytes >= minimumFreeBytes)) {
        throw new Error(`No eligible storage for ${server.name}: requires at least ${minimumFreeBytes} free bytes on a writable disk`)
      }
      const explicit = server.storagePreference?.mode === 'manual' ? server.storagePreference.directory
        : server.storagePreference === undefined ? server.remoteRoot : undefined
      if (explicit === undefined) continue
      const candidate = inventory.candidates.find(value => value.directory === explicit)
      if (candidate === undefined) throw new Error(`Configured storage directory was not observed: ${explicit}`)
      this.choose(server.id, candidate.id, 'Explicit server storage setting')
    }
    const content = [{ type: 'text' as const, text: JSON.stringify({ operation: 'prepare-experiment-storage', experimentId: id,
      minimumFreeBytes, servers: observations.map(({ server, inventory }) => ({ id: server.id, name: server.name,
        inventory, selected: this.placements.get(server.id) })),
      instruction: this.placements.size === observations.length ? 'Storage choices are fixed. Retain this context for subsequent preparation; no further selection is requested.'
        : 'Inspect account-side history and storage for every unassigned server. Convert known Goal model/data revisions, environment and output needs into inspect_experiment_materials and assess_experiment_storage requests. Unknown requirements remain pending; the deployment minimum is not training capacity acceptance. If data storage is full, inspect reuse and selected safe cleanup before choosing system storage. Select storage for every server using select_experiment_storage and explain each choice. Once all servers are selected, finish this turn. Training starts after remote handover; do not complete the dispatch Goal.' }) }]
    const message = createUserMessage({ source: { kind: 'aspera', experimentId: id }, content })
    if (this.placements.size === observations.length) {
      agent.inject(message)
      return observations.map(({ server }) => this.required(server.id))
    }
    signal.throwIfAborted()
    const failed = new Promise<never>((_resolve, reject) => { this.reject = reject })
    const abort = () => {
      agent.cancel({ kind: 'user' })
      this.reject?.(new Error('Storage preparation was cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      agent.followup(message)
      await Promise.race([agent.whenIdle(), failed])
      signal.throwIfAborted()
      return observations.map(({ server }) => this.required(server.id))
    } finally {
      signal.removeEventListener('abort', abort)
      this.reject = undefined
      if (agent.status === 'running') agent.cancel({ kind: 'user' })
      await agent.whenIdle()
    }
  }

  private required(id: ExperimentServerId): StoragePlacement {
    const value = this.placements.get(id)
    if (value === undefined) throw new Error('Preparation did not select every server')
    return value
  }
}
