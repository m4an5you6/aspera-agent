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
const category = z.enum(['release', 'environment', 'package', 'model', 'dataset', 'temporary', 'checkpoint', 'result', 'log', 'other'])

/** File observations distinguish a hidden sandbox directory from absent remote content. */
export const historicalEnvironmentCandidateSchema = z.object({ id: storageObjectIdSchema, sourceExperimentId: experimentIdSchema,
  directory: z.string(), python: z.string(), namespaceRoot: z.string(), runRoot: z.string(),
  visibility: z.enum(['sandbox-hidden', 'readable', 'unreadable', 'missing', 'unscanned']),
  packages: bytes, allocatedBytes: bytes.nullable(), reusable: z.boolean().nullable(), detail: z.string(),
  distributions: z.array(z.object({ name: z.string(), version: z.string() }).strict()).optional(), metadataComplete: z.boolean().optional(),
}).strict()
/** A server inventory is measured outside experiment confinement, within the login account. */
export const serverStorageCatalogSchema = z.object({ version: z.literal(1), serverId: serverIdSchema, checkedAt: time,
  complete: z.boolean(), cursor: z.string().optional(), entriesScanned: bytes,
  volumes: z.array(z.object({ id: storageObjectIdSchema, directory: z.string(), filesystem: z.string(), source: z.string(),
    capacityBytes: bytes, availableBytes: bytes, accountWritable: z.boolean().nullable(), sandboxWritable: z.boolean().nullable(),
    measuredBytes: bytes, unattributedBytes: bytes,
    categories: z.array(z.object({ kind: category, logicalBytes: bytes, allocatedBytes: bytes, files: bytes }).strict()),
  }).strict()),
  roots: z.array(z.object({ id: storageObjectIdSchema, directory: z.string(), confirmed: z.boolean(), detail: z.string().optional() }).strict()),
  historicalEnvironments: z.array(historicalEnvironmentCandidateSchema), diagnostics: z.array(z.string()),
}).strict()
/** Complete or explicitly bounded server-side observations. */
export type ServerStorageCatalog = z.infer<typeof serverStorageCatalogSchema>

/** An immutable view of a released experiment's existing interpreter and packages. */
export const borrowedEnvironmentSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
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
export const assessExperimentStorageSchema = z.object({ operationId: storageOperationIdSchema,
  materialIds: z.array(storageObjectIdSchema).max(128).default([]), environmentId: environmentId.prefault('training'),
  requirements: z.array(z.string().min(1).max(4096)).max(512).default([]),
  outputBytes: bytes, checkpointBytes: bytes, cursor: z.string().optional(),
  environmentEstimate: z.object({ peakBytes: bytes.positive(), basis: z.string().min(1).max(4096) }).strict().optional(),
  allowEnvironmentFallback: z.boolean().optional(),
}).strict()
/** Per-mount capacity result; unknown estimates never become a zero-byte success. */
export const experimentStoragePlanSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  operationId: storageOperationIdSchema, requestHash: deploymentIdSchema, checkedAt: time,
  state: z.enum(['ready', 'insufficient', 'requirements-pending']),
  environmentId, requirements: z.array(z.string()), materialIds: z.array(storageObjectIdSchema),
  declaredOutputBytes: bytes.optional(), declaredCheckpointBytes: bytes.optional(),
  environmentEstimate: assessExperimentStorageSchema.shape.environmentEstimate, allowEnvironmentFallback: z.boolean().optional(),
  formatVersion: z.literal('0.1.0').optional(),
  peakSafetyFactor: z.number().min(1).max(10).optional(),
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
}).strict()
/** Program-observed file identities bind mirrors to the canonical revision. */
export const experimentMaterialSchema = z.object({ version: z.literal(1), id: storageObjectIdSchema, serverId: serverIdSchema,
  kind: z.enum(['model', 'dataset']), provider: z.enum(['huggingface', 'modelscope']), repository: z.string(), revision: z.string(),
  files: z.array(z.object({ path: z.string(), bytes, hash: z.string(), algorithm: z.enum(['sha256', 'git-sha1']), url: z.string().url(),
    mtimeNs: z.string().optional(), ctimeNs: z.string().optional() }).strict()).min(1),
  directory: z.string(), totalBytes: bytes, missingBytes: bytes, verifiedBytes: bytes, checkedAt: time,
  retainedPartialBytes: bytes.optional(),
  volume: z.object({ directory: z.string(), filesystem: z.string(), source: z.string() }).strict(),
  state: z.enum(['inspected', 'downloading', 'ready', 'blocked']), detail: z.string().optional(),
  historicalSource: z.object({ sourceExperimentId: experimentIdSchema, runRoot: z.string(), directory: z.string() }).strict().optional(),
}).strict()
/** Canonical material identity and the actual local acquisition state. */
export type ExperimentMaterial = z.infer<typeof experimentMaterialSchema>
/** Inventory pages omit the canonical per-file manifest while retaining its content identity. */
export const experimentMaterialSummarySchema = experimentMaterialSchema.omit({ files: true }).extend({ fileCount: bytes })
/** Acquisition and recovery keep one content-bound operation and deadline. */
export const prepareExperimentMaterialsSchema = z.object({ operationId: storageOperationIdSchema, materialId: storageObjectIdSchema,
  action: z.enum(['acquire', 'verify', 'recover']).default('acquire'), budgetId: storageOperationIdSchema,
}).strict()
/** Node-owned material progress, independent of the tool connection. */
export const materialOperationSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  operationId: storageOperationIdSchema, materialId: storageObjectIdSchema, requestHash: deploymentIdSchema,
  commandId: z.string().optional(),
  action: z.enum(['acquire', 'verify']).optional(),
  stage: z.enum(['checking', 'waiting-transfer', 'reusing', 'downloading', 'verifying', 'publishing', 'waiting-exit', 'completed', 'blocked']).optional(),
  processState: z.enum(['not-started', 'running', 'exited', 'unknown']).optional(),
  state: z.enum(['requested', 'running', 'completed', 'blocked', 'unknown']), startedAt: time, deadline: time, updatedAt: time,
  downloadedBytes: bytes, reusedBytes: bytes, exitConfirmed: z.boolean(), admissionReleased: z.boolean(),
  stopReason: z.enum(['timeout', 'cancelled', 'controller-stopping']).optional(), exitCode: z.number().int().nullable().optional(),
  copiedBytes: bytes.optional(), copyReasons: z.array(z.string()).optional(),
  detail: z.string().optional(), material: experimentMaterialSchema.optional(),
}).strict()
/** Material waiting returns only independently confirmed termination. */
export type MaterialOperation = z.infer<typeof materialOperationSchema>
/** Current experiment bindings to server-owned model and dataset content. */
export const experimentMaterialBindingSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  materialId: storageObjectIdSchema, directory: z.string(), manifestHash: deploymentIdSchema, readonly: z.literal(true), checkedAt: time,
}).strict()
