/** A preparation Agent chooses observed storage; filesystem mutations remain in the provider. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { serverIdSchema, storageCandidateSchema } from '@aspera/experiments'
import { assessExperimentStorageSchema, inspectExperimentMaterialsSchema, experimentStoragePlanSchema, storageOperationIdSchema, storageInspectionScopeSchema, prepareExperimentMaterialsSchema } from '@aspera/experiments'
import type { ExperimentStoragePlan } from '@aspera/experiments'
import { z } from 'zod'
import { posix } from 'node:path'
import type { ExperimentId, ExperimentServerId, ServerInventory, ServerSettings, StorageCandidateId, StoragePlacement } from '@aspera/experiments'
import { resolveStoragePlacement } from '@aspera/runtime'
import { verifyStorageRegistrationSchema, storageRegistrationReceiptSchema } from '@aspera/experiments'
import { storagePlacementSchema } from '@aspera/experiments'
import type { StorageCandidate } from '@aspera/experiments'

/** Logged evidence supplied to one preparation run. */
export interface StorageSelectionInput {
  server: ServerSettings
  inventory: ServerInventory
}

/** Directory choices and the exact observations that justify them commit together. */
export interface StorageSelectionResult {
  placements: StoragePlacement[]
  inventories: { serverId: ExperimentServerId; inventory: ServerInventory }[]
}

/** Scoped tools settle only after every automatic server has an accepted choice. */
export class StorageSelection {
  private input: { id: ExperimentId; digest: string; minimumFreeBytes: number; observations: StorageSelectionInput[]; signal: AbortSignal } | undefined
  private readonly placements = new Map<ExperimentServerId, StoragePlacement>()
  private readonly selectionInventories = new Map<ExperimentServerId, ServerInventory>()
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
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'verify_server_storage',
      description: 'Verify a current owned storage root after a container copy or mount change. json: operationId UUID, rootId and observationId returned by inspect_server_storage. The program preserves old registration and requires fresh material/environment verification. This does not release tasks, select materials or modify a fixed experiment placement.',
      parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output, presentCall,
      execute: async args => JSON.stringify(storageRegistrationReceiptSchema.parse(await this.history(serverIdSchema.parse(args.server_id),
        'history-register', { request: verifyStorageRegistrationSchema.parse(JSON.parse(args.json)) }))) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_server_storage',
      description: 'Read the SSH-observed storage candidates for an assigned server. Persistence unknown is not a guarantee of durable cloud storage.',
      parameters: { server_id: { type: 'string', required: true }, cursor: { type: 'string' }, scope_json: { type: 'string' } }, output, presentCall,
      execute: async args => {
        const id = serverIdSchema.parse(args.server_id)
        const history = this.provider === undefined ? undefined : await this.history(id, 'history-inspect', {
          ...(args.cursor === undefined ? {} : { cursor: args.cursor }), ...(args.scope_json === undefined ? {} : { scope: storageInspectionScopeSchema.parse(JSON.parse(args.scope_json)) }) })
        return JSON.stringify({ inventory: this.observation(id).inventory, ...(history === undefined ? {} : { history }) })
      } })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'assess_experiment_storage',
      description: 'Assess known training needs against one observed candidate before choosing storage. json includes operationId, materialIds, environmentId, requirements, outputBytes and checkpointBytes. Optional materialSources:[{materialId,verificationOperationId,mode:readonly|copy}] binds explicit verification evidence. Program reads fixed manifests and measures each filesystem; unknown dependency or source bytes stay pending. Without materialSources, capacity covers default assets only.',
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
      description: 'Read canonical fixed-revision model/data file metadata before selecting storage. json: kind, provider, repository, immutable revision, optional files, HTTPS mirror, metadataSource and reuseCandidateId. Inspection does not select a source for subsequent operations. Candidates may be discovered before or after this call. No model weights are downloaded.',
      parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output, presentCall,
      execute: async args => JSON.stringify(await this.history(serverIdSchema.parse(args.server_id), 'history-material-inspect', { request: inspectExperimentMaterialsSchema.parse(JSON.parse(args.json)) })) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'prepare_experiment_materials',
      description: 'Verify an owned fixed model/data candidate read-only before choosing storage. json: operationId, materialId, action verify or recover, optional reuseCandidateId. Pass the chosen candidate directly even when earlier metadata inspection omitted it; omitting the candidate checks default assets only. No download budget is needed; fileResults retains every verified, missing, mismatched or unreadable file. This tool cannot acquire, publish or start training. Preserve the operation ID and original deadline after disconnects.',
      parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output, presentCall,
      execute: async args => {
        const request = prepareExperimentMaterialsSchema.parse(JSON.parse(args.json))
        if (request.action !== 'verify' && request.action !== 'recover') throw new Error('Preparation storage tools only allow read-only material verification')
        return JSON.stringify(await this.history(serverIdSchema.parse(args.server_id), 'history-material-verify', { request }))
      } })))
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
    this.selectionInventories.set(id, structuredClone(observation.inventory))
    return placement
  }

  /** Run selection with an explicit completion result, independently of generic Agent idle events.
   * @param agent - dispatch Agent. @param id - experiment. @param digest - release identity.
   * @param observations - bounded SSH results. @param minimumFreeBytes - configured storage reserve.
   * @param signal - preparation cancellation. @returns selected paths and matching observations in server order.
   */
  async run(agent: Agent, id: ExperimentId, digest: string, observations: StorageSelectionInput[], minimumFreeBytes: number,
    signal: AbortSignal): Promise<StorageSelectionResult> {
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
      return this.result(observations)
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
      return this.result(observations)
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

  private result(observations: StorageSelectionInput[]): StorageSelectionResult {
    const placements = observations.map(({ server }) => this.required(server.id))
    const inventories = observations.map(({ server }) => {
      const inventory = this.selectionInventories.get(server.id)
      if (inventory === undefined) throw new Error('Selected storage observation is missing')
      return { serverId: server.id, inventory }
    })
    return structuredClone({ placements, inventories })
  }
}

function sameStorageIdentity(left: StorageCandidate, right: StorageCandidate): boolean {
  return left.id === right.id && left.directory === right.directory && left.systemVolume === right.systemVolume
    && left.mount.mountPoint === right.mount.mountPoint && left.mount.root === right.mount.root
    && left.mount.source === right.mount.source && left.mount.filesystem === right.mount.filesystem
    && left.mount.device === right.mount.device && left.mount.uuid === right.mount.uuid
}

/** Recheck fixed directories before retrying an unsubmitted preparation; no filesystem writes occur.
 * @param input - original experiment, release, selected servers, saved choices and scoped SSH inspection.
 * @returns matching current observations and assignments with the original paths and release retained.
 */
export async function refreshStorageSelection(input: {
  id: ExperimentId; digest: string; servers: ServerSettings[]; saved: StorageSelectionResult; signal: AbortSignal
  inspect: (server: ServerSettings, signal: AbortSignal) => Promise<ServerInventory>
}): Promise<StorageSelectionResult> {
  const { servers, saved, signal } = input
  const ids = new Set(servers.map(server => server.id))
  if (ids.size !== servers.length || saved.placements.length !== ids.size || saved.inventories.length !== ids.size
    || new Set(saved.placements.map(row => row.serverId)).size !== ids.size
    || new Set(saved.inventories.map(row => row.serverId)).size !== ids.size
    || saved.placements.some(row => !ids.has(row.serverId)) || saved.inventories.some(row => !ids.has(row.serverId))) {
    throw new Error('Saved storage assignments must cover every selected server exactly once')
  }
  for (const placement of saved.placements) {
    const observed = saved.inventories.find(row => row.serverId === placement.serverId)!.inventory
    const candidate = observed.candidates.find(row => row.id === placement.candidate.id)
    if (placement.experimentId !== input.id || !placement.releaseRoot.endsWith('/' + input.digest)) {
      throw new Error('Saved storage assignment belongs to a different experiment or fixed release')
    }
    if (candidate === undefined || !sameStorageIdentity(candidate, placement.candidate)) {
      throw new Error('Saved storage identity differs from the selected directory; inspect its registration before retrying')
    }
  }
  const placements: StoragePlacement[] = []; const inventories: StorageSelectionResult['inventories'] = []
  for (const server of servers) {
    signal.throwIfAborted()
    const previous = saved.placements.find(row => row.serverId === server.id)!
    const inventory = await input.inspect(server, signal)
    signal.throwIfAborted()
    const candidate = inventory.candidates.find(row => row.id === previous.candidate.id)
    if (candidate === undefined || !sameStorageIdentity(candidate, previous.candidate)) {
      throw new Error(`Storage identity changed for ${server.name}; retry cannot move its fixed directories`)
    }
    if (!candidate.writable || candidate.persistence === 'ephemeral' || candidate.availableBytes < previous.minimumFreeBytes) {
      throw new Error(`Storage candidate is unavailable or has insufficient space: ${candidate.directory}`)
    }
    const controlRoot = server.remoteRoot ?? posix.join(inventory.home, '.local/share/aspera', server.id)
    if (controlRoot !== previous.controlRoot) throw new Error(`Storage directory ownership changed for ${server.name}`)
    placements.push(storagePlacementSchema.parse({ ...previous, candidate }))
    inventories.push({ serverId: server.id, inventory })
  }
  return { placements, inventories }
}
