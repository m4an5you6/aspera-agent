/** Inference-only snapshots retain trained adapters without reactivating the source experiment. */
import { z } from 'zod'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { brandString } from '@deepseek-ai/dsh-brand'
import { experimentIdSchema, serverIdSchema } from './cluster-protocol.ts'
import { storageOperationIdSchema } from './storage-governance.ts'
import { stageEvidencePathSchema } from './finalization.ts'

/** Opaque identity of an observed, sealed checkpoint. */
export type InferenceCheckpointId = string & Branded<'InferenceCheckpointId'>
/** Only adapter loading metadata, adapter weights and native step identity enter inference snapshots. */
export const INFERENCE_CHECKPOINT_FILES = ['adapter_config.json', 'adapter_model.safetensors', 'trainer_state.json'] as const
/** Validate checkpoint identities received from model tools and saved snapshot records. */
export const inferenceCheckpointIdSchema = z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<InferenceCheckpointId>(value))
/** File identity excludes link count and ctime, which change when another preserved alias is removed. */
export const inferenceCheckpointFileSchema = z.object({ name: z.enum(INFERENCE_CHECKPOINT_FILES),
  device: z.string(), inode: z.string(), bytes: z.number().int().positive(), modified: z.number() }).strict()
/** A candidate identifies a released producer and the exact native checkpoint directory. */
export const inferenceCheckpointCandidateSchema = z.object({ checkpointId: inferenceCheckpointIdSchema, sourceExperimentId: experimentIdSchema,
  serverId: serverIdSchema, commandId: z.string(), directory: stageEvidencePathSchema, step: z.number().int().nonnegative(),
  files: z.array(inferenceCheckpointFileSchema).length(3) }).strict().refine(value => new Set(value.files.map(file => file.name)).size === INFERENCE_CHECKPOINT_FILES.length, 'Snapshot files must identify each required adapter file exactly once')
/** Read-only discovery accepts a saved source experiment, never an arbitrary filesystem path. */
export const inspectInferenceCheckpointsSchema = z.object({ sourceExperimentId: experimentIdSchema }).strict()
/** Repeating an operation preserves the original source and snapshot identity. */
export const prepareInferenceCheckpointSchema = inspectInferenceCheckpointsSchema.extend({ operationId: storageOperationIdSchema,
  checkpointId: inferenceCheckpointIdSchema }).strict()
/** Independent version-1 publication record; ready snapshots are protected in every command and service. */
export const inferenceCheckpointSnapshotSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  request: prepareInferenceCheckpointSchema, source: inferenceCheckpointCandidateSchema, state: z.enum(['publishing', 'ready']),
  destination: stageEvidencePathSchema, mode: z.literal('hardlink'), additionalFileBytes: z.literal(0),
  files: z.array(inferenceCheckpointFileSchema.extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) })).length(3),
  startedAt: z.number(), updatedAt: z.number() }).strict().superRefine((value, context) => {
  if (value.source.sourceExperimentId !== value.request.sourceExperimentId || value.source.checkpointId !== value.request.checkpointId
    || value.source.serverId !== value.serverId || value.destination !== 'inference-checkpoints/' + value.request.checkpointId
    || value.experimentId === value.source.sourceExperimentId) context.addIssue({ code: 'custom', message: 'Snapshot source, request or destination identity differs' })
  if (new Set(value.files.map(file => file.name)).size !== INFERENCE_CHECKPOINT_FILES.length
    || value.files.some(file => !value.source.files.some(source => source.name === file.name && source.bytes === file.bytes
      && source.device === file.device && source.inode === file.inode && source.modified === file.modified))) {
    context.addIssue({ code: 'custom', message: 'Snapshot file proofs differ from the selected candidate' })
  }
})
/** Program-owned proof of the adapter snapshot and its original training identity. */
export type InferenceCheckpointSnapshot = z.infer<typeof inferenceCheckpointSnapshotSchema>
/** Observed original checkpoint metadata, without model weights or credentials. */
export type InferenceCheckpointCandidate = z.infer<typeof inferenceCheckpointCandidateSchema>
/** Idempotent adapter snapshot request. */
export type PrepareInferenceCheckpoint = z.infer<typeof prepareInferenceCheckpointSchema>
