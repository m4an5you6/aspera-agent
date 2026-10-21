/** Persist DeepSeek plugin inputs and read earlier resolved snapshots without changing their receipts. */
import { z } from 'zod'
import type { Options, ResolvedDeepSeekOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import type { ResolvedRetryPolicy, RetryPolicyConfig } from '@deepseek-ai/dsh-llm'

function retryConfiguration(policy: ResolvedRetryPolicy): RetryPolicyConfig {
  const backoff = { initialDelayMs: policy.initialDelayMs, maxDelayMs: policy.maxDelayMs, jitterRatio: policy.jitterRatio }
  return policy.mode === 'normal'
    ? { mode: policy.mode, maxRetries: policy.maxRetries, retryableCodes: [...policy.retryableCodes], backoff }
    : { mode: policy.mode, backoff }
}

/** Convert resolved provider settings to the inputs accepted when mounting the same provider again.
 * @param resolved - complete settings captured at admission. @returns detached plugin inputs with explicit defaults.
 */
export function deepSeekConfigurationOptions(resolved: ResolvedDeepSeekOptions): Options {
  const { defaults, filePolicy, retryPolicy, models, ...options } = resolved
  return { ...structuredClone(options), models: structuredClone([...models]), ...defaults,
    fileExpiresAfterSeconds: filePolicy.expiresAfterSeconds, fileRefreshMarginSeconds: filePolicy.refreshMarginSeconds,
    fileQuotaCleanupBatch: filePolicy.quotaCleanupBatch, retryPolicy: retryConfiguration(retryPolicy) }
}

const backoffFields = { initialDelayMs: z.number(), maxDelayMs: z.number(), jitterRatio: z.number() }
const legacyOptionsSchema = z.object({
  defaults: z.object({ thinking: z.enum(['enabled', 'disabled']).optional(), reasoningEffort: z.enum(['off', 'low', 'high', 'max']).optional() }).strict(),
  filePolicy: z.object({ expiresAfterSeconds: z.number(), refreshMarginSeconds: z.number(), quotaCleanupBatch: z.number() }).strict(),
  retryPolicy: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('normal'), maxRetries: z.number(), retryableCodes: z.array(z.string()), ...backoffFields }).strict(),
    z.object({ mode: z.literal('always'), ...backoffFields }).strict(),
  ]),
  thinking: z.never().optional(), reasoningEffort: z.never().optional(),
  fileExpiresAfterSeconds: z.never().optional(), fileRefreshMarginSeconds: z.never().optional(), fileQuotaCleanupBatch: z.never().optional(),
}).catchall(z.json())

/** Interpret earlier version 1 resolved snapshots after the caller has verified their original hashes.
 * @param saved - private JSON options. @returns plugin inputs; native provider validation still checks their values.
 */
export function readDeepSeekConfigurationOptions(saved: Record<string, z.infer<ReturnType<typeof z.json>>>): Options {
  if (!Object.hasOwn(saved, 'defaults') && !Object.hasOwn(saved, 'filePolicy')) return saved
  const { defaults, filePolicy, retryPolicy, ...options } = legacyOptionsSchema.parse(saved)
  return { ...options, ...defaults,
    fileExpiresAfterSeconds: filePolicy.expiresAfterSeconds, fileRefreshMarginSeconds: filePolicy.refreshMarginSeconds,
    fileQuotaCleanupBatch: filePolicy.quotaCleanupBatch, retryPolicy: retryConfiguration(retryPolicy) }
}
