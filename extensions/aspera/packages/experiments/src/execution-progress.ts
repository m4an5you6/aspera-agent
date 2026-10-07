/** Version 1 Agent step reports are independent of queue, submission and Session formats. */
import { z } from 'zod'
import { experimentIdSchema } from './cluster-protocol.ts'

/** One approved plan step; missing timestamps mean it has not been reported. */
export const executionStepSchema = z.object({
  step: z.number().int().min(1).max(100),
  state: z.enum(['pending', 'running', 'completed', 'blocked']),
  detail: z.string().max(2000).optional(),
  updatedAt: z.number().int().nonnegative().optional(),
  callId: z.string().min(1).max(200).optional(),
  previousRevision: z.number().int().nonnegative().optional(),
}).strict()

/** Durable reports bind to the exact approved plan and execution Session. */
export const executionProgressSchema = z.object({
  version: z.literal(1), experimentId: experimentIdSchema,
  planRevision: z.number().int().positive(), sessionId: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative().optional(),
  steps: z.array(executionStepSchema).min(1).max(100),
}).strict()

/** Agent arguments; identity, generation, call ID and time are supplied by the worker. */
export const executionStepInputSchema = z.object({
  planRevision: z.number().int().positive(), expectedRevision: z.number().int().nonnegative(),
  step: z.number().int().min(1).max(100), state: z.enum(['running', 'completed', 'blocked']),
  detail: z.string().max(2000).optional(),
}).strict()

/** Authenticated report ownership cannot be selected by the model. */
export const executionStepReportSchema = executionStepInputSchema.extend({
  experimentId: experimentIdSchema, sessionId: z.string().min(1).max(200),
  callId: z.string().min(1).max(200), generation: z.string().min(1),
}).strict()

/** Unsupported releases and plans without reports remain distinct from read failures. */
export const executionProgressReadSchema = z.object({ supported: z.boolean(), progress: executionProgressSchema.optional() }).strict()

/** A rejected report includes the current revision when it can be safely read. */
export const executionStepResultSchema = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), progress: executionProgressSchema }).strict(),
  z.object({ accepted: z.literal(false), error: z.string(), progress: executionProgressSchema.optional() }).strict(),
])

/** One Agent-reported plan step; completion is not independent acceptance. */
export type ExecutionStep = z.infer<typeof executionStepSchema>
/** Independently versioned latest step reports. */
export type ExecutionProgress = z.infer<typeof executionProgressSchema>
/** Model-selected step update. */
export type ExecutionStepInput = z.infer<typeof executionStepInputSchema>
/** Worker-bound update submitted to the coordinator. */
export type ExecutionStepReport = z.infer<typeof executionStepReportSchema>
/** Public read including explicit old-release availability. */
export type ExecutionProgressRead = z.infer<typeof executionProgressReadSchema>
/** Accepted state or a recoverable revision/ownership diagnostic. */
export type ExecutionStepResult = z.infer<typeof executionStepResultSchema>
