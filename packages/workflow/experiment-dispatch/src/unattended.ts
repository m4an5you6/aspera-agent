/** Recover unattended Goal coverage from the live registry and durable Session history. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'

/** Cordis service name consulted by question, approval, and plugin-management entries. */
export const GOAL_UNATTENDED_SERVICE = 'goalUnattended'

/** Whether one live agent must not wait for a human. */
export interface GoalUnattended {
  /**
   * Report coverage for an agent, its Goal closing turn, or an owned child.
   * @param agent - the caller, when the request names one.
   * @returns true when waiting for a human is rejected.
   */
  covers(agent: Agent | undefined): boolean
}

/**
 * Cover an active Goal and its closing turn until a later direct human message.
 * The result is derived on every read, so plugin reload cannot erase coverage.
 * @param ctx - host context with live agents and the Goal service.
 */
export function installGoalUnattended(ctx: Context): void {
  const service: GoalUnattended = {
    covers(agent) {
      if (agent === undefined || ctx.agents.get(agent.id) !== agent) return false
      if (!ctx.agents.roots().includes(agent)) {
        const parent = ctx.agents.list().find(candidate => ctx.agents.isOwnedBy(agent.id, candidate))
        return parent !== undefined && service.covers(parent)
      }
      const goal = ctx.goals.get(agent)
      if (goal === undefined) return false
      if (goal.phase !== 'complete') return true
      // A completed Goal still owns the response being written. Its next
      // direct human message returns the Session to ordinary interaction.
      // oxlint-disable-next-line typescript/no-deprecated -- Session history read has no replacement on this host path.
      const events = agent.session.snapshotEvents()
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type === 'user/message' && event.data.source.kind === 'user') return false
        if (event?.type === 'goal/change' && event.data.operation === 'complete'
          && event.data.goal.id === goal.id) return true
      }
      return false
    },
  }
  ctx.provide(GOAL_UNATTENDED_SERVICE, service)
}
