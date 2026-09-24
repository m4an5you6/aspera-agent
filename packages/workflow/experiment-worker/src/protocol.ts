/** Wire and durable record types for one independently running experiment. */
import { z } from 'zod'

/** User requirements. Omitted fields may be resolved by the remote agent. */
export const experimentSpecSchema = z.object({
  objective: z.string().trim().min(1).max(20_000),
  agentModel: z.object({ provider: z.string().min(1), model: z.string().min(1) }).optional(),
  trainingModel: z.string().min(1).optional(),
  datasetRefs: z.array(z.string().min(1)).max(32).default([]),
  trainingMethod: z.string().min(1).optional(),
  requiredGpus: z.number().int().positive().optional(),
  constraints: z.array(z.string().min(1)).max(64).default([]),
  outputPath: z.string().min(1),
}).strict()

/** Validated experiment requirements carried over the authenticated receiver. */
export type ExperimentSpec = z.infer<typeof experimentSpecSchema>

/** One submission, with its deployment and idempotency identities. */
export const submissionSchema = z.object({
  submissionId: z.string().regex(/^[a-f0-9]{64}$/),
  deploymentId: z.string().regex(/^[a-f0-9]{64}$/),
  spec: experimentSpecSchema,
}).strict()

/** Validated receiver input. */
export type ExperimentSubmission = z.infer<typeof submissionSchema>

/** Complete health response from a ready receiver; busy workers still serve status and retries. */
export const experimentHealthSchema = z.object({
  deploymentId: submissionSchema.shape.deploymentId,
  ready: z.literal(true),
  busy: z.boolean(),
}).strict()

/** Validated readiness and occupancy of the deployed receiver. */
export type ExperimentHealth = z.infer<typeof experimentHealthSchema>

/** Persistent lifecycle. `reserved` never resumes automatically after process loss. */
export const experimentRecordSchema = submissionSchema.extend({
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  sessionId: z.string().min(1),
  goalId: z.string().optional(),
  goalPhase: z.enum(['active', 'paused', 'blocked', 'complete']).optional(),
  artifactPath: z.string().min(1),
  workerLogPath: z.string().min(1),
  workerLogAvailable: z.boolean().optional(),
  artifactFiles: z.array(z.object({ path: z.string(), sizeBytes: z.number().int().nonnegative() })).optional(),
  artifactListTruncated: z.boolean().optional(),
  state: z.enum(['reserved', 'accepted', 'complete', 'blocked', 'failed', 'cancelled', 'interrupted']),
  detail: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict()

/** Durable record returned as the receiver's status and acceptance receipt. */
export type ExperimentRecord = z.infer<typeof experimentRecordSchema>
