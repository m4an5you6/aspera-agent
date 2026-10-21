/** Completion evidence and retrospective reviews do not change original queue or Session records. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { experimentIdSchema, serverIdSchema, executionEntrySchema } from './cluster-protocol.ts'

/** One supplementary operation, retained across cancellation and Host restarts. */
export type CompletionReviewId = string & Branded<'CompletionReviewId'>
/** Validate supplementary operation ownership at durable and Remote inputs. */
export const completionReviewIdSchema = z.uuid().transform(value => brandString<CompletionReviewId>(value))

/** One independently checked prerequisite with a model-readable repair instruction. */
export const completionIssueSchema = z.object({ serverId: serverIdSchema.optional(),
  code: z.enum(['identity', 'steps', 'execution', 'environment', 'commands', 'sources', 'results', 'release', 'stages']),
  detail: z.string(), remedy: z.string(),
}).strict()
/** Shared result used before Goal completion, during final settlement and for historical review. */
export const completionCheckSchema = z.object({ version: z.literal(1), ready: z.boolean(), checkedAt: z.number(),
  issues: z.array(completionIssueSchema),
}).strict()
export type CompletionIssue = z.infer<typeof completionIssueSchema>
export type CompletionCheck = z.infer<typeof completionCheckSchema>

/** A model selects only experiment-relative evidence; identity and hashes are supplied by the reader. */
export const completionSourceInputSchema = z.object({ serverId: serverIdSchema, path: z.string().min(1).max(2048),
  purpose: z.enum(['framework', 'script', 'environment', 'parameters', 'training', 'evaluation', 'artifact', 'inference']),
}).strict()
/** Immutable observed file identity, separate from the original execution-entry format. */
export const completionSourceSchema = completionSourceInputSchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/),
  generation: z.string().min(1), bytes: z.number().int().nonnegative(),
}).strict()
export type CompletionSourceInput = z.infer<typeof completionSourceInputSchema>
export type CompletionSource = z.infer<typeof completionSourceSchema>

/** Optional normal execution sources bind the original entry to one submission and Session. */
export const executionSourcesSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema,
  submissionHash: z.string().regex(/^[a-f0-9]{64}$/), sessionId: z.string(), entry: executionEntrySchema,
  sources: z.array(completionSourceSchema), recordedAt: z.number(), callId: z.string(),
}).strict()
/** An unfinished execution-entry write prevents Goal completion until a recording commits. */
export const executionRecordPendingSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema,
  callId: z.string(), entry: executionEntrySchema,
}).strict()

/** Historical environments are observational records and cannot serve as managed installation receipts. */
export const historicalEnvironmentSchema = z.object({ version: z.literal(1), kind: z.literal('historical'), serverId: serverIdSchema,
  path: z.string(), python: z.string(), packages: z.record(z.string(), z.string()), digest: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.number(),
}).strict()
export type HistoricalEnvironment = z.infer<typeof historicalEnvironmentSchema>

/** Append-only supplementary entries retain sources and the original execution identity. */
export const completionSupplementSchema = z.object({ entry: executionEntrySchema, sources: z.array(completionSourceSchema).min(1),
  environment: historicalEnvironmentSchema.optional(), recordedAt: z.number(), callId: z.string(),
}).strict()
/** A version-1 operation keeps its original failed result; passed is a separate, dated assessment. */
export const completionReviewSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema,
  operationId: completionReviewIdSchema, submissionHash: z.string().regex(/^[a-f0-9]{64}$/), planRevision: z.number().int().positive(),
  executionSessionId: z.string().min(1), sessionId: z.string().min(1), originalRevision: z.number().int().positive(),
  originalUpdatedAt: z.number(), originalDetail: z.string(), revision: z.number().int().nonnegative(),
  phase: z.enum(['collecting', 'verifying', 'passed', 'blocked', 'cancelled']), createdAt: z.number(), updatedAt: z.number(),
  currentServerId: serverIdSchema.optional(),
  entries: z.array(completionSupplementSchema), check: completionCheckSchema.optional(), detail: z.string().optional(),
  verifiedAt: z.number().optional(), remoteCommitted: z.boolean(),
}).strict()
export type CompletionSupplement = z.infer<typeof completionSupplementSchema>
export type CompletionReview = z.infer<typeof completionReviewSchema>

/** Legacy failures are eligible only with independent completion and release evidence. */
export const legacyCompletionEvidenceError = 'Completion lacks recorded framework, script, environment and parameter evidence on every selected node.'
