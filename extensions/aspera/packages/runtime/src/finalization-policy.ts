/** Deployment-owned command observation and finalization correction settings. */
import schema from '@deepseek-ai/schemastery'
import { z } from 'zod'

/** Defaults resolve once before a tool starts; no training lifetime is implied. */
export const finalizationPolicySchema = z.object({ pollIntervalMs: z.number().int().min(10).default(1000),
  readTimeoutMs: z.number().int().min(10).default(30000), reconnectTimeoutMs: z.number().int().min(10).default(60000),
  reasonCorrections: z.number().int().min(1).max(10).default(2), evidenceBytes: z.number().int().min(1024).max(67108864).default(8388608),
  learningRateRelativeTolerance: z.number().positive().max(0.01).default(0.0001),
  learningRateAbsoluteTolerance: z.number().positive().max(0.000001).default(0.000000001),
}).strict()
/** Fully resolved settings shared by command tools and stage checks. */
export type FinalizationPolicy = z.infer<typeof finalizationPolicySchema>
/** Worker profiles expose the same validated deployment settings. */
export const FinalizationPolicyConfig: schema<FinalizationPolicy> = schema.object({
  pollIntervalMs: schema.number().step(1).min(10).default(1000), readTimeoutMs: schema.number().step(1).min(10).default(30000),
  reconnectTimeoutMs: schema.number().step(1).min(10).default(60000), reasonCorrections: schema.number().step(1).min(1).max(10).default(2),
  evidenceBytes: schema.number().step(1).min(1024).max(67108864).default(8388608),
  learningRateRelativeTolerance: schema.number().min(0.000000000001).max(0.01).default(0.0001),
  learningRateAbsoluteTolerance: schema.number().min(0.000000000001).max(0.000001).default(0.000000001),
})
