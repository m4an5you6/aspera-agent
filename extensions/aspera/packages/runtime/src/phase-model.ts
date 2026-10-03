/** Isolated provider instances backed only by an experiment's private snapshots. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { PhaseModelSnapshot } from '@aspera/experiments'

/** Private JSON has no browser projection; provider headers may contain credentials. */
export const privateModelConfigurationSchema = z.object({ version: z.literal(1),
  adapter: z.enum(['deepseek-api-key', 'pi-ai']), provider: z.string().min(1),
  options: z.record(z.string(), z.json()), keyRef: z.string().regex(/^ASPERA_KEY_[A-Z0-9_]+$/),
}).strict()

/** Bind a provider without changing global settings or permitting ambient authentication.
 * @param ctx - owner of the short-lived provider scope. @param snapshot - admitted immutable model.
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
  const scope = await ctx.isolate('llm').plugin(LlmRuntime)
  try {
    if (stored.adapter === 'deepseek-api-key') await scope.ctx.plugin(DeepSeek, stored.options)
    else await scope.ctx.plugin(PiAi, { providers: { [snapshot.provider]: stored.options } })
    await scope.ctx.llm.resolveModelInfo(snapshot.provider, snapshot.model)
    return { context: scope.ctx, dispose: () => scope.dispose() }
  } catch (error) { await scope.dispose(); throw error }
}
