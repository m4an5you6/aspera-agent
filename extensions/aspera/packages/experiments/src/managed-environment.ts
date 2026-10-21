/** Independent version-1 environment and package-reuse records; submissions and Sessions stay fixed. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { experimentIdSchema, serverIdSchema, deploymentIdSchema } from './cluster-protocol.ts'
import { borrowedEnvironmentSummarySchema, serverStorageCatalogSchema, experimentStoragePlanSchema, experimentMaterialSummarySchema, materialOperationSchema, storageArrangementSchema } from './storage-governance.ts'

/** An environment name belongs to one experiment and node. */
export type ExperimentEnvironmentId = string & Branded<'ExperimentEnvironmentId'>
/** Boundary validation for environment names; names are never host paths. */
export const experimentEnvironmentIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
  .transform(value => brandString<ExperimentEnvironmentId>(value))
/** One retriable, content-bound environment operation. */
export type EnvironmentOperationId = string & Branded<'EnvironmentOperationId'>
/** Environment operation identities survive lost tool responses. */
export const environmentOperationIdSchema = z.uuid().transform(value => brandString<EnvironmentOperationId>(value))
const relativePath = z.string().min(1).max(2048).refine(value => !value.startsWith('/')
  && !value.split('/').some(part => part === '..' || part === '.' || part === '') && !['\\', '\0', '\r', '\n'].some(char => value.includes(char)), 'Expected a confined relative path')
/** Model requests select dependencies and registered environments, never controller paths or PIDs. */
export const prepareExperimentEnvironmentSchema = z.object({
  environmentId: experimentEnvironmentIdSchema, operationId: environmentOperationIdSchema,
  action: z.enum(['create', 'install', 'verify', 'make-writable']),
  purpose: z.string().min(1).max(1000).optional(),
  directory: relativePath.optional(), requirements: z.array(z.string().min(1).max(4096)).max(512).default([]),
  modules: z.array(z.string().regex(/^[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*$/)).max(64).default([]),
  files: z.array(relativePath).max(128).default([]), requireCuda: z.boolean().default(false),
  reuseCandidateId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
/** A checked model operation, without account credentials. */
export type PrepareExperimentEnvironment = z.infer<typeof prepareExperimentEnvironmentSchema>

/** Persisted reuse decisions precede dependency acquisition and retain measured results. */
export const environmentReusePlanSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  operationId: environmentOperationIdSchema, environmentId: experimentEnvironmentIdSchema, requirementsHash: deploymentIdSchema,
  pythonAbi: z.string(), uvVersion: z.string(), lockHash: deploymentIdSchema.optional(),
  stage: z.enum(['checking', 'reusing', 'downloading', 'installing', 'verifying', 'completed', 'blocked', 'recovering']),
  packages: z.array(z.object({ name: z.string(), version: z.string(), wheelHash: deploymentIdSchema.optional(),
    decision: z.enum(['current', 'shared', 'material', 'legacy', 'download']), reason: z.string().optional(), bytes: z.number().int().nonnegative().optional(),
  }).strict()), downloadBytes: z.number().int().nonnegative(), reusedBytes: z.number().int().nonnegative(),
  estimatedPeakBytes: z.number().int().nonnegative(), addedBytes: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  installerTemporaryBytes: z.number().int().nonnegative().optional(),
  detail: z.string().optional(),
}).strict()
/** One operation's program-owned reuse plan and current installation stage. */
export type EnvironmentReusePlan = z.infer<typeof environmentReusePlanSchema>
/** Startup evidence distinguishes rejection before spawn from an uncertain process outcome. */
export const environmentLaunchSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  operationId: environmentOperationIdSchema, commandId: z.string(), deploymentId: deploymentIdSchema,
  state: z.enum(['prepared', 'starting', 'started', 'not-started', 'exited']), createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(), detail: z.string().optional(),
}).strict()
/** Node-owned startup journal stored independently of existing operation receipts. */
export type EnvironmentLaunch = z.infer<typeof environmentLaunchSchema>

/** Measured linking decisions distinguish actual shared storage from ordinary copies. */
export const environmentSharingSchema = z.object({ hardlinkBytes: z.number().int().nonnegative(), cloneBytes: z.number().int().nonnegative(),
  copyBytes: z.number().int().nonnegative(), logicalBytes: z.number().int().nonnegative(), allocatedBytes: z.number().int().nonnegative(),
  addedBytes: z.number().int().nonnegative(), estimatedCopyBytes: z.number().int().nonnegative(), reasons: z.array(z.string()),
}).strict()
/** Saved linking decisions; reflink savings are estimates unless independently measurable. */
export type EnvironmentSharing = z.infer<typeof environmentSharingSchema>
/** Published package identity includes actual bytes, wheel origin and interpreter compatibility. */
export const managedPackageSchema = z.object({ id: deploymentIdSchema, name: z.string(), version: z.string(),
  wheelHash: deploymentIdSchema, source: z.string(), tags: z.array(z.string()), pythonAbi: z.string(),
  contentHash: deploymentIdSchema, modified: z.boolean(), files: z.array(relativePath),
}).strict()
/** Package records used by registered environment readers. */
export type ManagedPackage = z.infer<typeof managedPackageSchema>
/** Program observations of the real interpreter and imports. */
export const environmentVerificationSchema = z.object({ verified: z.boolean(), checkedAt: z.number().int().nonnegative(),
  python: z.string(), prefix: z.string(), userSiteEnabled: z.boolean(), dependenciesValid: z.boolean(),
  modules: z.array(z.string()), cuda: z.boolean().optional(), detail: z.string().optional(),
}).strict()
/** Version-1 manifest kept outside the Agent-writable workspace. */
export const experimentEnvironmentSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  deploymentId: deploymentIdSchema, environmentId: experimentEnvironmentIdSchema, generation: z.uuid(),
  purpose: z.string(),
  directory: z.string(), python: z.string(), pythonVersion: z.string(), pythonAbi: z.string(), uv: z.string(), uvVersion: z.string(),
  state: z.enum(['creating', 'installing', 'verifying', 'ready', 'blocked']), requirements: z.array(z.string()),
  packages: z.array(managedPackageSchema), privateFiles: z.array(relativePath), sharing: environmentSharingSchema,
  verification: environmentVerificationSchema.optional(), updatedAt: z.number().int().nonnegative(), detail: z.string().optional(),
}).strict()
/** A published environment retains its own interpreter and package metadata. */
export type ExperimentEnvironment = z.infer<typeof experimentEnvironmentSchema>
/** Current-check diagnostics retain mount IDs for explanation, never as reusable authorization. */
export const environmentCleanupDiagnosticSchema = z.object({ path: z.string(), stage: z.string(), detail: z.string(),
  mountId: z.number().int().nonnegative().nullable().optional(), device: z.number().int().nonnegative().optional(),
  expectedMountId: z.number().int().nonnegative().nullable().optional(), expectedDevice: z.number().int().nonnegative().optional(),
}).strict()
/** Private residue stays hidden and holds package references until confirmed deletion. */
export const environmentCleanupSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  operationId: environmentOperationIdSchema, environmentId: experimentEnvironmentIdSchema, generation: z.uuid(),
  state: z.enum(['pending', 'completed', 'blocked']), paths: z.array(z.string()).min(1), packages: z.array(deploymentIdSchema),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), detail: z.string().optional(),
  diagnostic: environmentCleanupDiagnosticSchema.optional(),
}).strict()
/** Independent version-1 temporary cleanup record; original operation receipts remain readable. */
export type EnvironmentCleanup = z.infer<typeof environmentCleanupSchema>
/** Recovery confirms exit and retained generation; a new program verification is still required. */
export const environmentRecoverySchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  operationId: environmentOperationIdSchema, environmentId: experimentEnvironmentIdSchema, sourceReceiptHash: deploymentIdSchema,
  state: z.enum(['verification-required', 'prepare-required']), generation: z.uuid().optional(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), detail: z.string(),
}).strict()
/** Independent version-1 recovery result preserves the failed receipt and its original times. */
export type EnvironmentRecovery = z.infer<typeof environmentRecoverySchema>
/** Structured package collisions bind retry admission to their original program-owned inputs. */
export const environmentFailureSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  operationId: environmentOperationIdSchema, environmentId: experimentEnvironmentIdSchema, requestHash: deploymentIdSchema,
  code: z.enum(['shared-content-conflict', 'unchanged-failure']), contextHash: deploymentIdSchema, requirementsHash: deploymentIdSchema,
  inputRequirementsHash: deploymentIdSchema,
  packages: z.array(deploymentIdSchema).min(1), path: relativePath, detail: z.string(), createdAt: z.number().int().nonnegative(),
  previousOperationId: environmentOperationIdSchema.optional(),
}).strict().refine(value => value.code === 'unchanged-failure'
  ? value.previousOperationId !== undefined && value.previousOperationId !== value.operationId : value.previousOperationId === undefined,
  'Repeated failure must reference a different original operation')
/** Independent version-1 failure evidence preserves prior receipts across retry identities. */
export type EnvironmentFailure = z.infer<typeof environmentFailureSchema>
/** Content-bound receipts distinguish process exit from an uncertain transport result. */
export const environmentOperationSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  operationId: environmentOperationIdSchema, environmentId: experimentEnvironmentIdSchema, requestHash: deploymentIdSchema,
  action: prepareExperimentEnvironmentSchema.shape.action, state: z.enum(['requested', 'running', 'completed', 'blocked']),
  commandId: z.string(), startedAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  exitConfirmed: z.boolean(), exitCode: z.number().int().nullable(), detail: z.string().optional(), environment: experimentEnvironmentSchema.optional(),
  cleanup: environmentCleanupSchema.optional(), recovery: environmentRecoverySchema.optional(),
  failure: environmentFailureSchema.optional(),
  borrowed: borrowedEnvironmentSummarySchema.optional(),
}).strict().refine(value => value.failure === undefined || value.failure.experimentId === value.experimentId
  && value.failure.serverId === value.serverId && value.failure.operationId === value.operationId
  && value.failure.environmentId === value.environmentId && value.failure.requestHash === value.requestHash,
  'Failure evidence belongs to another operation')
/** Durable operation progress returned by tools and recovery reads. */
export type EnvironmentOperation = z.infer<typeof environmentOperationSchema>

/** Original node deadline and independently observed process exit; installer receipts stay immutable. */
export const environmentRuntimeSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  operationId: environmentOperationIdSchema, environmentId: experimentEnvironmentIdSchema, deploymentId: deploymentIdSchema,
  startedAt: z.number().int().nonnegative(), deadline: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  stopReason: z.enum(['timeout', 'cancelled', 'controller-stopping']).optional(),
  exitConfirmed: z.boolean(), exitCode: z.number().int().nullable(), admissionReleased: z.boolean(), detail: z.string().optional(),
}).strict()
/** Independent version-1 installation lifetime record. */
export type EnvironmentRuntime = z.infer<typeof environmentRuntimeSchema>
/** Effective create requirements preserve direct constraints without changing the original request. */
export const environmentRequirementsSchema = z.object({ version: z.literal(1), requestHash: deploymentIdSchema,
  requirements: z.array(z.string().min(1).max(4096)) }).strict()
/** Program-resolved requirements persisted beside the original receipt. */
export type EnvironmentRequirements = z.infer<typeof environmentRequirementsSchema>
/** Lightweight authenticated observation of one operation, without scanning installed packages. */
export const environmentOperationStatusSchema = z.object({ experimentId: experimentIdSchema, serverId: serverIdSchema,
  operationId: environmentOperationIdSchema, state: z.enum(['running', 'completed', 'failed', 'unknown']),
  operation: environmentOperationSchema.optional(), runtime: environmentRuntimeSchema.optional(), launch: environmentLaunchSchema.optional(),
  reusePlan: environmentReusePlanSchema.optional(), checkedAt: z.number().int().nonnegative(), elapsedMs: z.number().int().nonnegative(),
  processState: z.enum(['not-started', 'running', 'exited', 'unknown']), admissionReleased: z.boolean(), detail: z.string().optional(),
}).strict()
/** Live status and the final result returned by the installing tool. */
export type EnvironmentOperationStatus = z.infer<typeof environmentOperationStatusSchema>

/** Old files remain candidates until source identity and completeness can be established. */
export const legacyEnvironmentCandidateSchema = z.object({ directory: z.string(), name: z.string(), version: z.string(),
  kind: z.enum(['wheel', 'installed']), bytes: z.number().int().nonnegative(), reusable: z.boolean(), reason: z.string(),
}).strict()
/** A node's measured storage and registered environments, independent of experiment success. */
export const environmentStorageNodeSchema = z.object({ serverId: serverIdSchema, name: z.string(), checkedAt: z.number().int().nonnegative(),
  source: z.enum(['remote', 'ssh', 'local']), availableBytes: z.number().int().nonnegative(), capacityBytes: z.number().int().nonnegative(),
  workspaceBytes: z.number().int().nonnegative(), sharedBytes: z.number().int().nonnegative(), reclaimableBytes: z.number().int().nonnegative(),
  environments: z.array(experimentEnvironmentSchema), legacy: z.array(legacyEnvironmentCandidateSchema),
  reusePlans: z.array(environmentReusePlanSchema).optional(),
  operations: z.array(environmentOperationStatusSchema).optional(),
  cleanups: z.array(environmentCleanupSchema).optional(), recoveries: z.array(environmentRecoverySchema).optional(),
  materials: z.array(z.object({ name: z.string(), version: z.string(), wheelHash: deploymentIdSchema, source: z.string(),
    bytes: z.number().int().nonnegative(), cachedAt: z.number().int().nonnegative(), available: z.boolean(),
  }).strict()).optional(),
  error: z.string().optional(), complete: z.boolean(),
  catalog: serverStorageCatalogSchema.optional(), borrowings: z.array(borrowedEnvironmentSummarySchema).optional(),
  storagePlan: experimentStoragePlanSchema.optional(),
  arrangement: storageArrangementSchema.optional(),
  assets: z.array(experimentMaterialSummarySchema).optional(), materialOperations: z.array(materialOperationSchema).optional(),
}).strict()
/** Read-only per-node space observations; local copies retain the original check time. */
export type EnvironmentStorageNode = z.infer<typeof environmentStorageNodeSchema>
/** Version-1 Host copy does not modify fleet generation 6 or the submitted experiment. */
export const experimentStorageUsageSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema,
  nodes: z.array(environmentStorageNodeSchema), updatedAt: z.number().int().nonnegative(),
}).strict()
/** Experiment-wide storage observations and environment status. */
export type ExperimentStorageUsage = z.infer<typeof experimentStorageUsageSchema>
/** Program-generated cleanup entries never expose an arbitrary deletion path input. */
export const environmentCacheCandidateSchema = z.object({ id: z.string(), kind: z.enum(['package', 'temporary', 'material', 'historical-temporary', 'historical-material']),
  bytes: z.number().int().nonnegative(), reason: z.string(),
  sourceExperimentId: experimentIdSchema.optional(),
}).strict()
/** Cleanup is bound to the current reference and source snapshot. */
export const experimentCachePreviewSchema = z.object({ experimentId: experimentIdSchema, nodes: z.array(z.object({ serverId: serverIdSchema,
  checkedAt: z.number().int().nonnegative(), fingerprint: deploymentIdSchema, candidates: z.array(environmentCacheCandidateSchema),
  eligible: z.boolean(), detail: z.string().optional(),
}).strict()) }).strict()
/** Read-only preview of safe, owned cleanup candidates. */
export type ExperimentCachePreview = z.infer<typeof experimentCachePreviewSchema>
/** Only previewed nodes and fingerprints are accepted for cleanup. */
export const experimentCacheCleanupSchema = z.object({ experimentId: experimentIdSchema, operationId: environmentOperationIdSchema,
  nodes: z.array(z.object({ serverId: serverIdSchema, fingerprint: deploymentIdSchema, candidateIds: z.array(z.string()).min(1).optional() }).strict()).min(1).max(128),
}).strict()
/** Explicit cleanup request using registered candidate snapshots. */
export type ExperimentCacheCleanup = z.infer<typeof experimentCacheCleanupSchema>
/** Partial cleanup results retain errors without changing training outcomes. */
export const experimentCacheResultSchema = z.object({ experimentId: experimentIdSchema, operationId: environmentOperationIdSchema,
  nodes: z.array(z.object({ serverId: serverIdSchema, state: z.enum(['completed', 'blocked']), reclaimedBytes: z.number().int().nonnegative(),
  checkedAt: z.number().int().nonnegative(), detail: z.string().optional() }).strict()),
}).strict()
/** Per-node cleanup results, independently retriable. */
export type ExperimentCacheResult = z.infer<typeof experimentCacheResultSchema>
