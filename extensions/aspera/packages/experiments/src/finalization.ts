/** Independent version-1 execution, acceptance and retrospective supplement journals. */
import { z } from 'zod'
import { experimentIdSchema, serverIdSchema, clusterCommandResultSchema } from './cluster-protocol.ts'
import { stageRequirementSchema, experimentStageIdSchema } from './stage-requirements.ts'
import { completionSourceSchema } from './completion.ts'
import { commandAdmissionRejectionSchema } from './command-admission.ts'

/** Only relative evidence paths within the original workspace can be selected by a model. */
export const stageEvidencePathSchema = z.string().min(1).max(2048).refine(value => !value.startsWith('/')
  && !value.split('/').some(part => ['', '.', '..'].includes(part)) && !['\\', '\0', '\r', '\n'].some(character => value.includes(character)), 'Expected an experiment-relative evidence path')
const stageRegistrationFields = z.object({ stageId: experimentStageIdSchema, serverId: serverIdSchema,
  attemptId: experimentStageIdSchema, commandId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  parameters: stageEvidencePathSchema, trainerState: stageEvidencePathSchema, metrics: stageEvidencePathSchema,
  resumeState: stageEvidencePathSchema.optional(), samples: stageEvidencePathSchema.optional(),
  optimizerState: stageEvidencePathSchema.optional(), schedulerState: stageEvidencePathSchema.optional(), rngState: stageEvidencePathSchema.optional(),
  evaluation: stageEvidencePathSchema.optional(), inference: stageEvidencePathSchema.optional(), baseControl: stageEvidencePathSchema.optional(),
  attemptLabel: z.string().min(1).max(100).optional(),
}).strict()
/** Actual evidence filenames and an optional failed predecessor selected before stage execution. */
export const stageRegistrationInputSchema = stageRegistrationFields.extend({ previousAttemptId: experimentStageIdSchema.optional() }).strict()
/** Program-bound requirement and evidence locations; registration does not establish acceptance. */
export const stageRegistrationSchema = stageRegistrationFields.extend({ version: z.literal(1), experimentId: experimentIdSchema,
  planRevision: z.number().int().positive(), sessionId: z.string().min(1), requirement: stageRequirementSchema,
  registeredAt: z.number().int().nonnegative(), historical: z.boolean(),
  parametersIdentity: completionSourceSchema.optional(),
}).strict()
/** Individual numeric and identity checks retain explicit failures rather than silently skipping evidence. */
export const stageCheckSchema = z.object({ code: z.string(), passed: z.boolean(), detail: z.string() }).strict()
/** Checked source hashes are re-read before publishing an experiment outcome. */
export const stageVerificationSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  stageId: experimentStageIdSchema, attemptId: experimentStageIdSchema, planRevision: z.number().int().positive(), sessionId: z.string(),
  ready: z.boolean(), checkedAt: z.number().int().nonnegative(), checks: z.array(stageCheckSchema), sources: z.array(completionSourceSchema),
  startStep: z.number().int().nonnegative(), additionalSteps: z.number().int().nonnegative(), endStep: z.number().int().nonnegative(),
}).strict()
/** An immutable successor retains the confirmed failed command and any original verification. */
export const stageAttemptTransitionSchema = z.object({ version: z.literal(1), previousAttemptId: experimentStageIdSchema,
  previousCommand: clusterCommandResultSchema, previousVerification: stageVerificationSchema.optional(),
  registration: stageRegistrationSchema, checkedAt: z.number().int().nonnegative(),
}).strict()
/** A waiter records observation failure separately from the actual command outcome. */
export const commandWaitSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  commandId: z.string(), state: z.enum(['waiting', 'settled', 'unknown', 'cancelled', 'rejected']),
  startedAt: z.number().int().nonnegative(), checkedAt: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative(),
  result: clusterCommandResultSchema.optional(), detail: z.string().optional(),
  formatVersion: z.enum(['0.1.3', '0.1.4']).optional(), rejection: commandAdmissionRejectionSchema.optional(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), purpose: z.enum(['run', 'diagnostic']).optional(),
  submitError: z.string().optional(), observationError: z.string().optional(), reconnectDeadlineAt: z.number().int().nonnegative().optional(),
}).strict()
/** Budget assertions require a program-owned event reference, never just a model explanation. */
export const finishReasonSchema = z.enum(['requirement', 'input-context-limit', 'output-token-limit', 'program-budget', 'compaction-failure', 'agent-report'])
/** References select durable program observations; a model cannot supply their result or explanation. */
export const requirementEvidenceReferenceSchema = z.object({ serverId: serverIdSchema,
  kind: z.enum(['storage-plan', 'material-request', 'material-operation', 'environment-operation']), id: z.string().regex(/^(?:[a-f0-9]{64}|[a-f0-9-]{36})$/) }).strict()
/** Re-read node evidence is associated with the original plan and execution Session. */
export const requirementEvidenceSchema = z.object({ version: z.literal(1), formatVersion: z.literal('0.1.1'),
  experimentId: experimentIdSchema, serverId: serverIdSchema, sessionId: z.string(), planRevision: z.number().int().positive(),
  reference: requirementEvidenceReferenceSchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/), checkedAt: z.number().int().nonnegative(), detail: z.string() }).strict()
/** Final decisions remain independent of the original queue and Goal formats. */
export const finishDecisionSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, sessionId: z.string(),
  requested: z.enum(['completed', 'blocked']), decision: z.enum(['wait', 'supplement', 'accepted', 'unconfirmed', 'agent-incomplete']),
  reason: finishReasonSchema, verified: z.boolean(), checkedAt: z.number().int().nonnegative(), detail: z.string(),
  evidenceSeqs: z.array(z.number().int().nonnegative()), factsHash: z.string().regex(/^[a-f0-9]{64}$/), corrections: z.number().int().nonnegative(),
  requirementEvidence: z.array(requirementEvidenceSchema).optional(),
}).strict()
/** Supplementary step claims never overwrite original reports. */
export const reviewStepSchema = z.object({ step: z.number().int().min(1).max(100), state: z.enum(['completed', 'blocked', 'not-applicable']),
  detail: z.string().min(1).max(2000), sources: z.array(completionSourceSchema).min(1), recordedAt: z.number().int().nonnegative(), callId: z.string(),
}).strict()
/** New review evidence is linked to the original outcome and stored outside the version-1 review receipt. */
export const completionAssessmentSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, operationId: z.uuid(),
  originalState: z.enum(['failed', 'blocked']), originalRevision: z.number().int().positive(), submissionHash: z.string().regex(/^[a-f0-9]{64}$/),
  planRevision: z.number().int().positive(), executionSessionId: z.string(), revision: z.number().int().nonnegative(),
  steps: z.array(reviewStepSchema), stages: z.array(stageRegistrationSchema), verifications: z.array(stageVerificationSchema),
  eligibilityVerified: z.boolean(), updatedAt: z.number().int().nonnegative(),
}).strict()
/** Lightweight observations retain their original times when served from an offline local copy. */
export const experimentFinalizationStatusSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema,
  supported: z.boolean(), observedAt: z.number().int().nonnegative(), offline: z.boolean(), truncated: z.boolean(),
  waits: z.array(commandWaitSchema), stages: z.array(stageVerificationSchema), decision: finishDecisionSchema.optional(), error: z.string().optional(),
}).strict()
export type StageRegistrationInput = z.infer<typeof stageRegistrationInputSchema>
export type StageRegistration = z.infer<typeof stageRegistrationSchema>
export type StageVerification = z.infer<typeof stageVerificationSchema>
/** Immutable successor published after a failed command has released its processes. */
export type StageAttemptTransition = z.infer<typeof stageAttemptTransitionSchema>
export type CommandWait = z.infer<typeof commandWaitSchema>
export type FinishReason = z.infer<typeof finishReasonSchema>
export type FinishDecision = z.infer<typeof finishDecisionSchema>
export type RequirementEvidence = z.infer<typeof requirementEvidenceSchema>
export type CompletionAssessment = z.infer<typeof completionAssessmentSchema>
export type ReviewStep = z.infer<typeof reviewStepSchema>
export type ExperimentFinalizationStatus = z.infer<typeof experimentFinalizationStatusSchema>
