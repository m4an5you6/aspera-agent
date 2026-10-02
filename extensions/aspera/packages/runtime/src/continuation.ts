/** Extends the finite DSH round window while preserving the experiment Goal. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-goal'

/** Mount same-Goal renewal before the public driver can exhaust its window.
 * @param ctx - worker lifecycle. @param owner - exact experiment Agent. @param window - deployment-owned increment.
 */
export function installGoalContinuation(ctx: Context, owner: Agent, window: number): void {
  ctx.on('agent/turn-stopping', ({ agent, signal }) => {
    if (agent !== owner || signal.aborted) return
    const goal = ctx.goals.get(agent)
    if (goal?.phase !== 'active' || goal.activation !== 'armed' || goal.maxGoalRounds - goal.roundsStarted > 1) return
    ctx.goals.edit(agent, { id: goal.id, revision: goal.revision }, { maxGoalRounds: goal.maxGoalRounds + window })
  }, { global: true })
}
