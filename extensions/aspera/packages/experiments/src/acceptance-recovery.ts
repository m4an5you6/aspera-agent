/** Acceptance recovery binds new serving evidence to retained original training without rewriting either submission. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { experimentIdSchema, serverIdSchema, deploymentIdSchema, serviceSchema, clusterStateSchema } from './cluster-protocol.ts'
import { inferenceCheckpointSnapshotSchema, inferenceCheckpointFileSchema } from './inference-checkpoint.ts'
import { serviceVerificationSchema } from './service-verification.ts'
import { completionReviewIdSchema } from './completion.ts'

/** One Host-owned recovery operation beneath an existing experiment. */
export type AcceptanceRecoveryId = string & Branded<'AcceptanceRecoveryId'>
/** Validate operation identities at Remote and persisted-record inputs. */
export const acceptanceRecoveryIdSchema = z.uuid().transform(value => brandString<AcceptanceRecoveryId>(value))
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
/** Original requirements and file proofs are supplied by program inspection, never inferred from recovery reports. */
export const acceptanceSourceSchema = z.object({ experimentId: experimentIdSchema, submissionHash: sha256,
  resultRevision: z.number().int().nonnegative(), planRevision: z.number().int().positive(), executionSessionId: z.string().min(1),
  nodes: z.array(z.object({ serverId: serverIdSchema, step: z.number().int().positive(), commandId: z.string().min(1),
    checkpointId: sha256, directory: z.string().min(1),
    files: z.array(inferenceCheckpointFileSchema.extend({ sha256 })).length(3).refine(files => new Set(files.map(file => file.name)).size === 3),
    publicUrl: z.string().url(), modelName: z.string().min(1),
  }).strict()).min(1),
}).strict()
/** A recovery observation includes independently read checkpoints and program-issued public checks. */
export const acceptanceRecoveryObservationSchema = z.object({ experimentId: experimentIdSchema, submissionHash: sha256,
  deploymentId: deploymentIdSchema, state: clusterStateSchema, goalFinished: z.boolean(),
  snapshots: z.array(inferenceCheckpointSnapshotSchema), services: z.array(serviceSchema), verifications: z.array(serviceVerificationSchema),
}).strict()
export type AcceptanceSource = z.infer<typeof acceptanceSourceSchema>
export type AcceptanceRecoveryObservation = z.infer<typeof acceptanceRecoveryObservationSchema>
/** Independent version-1 records link a recovery runtime and preserve the original terminal result. */
export const acceptanceRecoverySchema = z.object({ version: z.literal(1), operationId: acceptanceRecoveryIdSchema,
  experimentId: experimentIdSchema, source: acceptanceSourceSchema, recoveryExperimentId: experimentIdSchema,
  recoverySubmissionHash: sha256, recoveryDeploymentId: deploymentIdSchema,
  phase: z.enum(['recovering', 'verifying', 'reviewing', 'passed', 'blocked', 'cancelled']),
  revision: z.number().int().nonnegative(), createdAt: z.number(), updatedAt: z.number(), detail: z.string().optional(),
  evidencePath: z.string().optional(), evidenceHash: sha256.optional(), reviewOperationId: completionReviewIdSchema.optional(),
  recoveryState: clusterStateSchema, services: z.array(serviceSchema),
  managedRuntimes: z.array(experimentIdSchema), pendingRuntimeId: experimentIdSchema.optional(),
}).strict()
export type AcceptanceRecovery = z.infer<typeof acceptanceRecoverySchema>
/** Program diagnostics distinguish incomplete recovery from incompatible or failed serving evidence. */
export interface AcceptanceRecoveryCheck { ready: boolean; blocked: boolean; issues: string[] }

/**
 * Match every required inference node to its original native checkpoint and a stable recovered public service.
 * @param source - independently inspected original requirements and files.
 * @param observation - current recovery task and program-owned serving records.
 * @returns readiness only for retained checkpoints and all five public checks; never a training-completion verdict.
 */
export function checkAcceptanceRecovery(source: AcceptanceSource, observation: AcceptanceRecoveryObservation): AcceptanceRecoveryCheck {
  const issues: string[] = []
  let blocked = false
  if (source.experimentId === observation.experimentId) return { ready: false, blocked: true, issues: ['Recovery must retain a separate execution identity from the original terminal result'] }
  if (new Set(source.nodes.map(node => node.serverId)).size !== source.nodes.length) return { ready: false, blocked: true, issues: ['Original inference nodes are duplicated'] }
  for (const node of source.nodes) {
    const snapshot = observation.snapshots.find(value => value.serverId === node.serverId && value.state === 'ready'
      && value.experimentId === observation.experimentId && value.source.sourceExperimentId === source.experimentId
      && value.source.step === node.step && value.source.commandId === node.commandId && value.source.directory === node.directory
      && value.source.checkpointId === node.checkpointId)
    if (snapshot === undefined) { issues.push(node.serverId + ': original native checkpoint snapshot is not confirmed'); continue }
    if (snapshot.files.some(file => !node.files.some(original => original.name === file.name && original.sha256 === file.sha256
      && original.bytes === file.bytes && original.device === file.device && original.inode === file.inode && original.modified === file.modified))) {
      blocked = true; issues.push(node.serverId + ': recovered checkpoint differs from original file proofs'); continue
    }
    const services = observation.services.filter(service => service.experimentId === observation.experimentId && service.serverId === node.serverId
      && service.state === 'healthy' && !service.released && service.modelPath === snapshot.destination
      && service.modelName === node.modelName && service.external?.url === node.publicUrl && service.external.state === 'reachable')
    if (services.length !== 1) { issues.push(node.serverId + ': exactly one healthy retained public service is required'); continue }
    const service = services[0]!
    const check = observation.verifications.find(value => value.experimentId === observation.experimentId && value.serverId === node.serverId
      && value.deploymentId === observation.deploymentId && value.input.serviceId === service.id && value.commandId === service.commandId
      && value.modelName === node.modelName && value.url === node.publicUrl && value.createdAt >= service.createdAt
      && value.state === 'passed' && value.result?.state === 'passed'
      && value.result.checks.length === 5 && new Set(value.result.checks.map(item => item.name)).size === 5
      && value.result.checks.every(item => item.passed))
    if (check === undefined) issues.push(node.serverId + ': identity, credential rejection, models and real public generation are not all verified')
  }
  if (!observation.goalFinished || !['completed', 'serving'].includes(observation.state)) issues.push('Recovery execution has not reached a stable serving result')
  if (['failed', 'blocked', 'cancelled', 'interrupted'].includes(observation.state)) blocked = true
  return { ready: issues.length === 0, blocked, issues }
}
