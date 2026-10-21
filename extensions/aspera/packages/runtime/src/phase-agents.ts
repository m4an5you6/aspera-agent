/** A phase-local factory with the profile's shared Agent identities and initiator tracking. */
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type SessionStartSource, type AgentSetup, type AgentHandle,
  type CreateAgentOptions, type ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { PhaseContextPolicy } from './phase-context.ts'

/** Keep an outer profile's automatic compactor off this Agent without disabling ordinary conversation compaction. */
function isolateCompactionEvents(ctx: Context, agent: Agent): void {
  type Carrier = { [Context.filter]: (listener: Context) => boolean }
  const carriers = new Map<Carrier, (listener: Context) => boolean>()
  ctx.on('internal/dispatch', (_mode, name, args, receiver) => {
    if (name !== 'agent/pre-step' || args[0]?.agent !== agent) return
    // agent/pre-step carries the published Agent dispatcher before Cordis selects its listeners.
    const carrier = receiver as Carrier
    if (carriers.has(carrier)) return
    const original = carrier[Context.filter]
    carriers.set(carrier, original)
    carrier[Context.filter] = listener => original.call(carrier, listener)
      && (listener.fiber.runtime?.callback !== BasicCompactionEngine || scopeOf(listener) === agent)
  })
  ctx.effect(() => () => {
    for (const [carrier, original] of carriers) carrier[Context.filter] = original
    carriers.clear()
  }, 'Aspera Agent: private compaction listeners')
}

/** Keep creation local to the phase while publication and lifecycle remain visible to profile services. */
export class PhaseAgents extends AgentRegistry {
  private readonly shared: { registry: AgentRegistry; policy: PhaseContextPolicy; provider: string; model: string }

  constructor(ctx: Context, config: { registry: AgentRegistry; policy: PhaseContextPolicy; provider: string; model: string }) {
    super(ctx)
    this.shared = config
    const policies = [config.policy.compaction, ...(config.policy.compaction.modelPolicies ?? [])
      .filter(policy => policy.provider === config.provider && policy.model === config.model)]
    for (const policy of policies) {
      if ((policy.summarizationProvider && policy.summarizationProvider !== config.provider)
        || (policy.summarizationModel && policy.summarizationModel !== config.model)) {
        throw new Error('Phase compaction must use the experiment\'s saved provider and model')
      }
    }
  }

  private setup(original: AgentSetup | undefined): AgentSetup {
    return async (agentCtx, agent) => {
      const commit = await original?.(agentCtx, agent)
      isolateCompactionEvents(agentCtx, agent)
      const context = agentCtx.isolate('compaction').isolate('toolResultPruner')
      await context.plugin(ToolResultPruner, this.shared.policy.pruning)
      await context.plugin(BasicCompactionEngine, this.shared.policy.compaction)
      return commit
    }
  }

  override create(options: CreateAgentOptions): Promise<AgentHandle> {
    return super.create({ ...options, setup: this.setup(options.setup) })
  }
  override resume(options: ResumeAgentOptions): Promise<AgentHandle> {
    return super.resume({ ...options, setup: this.setup(options.setup) })
  }

  override currentInitiator(): Agent | undefined { return this.shared.registry.currentInitiator() }
  override requireInitiator(): Agent { return this.shared.registry.requireInitiator() }
  override withInitiator<T>(agent: Agent, operation: () => T): T { return this.shared.registry.withInitiator(agent, operation) }
  override withoutInitiator<T>(operation: () => T): T { return this.shared.registry.withoutInitiator(operation) }
  override enter(agent: Agent, owner: Agent | undefined): () => void { return this.shared.registry.enter(agent, owner) }
  override announce(agent: Agent, source: SessionStartSource, signal?: AbortSignal): Promise<void> {
    return this.shared.registry.announce(agent, source, signal)
  }
  override get(id: SessionId): Agent | undefined { return this.shared.registry.get(id) }
  override isOwnedBy(id: SessionId, owner: Agent): boolean { return this.shared.registry.isOwnedBy(id, owner) }
  override list(): Agent[] { return this.shared.registry.list() }
  override roots(): Agent[] { return this.shared.registry.roots() }
}
