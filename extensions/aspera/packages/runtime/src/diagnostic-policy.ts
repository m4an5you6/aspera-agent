/** Limits for diagnostics that do not reserve training storage. */
import s from '@deepseek-ai/schemastery'
import { z } from 'zod'

/** Resolve finite bounds before accepting diagnostic commands or evidence. */
export const diagnosticPolicySchema = z.object({
  timeoutMs: z.number().int().min(1000).max(3600000).default(60000),
  temporaryBytes: z.number().int().min(1048576).max(1073741824).default(67108864),
  logBytes: z.number().int().min(1024).max(67108864).default(8388608),
  evidenceFileBytes: z.number().int().min(1024).max(16777216).default(1048576),
  evidenceTotalBytes: z.number().int().min(1024).max(67108864).default(16777216),
}).strict().refine(value => value.evidenceFileBytes <= value.evidenceTotalBytes, 'Evidence file limit exceeds experiment limit')
/** Resolved diagnostic limits. */
export type DiagnosticPolicy = z.infer<typeof diagnosticPolicySchema>
/** Cordis settings available in finalization.diagnostics. */
export const DiagnosticPolicyConfig: s<DiagnosticPolicy> = s.object({
  timeoutMs: s.number().step(1).min(1000).max(3600000).default(60000),
  temporaryBytes: s.number().step(1).min(1048576).max(1073741824).default(67108864),
  logBytes: s.number().step(1).min(1024).max(67108864).default(8388608),
  evidenceFileBytes: s.number().step(1).min(1024).max(16777216).default(1048576),
  evidenceTotalBytes: s.number().step(1).min(1024).max(67108864).default(16777216),
})
