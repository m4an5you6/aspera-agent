/** Independent planning records preserve drafts and bounded documentation reads. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { experimentIdSchema, planInputSchema } from './cluster-protocol.ts'
import { stageRequirementSchema, stageSchedulerSchema, stageSamplesSchema } from './stage-requirements.ts'
import { experimentStoragePolicySchema } from './storage-policy.ts'

/** Fixed releases explicitly identify their supported independent planning format. */
export const planningReleaseSchema = z.object({ version: z.literal(1), formatVersion: z.literal('0.1.0'), requirementsVersion: z.literal(1).optional(), inferenceVersion: z.literal(1).optional() }).strict()
/** Submitted user requirements constrain model-authored plans before approval. */
export const planRequirementsSchema = z.object({ version: z.literal(1), stepCount: z.number().int().min(1).max(100),
  stages: z.array(stageRequirementSchema).max(100), storagePolicy: experimentStoragePolicySchema,
}).strict().refine(value => new Set(value.stages.map(stage => stage.stageId)).size === value.stages.length
  && value.stages.every(stage => stage.planStep <= value.stepCount), 'Required stages must have unique IDs and valid step references')
/** Immutable user-supplied stage and retention requirements. */
export type PlanRequirements = z.infer<typeof planRequirementsSchema>

/** Compare approved requirements without inferring constraints from natural-language summaries.
 * @param plan - structurally validated proposed plan. @param requirements - submitted user requirements.
 * @returns field-local differences; narrative titles and estimation explanations remain editable.
 */
export function planRequirementIssues(plan: z.infer<typeof planInputSchema>, requirements: PlanRequirements): { path: string; expected: string; actual: string }[] {
  const issues: { path: string; expected: string; actual: string }[] = []
  const compare = (path: string, expected: unknown, actual: unknown) => {
    if (JSON.stringify(expected) !== JSON.stringify(actual)) issues.push({ path, expected: 'Submitted requirement: ' + (JSON.stringify(expected) ?? 'omit this field'), actual: JSON.stringify(actual) ?? 'missing' })
  }
  compare('steps.length', requirements.stepCount, plan.steps.length)
  compare('stages.length', requirements.stages.length, plan.stages?.length ?? 0)
  for (const required of requirements.stages) {
    const index = plan.stages?.findIndex(stage => stage.stageId === required.stageId) ?? -1
    if (index < 0) { compare('stages.' + required.stageId, required, undefined); continue }
    const stage = plan.stages![index]!
    for (const key of ['planStep', 'framework', 'startStep', 'additionalSteps', 'endStep', 'metricScope', 'loggingSteps', 'samples', 'results'] as const) compare(`stages.${index}.${key}`, required[key], stage[key])
    for (const key of ['mode', 'type', 'learningRate', 'warmupSteps', 'totalSteps'] as const) compare(`stages.${index}.scheduler.${key}`, required.scheduler[key], stage.scheduler[key])
    compare(`stages.${index}.requiredFiles`, [...required.requiredFiles].sort(), [...stage.requiredFiles].sort())
  }
  for (const key of ['artifact', 'checkpointCount', 'optimizerState', 'schedulerState', 'outputMinimumBytes', 'checkpointMinimumBytes'] as const) compare('storagePolicy.' + key, requirements.storagePolicy[key], plan.storagePolicy?.[key])
  compare('storagePolicy.recoveryPoints', [...requirements.storagePolicy.recoveryPoints].sort(), plan.storagePolicy === undefined ? undefined : [...plan.storagePolicy.recoveryPoints].sort())
  return issues
}
/** One model-specified idempotent draft edit. */
export type PlanningEditId = string & Branded<'PlanningEditId'>
/** One persisted network attempt, including failed attempts. */
export type DocumentationRequestId = string & Branded<'DocumentationRequestId'>
/** One immutable URL, attempt and content binding. */
export type DocumentationSnapshotId = string & Branded<'DocumentationSnapshotId'>
/** Validated model edit identity. */
export const planningEditIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/).transform(value => brandString<PlanningEditId>(value))
/** Program-created network request identity. */
export const documentationRequestIdSchema = z.uuid().transform(value => brandString<DocumentationRequestId>(value))
/** Content-addressed document snapshot identity. */
export const documentationSnapshotIdSchema = z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<DocumentationSnapshotId>(value))

/** A planning record belongs to one immutable experiment, release and Session. */
export const planningOwnerSchema = z.object({ experimentId: experimentIdSchema, sessionId: z.string().min(1).max(256).transform(value => brandString<SessionId>(value)),
  deploymentId: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
/** Independent document limits never shorten installation or node command deadlines. */
export const planningPolicySchema = z.object({ documentationReadTimeoutMs: z.number().int().min(1).max(2_147_483_647).default(30000),
  documentationPageBytes: z.number().int().min(1024).max(65536).default(8192) }).strict()
/** Effective document limits captured on first use in a Session. */
export type PlanningPolicy = z.infer<typeof planningPolicySchema>
/** Trusted identity supplied by the worker, never by model arguments. */
export type PlanningOwner = z.infer<typeof planningOwnerSchema>
/** Draft payloads retain parseable invalid submissions for field-level repair. */
export const planDraftValueSchema = z.record(z.string(), z.json())
/** One stage patch preserves every field omitted by the caller. */
export const planStagePatchSchema = z.object({ ...stageRequirementSchema.shape, requiredFiles: stageRequirementSchema.shape.requiredFiles.unwrap() }).partial().extend({
  stageId: stageRequirementSchema.shape.stageId,
  scheduler: stageSchedulerSchema.partial().optional(), samples: stageSamplesSchema.partial().optional(),
  results: z.object({ ...stageRequirementSchema.shape.results.unwrap().shape,
    baseControl: stageRequirementSchema.shape.results.unwrap().shape.baseControl.unwrap() }).partial().optional(),
}).strict()
/** Revision-checked edits retain original plan step numbers and stage identities. */
export const planDraftEditSchema = z.object({ requestId: planningEditIdSchema, expectedRevision: z.number().int().nonnegative(),
  summary: planInputSchema.shape.summary.optional(), frameworks: planInputSchema.shape.frameworks.optional(), workload: planInputSchema.shape.workload,
  storagePolicy: planInputSchema.shape.storagePolicy,
  steps: z.array(z.union([planInputSchema.shape.steps.element,
    z.object({ step: z.number().int().min(1).max(100), text: planInputSchema.shape.steps.element }).strict()])).max(100)
    .describe('Use either text entries addressed from step one, or numbered {step,text} patches; do not mix formats. Shorter lists retain omitted trailing steps.').optional(),
  stages: z.array(planStagePatchSchema).max(100).optional(), conditionalSteps: planInputSchema.shape.conditionalSteps,
  removeSteps: z.array(z.number().int().min(1).max(100)).max(100).optional(), removeStages: z.array(z.string().min(1).max(80)).max(100).optional(),
  removeFields: z.array(z.enum(['summary', 'frameworks', 'workload', 'stages', 'conditionalSteps'])).optional(),
  removeStageFields: z.array(z.object({ stageId: z.string().min(1).max(80), fields: z.array(z.enum(['samples', 'results', 'requiredFiles'])) }).strict()).max(100).optional(),
}).strict()
/** A continuation names one saved document snapshot and a UTF-16 text position. */
export const documentationReadSchema = z.object({ url: z.string().min(1).max(8192), snapshotId: documentationSnapshotIdSchema.optional(),
  offset: z.number().int().nonnegative().optional(), query: z.string().min(1).max(512).optional(),
  refresh: z.boolean().optional(), retry: z.boolean().optional() }).strict()
/** Model-visible exact document continuation. */
export type DocumentationRead = z.infer<typeof documentationReadSchema>
/** Read a draft section without placing the complete plan in model context. */
export const planDraftReadSchema = z.object({ section: z.enum(['summary', 'steps', 'frameworks', 'workload', 'stages', 'conditionalSteps', 'issues', 'requirements']).optional(),
  step: z.number().int().min(1).max(100).optional(), stageId: z.string().min(1).max(80).optional(),
  revision: z.number().int().nonnegative().optional(), offset: z.number().int().nonnegative().default(0) }).strict()
