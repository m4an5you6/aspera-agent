/** A preparation Agent chooses observed storage; filesystem mutations remain in the provider. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { serverIdSchema, storageCandidateSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentServerId, ServerInventory, ServerSettings, StorageCandidateId, StoragePlacement } from '@aspera/experiments'
import { resolveStoragePlacement } from '@aspera/runtime'

/** Logged evidence supplied to one preparation run. */
export interface StorageSelectionInput {
  server: ServerSettings
  inventory: ServerInventory
}

/** Scoped tools settle only after every automatic server has an accepted choice. */
export class StorageSelection {
  private input: { id: ExperimentId; digest: string; minimumFreeBytes: number; observations: StorageSelectionInput[] } | undefined
  private readonly placements = new Map<ExperimentServerId, StoragePlacement>()
  private reject: ((error: Error) => void) | undefined

  /** Install only observation and selection tools on the preparation Agent.
   * @param ctx - Agent-scoped services. @param agent - exact owner of preparation errors.
   */
  install(ctx: Context, agent: Agent): void {
    ctx.tools.restrict({ allow: [] })
    const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
    const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera storage preparation', kind: 'other' as const, rawInput: args })
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_server_storage',
      description: 'Read the SSH-observed storage candidates for an assigned server. Persistence unknown is not a guarantee of durable cloud storage.',
      parameters: { server_id: { type: 'string', required: true } }, output, presentCall,
      execute: async args => JSON.stringify(this.observation(serverIdSchema.parse(args.server_id)).inventory) })))
    ctx.effect(() => ctx.tools.register(defineTool({ name: 'select_experiment_storage',
      description: 'Choose one observed writable disk for an assigned server and explain why. Prefer sufficient non-system storage; a sufficient system disk is allowed. Do not choose ephemeral filesystems. This records paths but does not install or train.',
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
    this.input = { id, digest, observations, minimumFreeBytes }
    for (const { server, inventory } of observations) {
      if (!inventory.candidates.some(candidate => candidate.writable && candidate.persistence !== 'ephemeral' && candidate.availableBytes >= minimumFreeBytes)) {
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
      instruction: 'Select storage for every server without a selected assignment using select_experiment_storage. Explain each choice. Once all servers are selected, finish this turn. Training starts after remote handover; do not complete the dispatch Goal.' }) }]
    const message = createUserMessage({ source: { kind: 'aspera', experimentId: id }, content })
    if (this.placements.size === observations.length) {
      agent.session.append('user/message', message, { surfaceOp: 'append' })
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
