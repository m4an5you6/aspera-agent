/** Independent installation history; fleet v6 and submitted task digests remain unchanged. */
import { z } from 'zod'
import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

/** Installation limits pinned when an experiment is created. */
export interface InstallationPolicy {
  installationTotalTimeoutMs: number
  installationIdleTimeoutMs: number
  installationMaxRetries: number
}
/** Resolve and validate profile limits, including their ordering. */
export const installationPolicySchema = z.object({
  installationTotalTimeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(1_800_000),
  installationIdleTimeoutMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(300_000),
  installationMaxRetries: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(2),
}).refine(value => value.installationIdleTimeoutMs <= value.installationTotalTimeoutMs,
  'installationIdleTimeoutMs must not exceed installationTotalTimeoutMs')

const identity = z.string().regex(/^[a-f0-9]{64}$/)
/** Identity of a single supervised installer launch. */
export type InstallationAttemptId = string & Branded<'InstallationAttemptId'>
/** Identity of a user-started recovery budget. */
export type InstallationRoundId = string & Branded<'InstallationRoundId'>
/** Identity of measured candidate-source evidence. */
export type InstallationSourceProbeId = string & Branded<'InstallationSourceProbeId'>
/** Identity of one recorded download-source change. */
export type InstallationSourceChangeId = string & Branded<'InstallationSourceChangeId'>
/** Validate installer identities at durable and wire reads. */
export const installationAttemptIdSchema = z.uuid().transform(value => brandString<InstallationAttemptId>(value))
/** Validate recovery budget identities at durable reads. */
export const installationRoundIdSchema = z.uuid().transform(value => brandString<InstallationRoundId>(value))
/** Validate source evidence referenced by model tools. */
export const installationSourceProbeIdSchema = z.uuid().transform(value => brandString<InstallationSourceProbeId>(value))
/** Validate source notification identities at durable reads. */
export const installationSourceChangeIdSchema = z.uuid().transform(value => brandString<InstallationSourceChangeId>(value))
const source = z.string().url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
}, 'Download sources must use HTTPS without credentials, query parameters or fragments')
/** Download origins apply to one installation only. */
export const installationSourcesSchema = z.object({ npm: source, nodeHeaders: source })
/** Selected npm registry and Node header distribution directory. */
export type InstallationSources = z.infer<typeof installationSourcesSchema>

/** Measured candidate source, tied to the current installation budget. */
export const sourceProbeSchema = z.object({
  id: installationSourceProbeIdSchema, kind: z.enum(['npm', 'nodeHeaders']), url: source,
  version: z.string(), checkedAt: z.number().int().nonnegative(), available: z.boolean(),
  bytes: z.number().int().nonnegative(), elapsedMs: z.number().nonnegative(), detail: z.string(),
})
/** Candidate probe facts contain no account credentials. */
export type InstallationSourceProbe = z.infer<typeof sourceProbeSchema>

/** Remote identity is read from the supervised installer, never inferred from SSH exit. */
export const installationStatusSchema = z.object({
  version: z.literal(1), attemptId: installationAttemptIdSchema, experimentId: experimentIdSchema, serverId: serverIdSchema,
  digest: identity, archiveHash: identity, state: z.enum(['starting', 'running', 'completed', 'failed', 'cancelled', 'unconfirmed']),
  phase: z.string(), startedAt: z.number(), deadline: z.number(), updatedAt: z.number(), lastProgressAt: z.number(),
  progress: z.object({ bytes: z.number().nonnegative(), packages: z.number().nonnegative(), cpuTicks: z.number().nonnegative(), ioBytes: z.number().nonnegative() }),
  pid: z.number().int().nonnegative(), startTicks: z.string(), bootId: z.string(),
  childPid: z.number().int().nonnegative().optional(), childStartTicks: z.string().optional(),
  exitCode: z.number().int().nullable(), exitConfirmed: z.boolean(), reason: z.string().optional(),
})
/** Durable observations from a specific remote installer attempt. */
export type InstallationStatus = z.infer<typeof installationStatusSchema>
const noticeSchema = z.object({ code: z.enum(['download-slow', 'download-retry']), seq: z.number().int().nonnegative(),
  time: z.number(), reason: z.string(), delivered: z.boolean() })
const attemptSchema = z.object({
  id: installationAttemptIdSchema, directory: z.string().min(1), sources: installationSourcesSchema,
  sessionId: z.string().min(1).transform(value => brandString<SessionId>(value)).optional(),
  toolCallIds: z.array(z.string().min(1).transform(value => brandString<ToolCallId>(value))).default([]),
  startedAt: z.number(), status: installationStatusSchema.optional(), logOffset: z.number().int().nonnegative(),
  notices: z.array(noticeSchema).default([]),
})
const changeSchema = z.object({ id: installationSourceChangeIdSchema, attemptId: installationAttemptIdSchema, previous: installationSourcesSchema,
  next: installationSourcesSchema, reason: z.string().min(1), probe: sourceProbeSchema, changedAt: z.number(), applied: z.boolean() })
const roundSchema = z.object({
  id: installationRoundIdSchema, startedAt: z.number(), deadline: z.number(), finishedAt: z.number().optional(),
  state: z.enum(['pending', 'installing', 'diagnosing', 'verified', 'failed', 'cancelled', 'unconfirmed']),
  attempts: z.array(attemptSchema), sources: installationSourcesSchema,
  probes: z.array(sourceProbeSchema), changes: z.array(changeSchema), detail: z.string().optional(),
})
const nodeSchema = z.object({ serverId: serverIdSchema, rounds: z.array(roundSchema) })
const materialSchema = z.object({ digest: identity, archiveHash: identity, archive: z.string(),
  requirements: z.object({ node: z.string(), pnpm: z.string() }), retainedAt: z.number() })
/** Original material, fixed limits and all explicit recovery rounds. */
export const preparationRecordSchema = z.object({ experimentId: experimentIdSchema,
  policy: installationPolicySchema, material: materialSchema.optional(), nodes: z.array(nodeSchema) })
/** Private installation journal; paths refer to owned, immutable archives. */
export type PreparationRecord = z.infer<typeof preparationRecordSchema>
/** Per-node saved recovery budget and its attempt history. */
export type InstallationRound = z.infer<typeof roundSchema>
/** Public progress projection, excluding private local archive paths. */
export interface InstallationProgress {
  experimentId: PreparationRecord['experimentId']
  serverId: PreparationRecord['nodes'][number]['serverId']
  policy: InstallationPolicy
  digest?: string
  round: InstallationRound
  history: InstallationRound[]
}
/** Independent v1 storage does not rewrite released fleet generations. */
export const preparationStoreSpec = defineDomain({ name: 'aspera_preparation', version: 1, layout: 'per-record', tables: {
  installations: domainTable<PreparationRecord['experimentId'], PreparationRecord>(preparationRecordSchema),
} })
