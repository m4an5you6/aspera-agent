/** Approved training stages distinguish cumulative optimizer steps from continuation work. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** One named stage in an approved experiment plan. */
export type ExperimentStageId = string & Branded<'ExperimentStageId'>
/** Model-facing identifiers never select filesystem paths. */
export const experimentStageIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).transform(value => brandString<ExperimentStageId>(value))
/** Scheduler settings refer to optimizer steps, including the original warmup when continuing. */
export const stageSchedulerSchema = z.object({ mode: z.enum(['fresh', 'continue', 'restart']),
  type: z.enum(['cosine', 'linear', 'constant']), learningRate: z.number().positive(),
  warmupSteps: z.number().int().nonnegative(), totalSteps: z.number().int().positive(),
}).strict()
/** Explicit sample semantics prevent fetched examples from being counted as optimizer steps. */
export const stageSamplesSchema = z.object({ unit: z.enum(['example', 'microbatch']), meaning: z.enum(['consumed', 'fetched']),
  expectedCount: z.number().int().positive(), basis: z.string().min(1).max(2000),
  perDeviceBatchSize: z.number().int().positive(), gradientAccumulationSteps: z.number().int().positive(), worldSize: z.number().int().positive(),
  datasetSize: z.number().int().positive().optional(), firstIndex: z.number().int().nonnegative().optional(),
}).strict()
/** Immutable requirements are approved before launch; actual evidence is registered separately. */
export const stageRequirementSchema = z.object({ stageId: experimentStageIdSchema, planStep: z.number().int().min(1).max(100),
  title: z.string().min(1).max(500), framework: z.literal('transformers'),
  startStep: z.number().int().nonnegative(), additionalSteps: z.number().int().positive(), endStep: z.number().int().positive(),
  metricScope: z.enum(['stage', 'cumulative']), loggingSteps: z.number().int().positive(), scheduler: stageSchedulerSchema,
  samples: stageSamplesSchema.optional(), requiredFiles: z.array(z.string().min(1).max(2048)).max(64).default([]),
  results: z.object({ evaluationSamples: z.number().int().positive().optional(), inferencePrompts: z.number().int().positive().optional(), baseControl: z.boolean().default(false) }).strict().optional(),
}).strict().refine(value => value.startStep + value.additionalSteps === value.endStep, 'startStep + additionalSteps must equal endStep')
  .refine(value => value.scheduler.mode !== 'fresh' || value.startStep === 0, 'A fresh stage must start at zero')
  .refine(value => value.scheduler.totalSteps >= (value.scheduler.mode === 'continue' ? value.endStep : value.additionalSteps), 'Scheduler horizon does not cover this stage')
/** Approved phase requirements, without executable code or account credentials. */
export type StageRequirement = z.infer<typeof stageRequirementSchema>
