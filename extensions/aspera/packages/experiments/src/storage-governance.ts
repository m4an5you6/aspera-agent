/** Independent storage, historical-environment and immutable material records. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { experimentIdSchema, serverIdSchema, deploymentIdSchema } from './cluster-protocol.ts'
import type { ExperimentEnvironmentId } from './managed-environment.ts'

/** A program-issued reference never accepts a filesystem path from a tool. */
export type StorageObjectId = string & Branded<'StorageObjectId'>
/** Validate content and candidate references at tool, file and wire readers. */
export const storageObjectIdSchema = z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<StorageObjectId>(value))
/** Durable identity for capacity, borrowing and material operations. */
export type StorageOperationId = string & Branded<'StorageOperationId'>
/** Repeated requests retain their original operation identity. */
export const storageOperationIdSchema = z.uuid().transform(value => brandString<StorageOperationId>(value))
const environmentId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).transform(value => brandString<ExperimentEnvironmentId>(value))
const bytes = z.number().int().nonnegative()
const time = z.number().int().nonnegative()
/** Saved source selection distinguishes incomplete discovery from confirmed missing bytes. */
export const storageReuseSummarySchema = z.object({
  state: z.enum(['discovering', 'verifying', 'verified', 'missing', 'incomplete', 'conflict']),
  complete: z.boolean(), candidateId: storageObjectIdSchema.nullable().optional(), additionalBytes: bytes.optional(),
  entriesScanned: bytes.optional(), checkedAt: time.optional(), diagnostics: z.array(z.string()),
}).strict()
/** Program-owned reuse progress shared by material operations and capacity reports. */
export type StorageReuseSummary = z.infer<typeof storageReuseSummarySchema>
const category = z.enum(['release', 'environment', 'package', 'model', 'dataset', 'temporary', 'checkpoint', 'result', 'log', 'other'])
const relativeDirectory = z.string().min(1).max(4096).refine(value => !value.startsWith('/') && !value.includes('\\')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Use a confined relative directory')
const registeredMount = z.object({ directory: z.string(), filesystem: z.string(), source: z.string() }).strict()
/** Reverification uses a fresh program-issued observation rather than a model-provided path. */
export const verifyStorageRegistrationSchema = z.object({ operationId: storageOperationIdSchema,
  rootId: storageObjectIdSchema, observationId: storageObjectIdSchema }).strict()
/** A current registration preserves the observed filesystem and root directory identities. */
export const storageRegistrationSchema = z.object({ version: z.literal(1), formatVersion: z.literal('0.1.3'),
  serverId: serverIdSchema, directory: z.string(), registrationId: storageObjectIdSchema,
  snapshot: z.object({ mount: registeredMount.extend({ mountId: bytes, readonly: z.boolean() }).strict(), device: z.string(), inode: z.string() }).strict(),
  operationId: storageOperationIdSchema, checkedAt: time,
}).strict()
/** Registration history never rewrites an earlier experiment's placement or release result. */
export const storageRegistrationReceiptSchema = storageRegistrationSchema.extend({ experimentId: experimentIdSchema,
  request: verifyStorageRegistrationSchema, previousRegistration: storageRegistrationSchema.nullable(), legacyObservation: registeredMount.nullable(),
  state: z.enum(['requested', 'verified']), startedAt: time,
}).strict()
/** Agent-selected discovery scope; registered roots authorize directory resolution. */
export const storageInspectionScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account') }).strict(),
  z.object({ kind: z.literal('experiment'), experimentId: experimentIdSchema }).strict(),
  z.object({ kind: z.literal('directory'), rootId: storageObjectIdSchema, relativePath: relativeDirectory }).strict(),
])
/** The runtime supplies this association independently of model-provided operation JSON. */
export const storageEvidenceContextSchema = z.object({ sessionId: z.string().min(1).max(256), planRevision: z.number().int().nonnegative() }).strict()
/** A discovered directory is a candidate, never an integrity or release attestation. */
export const historicalMaterialCandidateSchema = z.object({ id: storageObjectIdSchema, serverId: serverIdSchema,
  sourceExperimentId: experimentIdSchema, runRoot: z.string(), directory: z.string(), rootId: storageObjectIdSchema,
  checkedAt: time, detail: z.string() }).strict()

/** File observations distinguish a hidden sandbox directory from absent remote content. */
export const historicalEnvironmentCandidateSchema = z.object({ id: storageObjectIdSchema, sourceExperimentId: experimentIdSchema,
  directory: z.string(), python: z.string(), namespaceRoot: z.string(), runRoot: z.string(),
  visibility: z.enum(['sandbox-hidden', 'readable', 'unreadable', 'missing', 'unscanned']),
  packages: bytes, allocatedBytes: bytes.nullable(), reusable: z.boolean().nullable(), detail: z.string(),
  distributions: z.array(z.object({ name: z.string(), version: z.string() }).strict()).optional(), metadataComplete: z.boolean().optional(),
}).strict()
/** A server inventory is measured outside experiment confinement, within the login account. */
export const serverStorageCatalogSchema = z.object({ version: z.literal(1), serverId: serverIdSchema, checkedAt: time,
  formatVersion: z.literal('0.1.1').optional(), scope: storageInspectionScopeSchema.optional(),
  materialCandidates: z.array(historicalMaterialCandidateSchema).optional(),
  complete: z.boolean(), cursor: z.string().optional(), entriesScanned: bytes,
  volumes: z.array(z.object({ id: storageObjectIdSchema, directory: z.string(), filesystem: z.string(), source: z.string(),
    capacityBytes: bytes, availableBytes: bytes, accountWritable: z.boolean().nullable(), sandboxWritable: z.boolean().nullable(),
    measuredBytes: bytes, unattributedBytes: bytes,
    categories: z.array(z.object({ kind: category, logicalBytes: bytes, allocatedBytes: bytes, files: bytes }).strict()),
  }).strict()),
  roots: z.array(z.object({ id: storageObjectIdSchema, directory: z.string(), confirmed: z.boolean(), detail: z.string().optional(),
    observationId: storageObjectIdSchema.optional(), registrationId: storageObjectIdSchema.optional(),
    observedMount: registeredMount.optional(), previousMount: registeredMount.optional() }).strict()),
  historicalEnvironments: z.array(historicalEnvironmentCandidateSchema), diagnostics: z.array(z.string()),
}).strict()
/** Complete or explicitly bounded server-side observations. */
export type ServerStorageCatalog = z.infer<typeof serverStorageCatalogSchema>

/** An immutable view of a released experiment's existing interpreter and packages. */
export const borrowedEnvironmentSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  registrationId: storageObjectIdSchema.optional(),
  deploymentId: deploymentIdSchema, environmentId, operationId: storageOperationIdSchema, candidateId: storageObjectIdSchema,
  mode: z.literal('borrowed-readonly'), sourceExperimentId: experimentIdSchema,
  sourceRunRoot: z.string(), directory: z.string(), python: z.string(), pythonVersion: z.string(), pythonAbi: z.string(),
  sourceHash: deploymentIdSchema, files: z.array(z.object({ path: z.string(), hash: deploymentIdSchema, size: bytes, mtimeNs: z.string(), ctimeNs: z.string() }).strict()),
  links: z.array(z.object({ path: z.string(), target: z.string() }).strict()),
  interpreter: z.object({ path: z.string(), hash: deploymentIdSchema, size: bytes, mtimeNs: z.string(), ctimeNs: z.string() }).strict(),
  volume: z.object({ directory: z.string(), filesystem: z.string(), source: z.string() }).strict(),
  requirements: z.array(z.string()), modules: z.array(z.string()), cuda: z.boolean(),
  verified: z.literal(true), checkedAt: time, lease: z.string(), readonlyPaths: z.array(z.string()).min(1),
}).strict()
/** Historical bindings do not rewrite the original managed-environment manifest. */
export type BorrowedEnvironment = z.infer<typeof borrowedEnvironmentSchema>
/** Tool results retain snapshot identity without repeating every package file in the Session. */
export const borrowedEnvironmentSummarySchema = borrowedEnvironmentSchema.omit({ files: true }).extend({ fileCount: bytes })

/** Tool requirements are checked against actual manifests and saved dependency plans. */
export const materialSourceSelectionSchema = z.object({ materialId: storageObjectIdSchema,
  verificationOperationId: storageOperationIdSchema, mode: z.enum(['readonly', 'copy']) }).strict()
/** Capacity uses explicitly selected verification receipts, independent of inspection order. */
export const assessExperimentStorageSchema = z.object({ operationId: storageOperationIdSchema,
  mode: z.enum(['preview', 'commit']).optional(), policyRevision: bytes.optional(),
  materialIds: z.array(storageObjectIdSchema).max(128).default([]), environmentId: environmentId.prefault('training'),
  materialSources: z.array(materialSourceSelectionSchema).max(128).optional(),
  requirements: z.array(z.string().min(1).max(4096)).max(512).default([]),
  outputBytes: bytes, checkpointBytes: bytes, cursor: z.string().optional(),
  environmentEstimate: z.object({ peakBytes: bytes.positive(), basis: z.string().min(1).max(4096) }).strict().optional(),
  allowEnvironmentFallback: z.boolean().optional(),
  assessmentScope: z.enum(['declared', 'experiment']).optional(),
  materialRequirements: z.object({ planRevision: z.number().int().positive(), complete: z.boolean(),
    materials: z.array(z.object({ kind: z.enum(['model', 'dataset']), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
      revision: z.string().regex(/^[a-f0-9]{40}$/), files: z.array(relativeDirectory).min(1).optional(),
      materialId: storageObjectIdSchema.optional() }).strict()).max(128) }).strict().optional(),
}).strict()
/** Capacity readiness applies only to the declared scope and explicitly bound material requirements. */
export const storageCoverageSchema = z.object({ scope: z.enum(['declared', 'experiment']), complete: z.boolean(),
  coveredMaterialIds: z.array(storageObjectIdSchema), unresolved: z.array(z.string()), planRevision: z.number().int().positive().optional() }).strict()
/** Per-mount capacity result; unknown estimates never become a zero-byte success. */
export const experimentStoragePlanSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  mode: z.enum(['preview', 'commit']).optional(), policyRevision: bytes.optional(), capacityBasis: z.enum(['estimated', 'verified', 'unknown']).optional(),
  operationId: storageOperationIdSchema, requestHash: deploymentIdSchema, checkedAt: time,
  state: z.enum(['ready', 'insufficient', 'requirements-pending']),
  environmentId, requirements: z.array(z.string()), materialIds: z.array(storageObjectIdSchema),
  declaredOutputBytes: bytes.optional(), declaredCheckpointBytes: bytes.optional(),
  environmentEstimate: assessExperimentStorageSchema.shape.environmentEstimate, allowEnvironmentFallback: z.boolean().optional(),
  formatVersion: z.enum(['0.1.0', '0.1.1', '0.1.2']).optional(), coverage: storageCoverageSchema.optional(),
  materialSources: assessExperimentStorageSchema.shape.materialSources,
  materialEstimates: z.array(z.object({ materialId: storageObjectIdSchema, mode: z.enum(['readonly', 'copy', 'default-assets']),
    totalBytes: bytes, verifiedReusableBytes: bytes, confirmedMissingBytes: bytes, unknownBytes: bytes, newPeakBytes: bytes.nullable() }).strict()).optional(),
  assessmentScope: assessExperimentStorageSchema.shape.assessmentScope, materialRequirements: assessExperimentStorageSchema.shape.materialRequirements,
  peakSafetyFactor: z.number().min(1).max(10).optional(), reuse: storageReuseSummarySchema.optional(),
  fallbackAssessment: z.object({ systemShortfallBytes: bytes, remainingDataShortfallBytes: bytes, applied: z.boolean() }).strict().optional(),
  volumes: z.array(z.object({ directory: z.string(), availableBytes: bytes, reservedBytes: bytes, requiredBytes: bytes.nullable(),
    missingBytes: bytes, environmentBytes: bytes.nullable(), outputBytes: bytes, checkpointBytes: bytes, safetyBytes: bytes,
    capacityBytes: bytes.optional(), filesystem: z.string().optional(), source: z.string().optional(), device: z.string().optional(),
    newPeakBytes: bytes.nullable().optional(), shortfallBytes: bytes.nullable().optional(),
  }).strict()), detail: z.string(),
}).strict()
/** Saved budget returned by the Host and Agent tool. */
export type ExperimentStoragePlan = z.infer<typeof experimentStoragePlanSchema>

/** Independent purpose placement leaves the submitted run and material identities unchanged. */
export const storageArrangementSchema = z.object({ version: z.literal(1), formatVersion: z.literal('0.1.0'),
  experimentId: experimentIdSchema, serverId: serverIdSchema, controlRoot: z.string().startsWith('/'),
  dataWorkspace: z.string().startsWith('/'), environmentWorkspace: z.string().startsWith('/'),
  environmentNamespace: z.string().startsWith('/'), appliedAt: time, eventId: storageObjectIdSchema,
  reason: z.string(), estimatedPeakBytes: bytes,
  volume: z.object({ directory: z.string(), filesystem: z.string(), source: z.string(), device: z.string() }).strict(),
  history: z.array(z.object({ time, action: z.enum(['data-preferred', 'system-fallback']), reason: z.string() }).strict()).min(1),
}).strict()
/** Program-owned environment location and its once-only fallback event. */
export type StorageArrangement = z.infer<typeof storageArrangementSchema>

/** Model and dataset requests require an immutable provider revision. */
export const inspectExperimentMaterialsSchema = z.object({ kind: z.enum(['model', 'dataset']), provider: z.enum(['huggingface', 'modelscope']),
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), revision: z.string().regex(/^[a-f0-9]{40}$/),
  files: z.array(z.string().min(1).max(2048)).max(4096).optional(),
  mirror: z.string().url().optional(),
  metadataSource: z.enum(['auto', 'node', 'host', 'cache']).optional(), reuseCandidateId: storageObjectIdSchema.optional(),
}).strict()
/** Program-observed file identities bind mirrors to the canonical revision. */
export const experimentMaterialSchema = z.object({ version: z.literal(1), id: storageObjectIdSchema, serverId: serverIdSchema,
  cacheFiles: z.record(z.string(), z.string()).optional(),
  registrationId: storageObjectIdSchema.optional(),
  formatVersion: z.literal('0.1.2').optional(), unknownBytes: bytes.optional(),
  experimentId: experimentIdSchema.optional(), verificationOperationId: storageOperationIdSchema.optional(), sourceHash: deploymentIdSchema.optional(),
  kind: z.enum(['model', 'dataset']), provider: z.enum(['huggingface', 'modelscope']), repository: z.string(), revision: z.string(),
  files: z.array(z.object({ path: z.string(), bytes, hash: z.string(), algorithm: z.enum(['sha256', 'git-sha1']), url: z.string().url(),
    mtimeNs: z.string().optional(), ctimeNs: z.string().optional() }).strict()).min(1),
  directory: z.string(), totalBytes: bytes, missingBytes: bytes, verifiedBytes: bytes, checkedAt: time,
  retainedPartialBytes: bytes.optional(),
  volume: z.object({ directory: z.string(), filesystem: z.string(), source: z.string() }).strict(),
  state: z.enum(['inspected', 'downloading', 'ready', 'blocked']), detail: z.string().optional(),
  historicalSource: z.object({ sourceExperimentId: experimentIdSchema, runRoot: z.string(), directory: z.string() }).strict().optional(),
  reuseCandidateId: storageObjectIdSchema.optional(),
}).strict()
/** Canonical material identity and the actual local acquisition state. */
export type ExperimentMaterial = z.infer<typeof experimentMaterialSchema>
/** Inventory pages omit the canonical per-file manifest while retaining its content identity. */
export const experimentMaterialSummarySchema = experimentMaterialSchema.omit({ files: true }).extend({ fileCount: bytes })
/** Acquisition and recovery keep one content-bound operation and deadline. */
export const prepareExperimentMaterialsSchema = z.object({ operationId: storageOperationIdSchema, materialId: storageObjectIdSchema,
  action: z.enum(['acquire', 'verify', 'recover']).default('acquire'), budgetId: storageOperationIdSchema.optional(),
  reuseCandidateId: storageObjectIdSchema.optional(),
}).strict().refine(value => value.action !== 'acquire' || value.budgetId !== undefined, 'Acquisition requires a capacity budget')
/** Node-owned material progress, independent of the tool connection. */
export const materialOperationSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  verificationStatus: z.enum(['complete', 'partial', 'none', 'unknown']).optional(), materialReady: z.boolean().optional(),
  missingDownloadBytes: bytes.optional(), unknownBytes: bytes.optional(),
  formatVersion: z.enum(['0.1.1', '0.1.2']).optional(), verifiedFiles: bytes.optional(), verifiedBytes: bytes.optional(),
  sourceHash: deploymentIdSchema.optional(), verificationComplete: z.boolean().optional(),
  fileResults: z.array(z.object({ path: z.string(), bytes, state: z.enum(['verified', 'missing', 'mismatch', 'unreadable', 'unverified']), detail: z.string().optional() }).strict()).optional(),
  operationId: storageOperationIdSchema, materialId: storageObjectIdSchema, requestHash: deploymentIdSchema,
  commandId: z.string().optional(),
  action: z.enum(['acquire', 'verify']).optional(),
  stage: z.enum(['checking', 'discovering', 'waiting-transfer', 'reusing', 'downloading', 'verifying', 'publishing', 'waiting-exit', 'completed', 'blocked']).optional(),
  processState: z.enum(['not-started', 'running', 'exited', 'unknown']).optional(),
  state: z.enum(['requested', 'running', 'completed', 'blocked', 'unknown']), startedAt: time, deadline: time, updatedAt: time,
  downloadedBytes: bytes, reusedBytes: bytes, exitConfirmed: z.boolean(), admissionReleased: z.boolean(),
  stopReason: z.enum(['timeout', 'cancelled', 'controller-stopping']).optional(), exitCode: z.number().int().nullable().optional(),
  copiedBytes: bytes.optional(), copyReasons: z.array(z.string()).optional(),
  detail: z.string().optional(), settlementError: z.string().optional(), material: experimentMaterialSchema.optional(), reuse: storageReuseSummarySchema.optional(),
}).strict()
/** Material waiting returns only independently confirmed termination. */
export type MaterialOperation = z.infer<typeof materialOperationSchema>
/** Current experiment bindings to server-owned model and dataset content. */
export const experimentMaterialBindingSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  formatVersion: z.literal('0.1.2').optional(),
  materialId: storageObjectIdSchema, directory: z.string(), manifestHash: deploymentIdSchema, readonly: z.literal(true), checkedAt: time,
}).strict()
