/** Isolated provider instances backed only by an experiment's private snapshots. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createScope } from '@deepseek-ai/dsh-scope'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { PhaseModelSnapshot } from '@aspera/experiments'
import { PhaseAgents } from './phase-agents.ts'

/** Private JSON has no browser projection; provider headers may contain credentials. */
export const privateModelConfigurationSchema = z.object({ version: z.literal(1),
  adapter: z.enum(['deepseek-api-key', 'pi-ai']), provider: z.string().min(1),
  options: z.record(z.string(), z.json()), keyRef: z.string().regex(/^ASPERA_KEY_[A-Z0-9_]+$/),
}).strict()

/** Bind the standard Agent driver and its provider to the same phase without changing global settings.
 * @param ctx - profile owner with credentials, agents and agentLoop dependencies. @param snapshot - admitted immutable model.
 * @returns scope used to create the Agent and a disposer after the Agent has stopped.
 */
export async function openPhaseModelContext(ctx: Context, snapshot: PhaseModelSnapshot): Promise<{ context: Context; dispose: () => Promise<void> }> {
  const saved = await ctx.credentials.resolve(credentialRef(snapshot.configurationRef))
  if (saved === undefined) throw new Error('Experiment model configuration snapshot is missing')
  if (createHash('sha256').update(saved.value).digest('hex') !== snapshot.configurationHash) throw new Error('Experiment model configuration snapshot changed')
  const stored = privateModelConfigurationSchema.parse(JSON.parse(saved.value))
  if (stored.adapter !== snapshot.adapter || stored.provider !== snapshot.provider) throw new Error('Experiment provider snapshot does not match its receipt')
  if (stored.options.apiKeyEnv !== stored.keyRef || (await ctx.credentials.resolve(credentialRef(stored.keyRef))) === undefined) {
    throw new Error('Experiment model credential snapshot is missing')
  }
  const phase = {}
  const scope = createScope(ctx.isolate('llm').isolate('agents').isolate('agentLoop').isolate('typert'), phase)
  try {
    await scope.ctx.plugin(PhaseAgents, { registry: ctx.agents })
    const provider = await scope.ctx.plugin(LlmRuntime)
    if (stored.adapter === 'deepseek-api-key') await provider.ctx.plugin(DeepSeek, stored.options)
    else await provider.ctx.plugin(PiAi, { providers: { [snapshot.provider]: stored.options } })
    await provider.ctx.llm.resolveModelInfo(snapshot.provider, snapshot.model)
    const loop = await scope.ctx.plugin(AgentLoop, { agents: [], maxParallelToolCalls: ctx.agentLoop.config.maxParallelToolCalls.get() })
    return { context: loop.ctx, dispose: () => scope.dispose() }
  } catch (error) { await scope.dispose(); throw error }
}
