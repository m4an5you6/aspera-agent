/** Independent preflight and approved retention records; byte estimates do not approve a policy. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { experimentIdSchema, serverIdSchema, deploymentIdSchema } from './cluster-protocol.ts'
import type { EnvironmentOperationId, ExperimentEnvironmentId } from './managed-environment.ts'
import { experimentStoragePolicySchema } from './storage-policy.ts'
export { experimentStoragePolicySchema, storagePolicyPreserves } from './storage-policy.ts'
export type { ExperimentStoragePolicy } from './storage-policy.ts'
/** One retained-content proposal remains bound to its original request. */
export type StoragePolicyProposalId = string & Branded<'StoragePolicyProposalId'>
/** Model, file and wire readers validate opaque proposal identities. */
export const storagePolicyProposalIdSchema = z.uuid().transform(value => brandString<StoragePolicyProposalId>(value))
const bytes = z.number().int().nonnegative()
/** A proposal cannot approve itself or replace its content on retry. */
export const storagePolicyProposalRequestSchema = z.object({ operationId: storagePolicyProposalIdSchema,
  expectedRevision: bytes, policy: experimentStoragePolicySchema, reason: z.string().min(1).max(4096),
}).strict()
/** Host approval compares the current revision before publishing the policy. */
export const storagePolicyDecisionSchema = z.object({ proposalId: storagePolicyProposalIdSchema, expectedRevision: bytes, approve: z.boolean() }).strict()
/** Independent version-1 proposal and decision history. */
export const storagePolicyRecordSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema,
  proposalId: storagePolicyProposalIdSchema, planRevision: z.number().int().positive(), expectedRevision: bytes, revision: bytes,
  policy: experimentStoragePolicySchema, reason: z.string(), requestHash: deploymentIdSchema,
  state: z.enum(['pending', 'approved', 'rejected']), createdAt: bytes, updatedAt: bytes,
}).strict()
/** Persisted policy history returned by scoped tools and Host interfaces. */
export type StoragePolicyRecord = z.infer<typeof storagePolicyRecordSchema>
/** Read-only environment verification is distinct from environment publication. */
export const environmentPreflightSchema = z.object({ version: z.literal(1), operationId: z.uuid().transform(value => brandString<EnvironmentOperationId>(value)),
  experimentId: experimentIdSchema, serverId: serverIdSchema, environmentId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).transform(value => brandString<ExperimentEnvironmentId>(value)), requirements: z.array(z.string()),
  status: z.enum(['reusable', 'repair-required', 'incompatible', 'unknown']), checkedAt: bytes,
  candidateId: deploymentIdSchema.optional(), sourceHash: deploymentIdSchema.optional(),
  detail: z.string(), additionalBytes: bytes.nullable(),
}).strict()
/** Program-owned preflight evidence; no successful result alone publishes an interpreter. */
export type EnvironmentPreflight = z.infer<typeof environmentPreflightSchema>

/** Current retained strategy and immutable proposals for one assigned node. */
export const storagePolicyStatusSchema = z.object({ current: storagePolicyRecordSchema.nullable(), proposals: z.array(storagePolicyRecordSchema) }).strict()
/** Host policy reads retain the node even before its initial policy exists. */
export const experimentStoragePoliciesSchema = z.array(storagePolicyStatusSchema.extend({ serverId: serverIdSchema }))
/** Per-node strategies and proposed changes visible in the overview. */
export type ExperimentStoragePolicies = z.infer<typeof experimentStoragePoliciesSchema>
