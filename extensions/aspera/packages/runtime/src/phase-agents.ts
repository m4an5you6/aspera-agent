/** A phase-local factory with the profile's shared Agent identities and initiator tracking. */
import type { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent, type SessionStartSource } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Keep creation local to the phase while publication and lifecycle remain visible to profile services. */
export class PhaseAgents extends AgentRegistry {
  private readonly shared: { registry: AgentRegistry }

  constructor(ctx: Context, config: { registry: AgentRegistry }) {
    super(ctx)
    this.shared = config
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
