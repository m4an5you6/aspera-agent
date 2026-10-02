/** Versioned cluster requests and durable experiment receipts. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'
import { remotePathSchema, storagePlacementSchema, storagePreferenceSchema, serverInventorySchema } from './storage-protocol.ts'

/** Stable configured server identity, independent of list order and address edits. */
export type ExperimentServerId = string & Branded<'ExperimentServerId'>
/** One immutable experiment submission; retries retain this identity. */
export type ExperimentId = string & Branded<'ExperimentId'>
/** A managed inference process registered independently of an Agent turn. */
export type InferenceServiceId = string & Branded<'InferenceServiceId'>
/** Persistent service identity. */
export const serviceIdSchema = z.uuid().transform(value => brandString<InferenceServiceId>(value))
/** Released v1 limits, retained only for compatibility readers. */
export const budgetSchema = z.object({
  maxRuntimeSeconds: z.number().int().min(1).max(Math.floor(2_147_483_647 / 1000)),
  maxCommands: z.number().int().min(1).max(100_000),
  maxGoalRounds: z.number().int().min(1).max(10_000),
  maxServiceSeconds: z.number().int().min(1).max(Math.floor(2_147_483_647 / 1000)),
}).strict()
/** Resource and Agent limits, separate from financial provider costs. */
export type ExperimentBudget = z.infer<typeof budgetSchema>
/** Execution policy for new submissions; operation timeouts belong to deployment settings. */
export const strategySchema = z.object({ mode: z.enum(['semi', 'automatic']), coordinator: z.literal('single-agent') }).strict()
/** Captured deployment and RSI inputs. */
const versionsV2Schema = z.object({
  dsh: z.literal('0.2.0-rc.2'), extension: z.literal('0.2.0'),
  harness: z.string().min(1), data: z.array(z.string()), model: z.string().optional(),
}).strict()

/** Server ids accepted from settings and the receiver. */
export const serverIdSchema = z.uuid().transform(value => brandString<ExperimentServerId>(value))
/** Experiment ids accepted from browser and receiver requests. */
export const experimentIdSchema = z.uuid().transform(value => brandString<ExperimentId>(value))
/** Fixed source content digest. */
export const deploymentIdSchema = z.string().regex(/^[a-f0-9]{64}$/)

/** Non-secret connection and execution settings captured at submission. */
export const legacyClusterServerSchema = z.object({
  id: serverIdSchema,
  name: z.string().trim().min(1).max(100),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/),
  username: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/),
  sshPort: z.number().int().min(1).max(65535),
  remotePort: z.number().int().min(1).max(65534),
  remoteRoot: z.string().regex(/^\/[a-zA-Z0-9_./-]+$/).refine(path => !path.split('/').some(part => part === '.' || part === '..') && path.replaceAll('/', '') !== ''),
  trainingAddress: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/).optional(),
  authMode: z.enum(['password', 'key']),
  passwordRef: z.string().optional(),
  identityFile: z.string().optional(),
  knownHostsFile: z.string().optional(),
}).strict()
/** Resolved deployment address; v3 directories accompany the immutable submission. */
export const clusterServerSchema = legacyClusterServerSchema.extend({
  remoteRoot: remotePathSchema, storagePlacement: storagePlacementSchema.optional(),
})
/** Resolved server definition; credentials are resolved separately. */
export type ClusterServer = z.infer<typeof clusterServerSchema>
/** Registry preferences can be saved before the first SSH connection. Legacy roots retain their layout. */
export const serverSettingsSchema = legacyClusterServerSchema.partial({ remoteRoot: true }).extend({
  remoteRoot: remotePathSchema.optional(), storagePreference: storagePreferenceSchema.optional(),
  storagePlacement: storagePlacementSchema.optional(),
})
/** User configuration, distinct from a resolved deployment. */
export type ServerSettings = z.infer<typeof serverSettingsSchema>

/** CUDA and sandbox facts checked during server preparation. */
const legacyClusterNodeSchema = z.object({
  server: legacyClusterServerSchema,
  devicePaths: z.array(z.string().regex(/^\/dev\/nvidia[a-zA-Z0-9_/-]*$/)).min(1),
  backendPath: z.string().startsWith('/'),
  hiddenPaths: z.array(z.string().startsWith('/')),
  gpuInfo: z.string(),
}).strict()
/** Resolved node facts used by the current runtime. */
export const clusterNodeSchema = legacyClusterNodeSchema.extend({ server: clusterServerSchema })
/** One prepared member of a submitted server group. */
export type ClusterNode = z.infer<typeof clusterNodeSchema>

/** Inputs committed remotely before a queued receipt is returned. */
const legacySubmissionObject = z.object({
  protocol: z.literal(1),
  experimentId: experimentIdSchema,
  deploymentId: deploymentIdSchema,
  objective: z.string().trim().min(1).max(20_000),
  coordinator: legacyClusterServerSchema,
  nodes: z.array(legacyClusterNodeSchema).min(1).max(32),
  inputs: z.array(z.object({ name: z.string().min(1).max(255).refine(name => !/[\\/\u0000]/.test(name) && name !== '.' && name !== '..'), sha256: deploymentIdSchema })).max(128),
  createdAt: z.number().int(),
  strategy: strategySchema.extend({ budget: budgetSchema }),
  versions: versionsV2Schema.extend({ extension: z.literal('0.1.0') }),
}).strict()
/** Released v1 reader preserves field order and limits for submission hashes. */
export const legacyClusterSubmissionSchema = legacySubmissionObject.refine(value => new Set(value.nodes.map(node => node.server.id)).size === value.nodes.length, 'duplicate server')
/** v2 writer never supplies aggregate execution limits. */
export const clusterSubmissionV2Schema = legacySubmissionObject.extend({
  protocol: z.literal(2), strategy: strategySchema, versions: versionsV2Schema,
}).refine(value => new Set(value.nodes.map(node => node.server.id)).size === value.nodes.length, 'duplicate server')
/** Application release numbering is independent from the wire generation. */
export const versionsSchema = versionsV2Schema.extend({ extension: z.literal('0.1.1') })
const resolvedServerSchema = clusterServerSchema.extend({ storagePlacement: storagePlacementSchema })
  .refine(value => value.id === value.storagePlacement.serverId && value.remoteRoot === value.storagePlacement.controlRoot,
    'Server and directory assignment must have the same owner')
/** New submissions include the saved storage evidence and resolved network addresses. */
export const clusterSubmissionV3Schema = legacySubmissionObject.extend({ protocol: z.literal(3),
  coordinator: resolvedServerSchema, nodes: z.array(clusterNodeSchema.extend({ server: resolvedServerSchema })).min(1).max(32),
  strategy: strategySchema, versions: versionsSchema,
  inventories: z.array(z.object({ serverId: serverIdSchema, inventory: serverInventorySchema }).strict()).min(1).max(33),
}).refine(value => new Set(value.nodes.map(node => node.server.id)).size === value.nodes.length
  && [value.coordinator, ...value.nodes.map(node => node.server)].every(server => server.storagePlacement.experimentId === value.experimentId
    && server.storagePlacement.releaseRoot.endsWith('/' + value.deploymentId)), 'Directory assignments must match the experiment and release')
/** Released generations retain their original field order and version values. */
export const clusterSubmissionSchema = z.discriminatedUnion('protocol', [legacyClusterSubmissionSchema, clusterSubmissionV2Schema, clusterSubmissionV3Schema])
/** Immutable request shared by the dispatcher and remote coordinator. */
export type ClusterSubmission = z.infer<typeof clusterSubmissionSchema>

/** Durable scheduling and execution states. */
export const clusterStateSchema = z.enum(['preparing', 'planning', 'awaiting-approval', 'waiting-reply', 'queued', 'starting', 'running', 'serving', 'cancelling', 'completed', 'blocked',
  'failed', 'cancelled', 'interrupted'])
/** Scheduling state, separate from the local dispatch Goal. */
export type ClusterState = z.infer<typeof clusterStateSchema>
/** Remote ownership statement displayed verbatim after durable acceptance. */
export const CLUSTER_HANDOVER = '本机派发完成，远端实验已接管' as const

/** A plan cannot change the submitted objective or server group. */
export const planSchema = z.object({
  revision: z.number().int().positive(), summary: z.string().min(1).max(20_000),
  steps: z.array(z.string().min(1).max(10_000)).min(1).max(100),
  frameworks: z.array(z.object({ name: z.string().min(1), version: z.string().min(1), documentation: z.string().url().startsWith('https://') }).strict()).max(16),
  createdAt: z.number().int(),
}).strict()
/** Durable execution plan and version-specific documentation. */
export type ExperimentPlan = z.infer<typeof planSchema>
/** User confirmation refers to one immutable plan revision. */
export const approvalSchema = z.object({ planRevision: z.number().int().positive(), approvedAt: z.number().int(), by: z.enum(['user', 'policy']) }).strict()
/** Versions and parameters actually used by a preparation or training step. */
export const executionEntrySchema = z.object({
  serverId: serverIdSchema, framework: z.string().min(1), version: z.string().min(1),
  script: z.string().min(1), environment: z.string().min(1),
  parameters: z.record(z.string(), z.string()), artifacts: z.array(z.string()), evaluation: z.record(z.string(), z.number()),
}).strict()
/** Structured metrics supplement the raw per-node log. */
export const progressSchema = z.object({ phase: z.string().max(200), metrics: z.record(z.string(), z.number()), updatedAt: z.number().int() }).strict()
/** Public facts about a registered process; node credentials never appear here. */
export const serviceSchema = z.object({
  id: serviceIdSchema, experimentId: experimentIdSchema, serverId: serverIdSchema,
  commandId: z.string(), command: z.string(), modelPath: z.string(),
  port: z.number().int().min(1).max(65535), healthPath: z.string().startsWith('/'),
  state: z.enum(['starting', 'healthy', 'unhealthy', 'stopping', 'stopped', 'failed', 'interrupted']),
  createdAt: z.number().int(), updatedAt: z.number().int(), deadline: z.number().int().optional(),
  released: z.boolean(), detail: z.string().optional(),
}).strict()
/** Inference service state with an experiment-owned lifetime. */
export type InferenceService = z.infer<typeof serviceSchema>

/** Remote question identity bound to one logged tool invocation. */
export type ExperimentQuestionId = string & Branded<'ExperimentQuestionId'>
/** Validate question ids from durable records and replies. */
export const questionIdSchema = z.uuid().transform(value => brandString<ExperimentQuestionId>(value))
/** Question fields accepted by the DSH user-questions service. */
export const questionItemSchema = z.object({
  id: z.string().min(1).max(200), question: z.string().min(1).max(20000),
  header: z.string().max(200).optional(), detail: z.string().max(20000).optional(),
  options: z.array(z.object({ label: z.string().min(1).max(1000), description: z.string().max(5000).optional() }).strict()).max(32).optional(),
  multiSelect: z.boolean().optional(),
}).strict()
/** Replies contain decisions only; deployment and immutable requirements are not writable fields. */
export const questionAnswerSchema = z.object({ answers: z.array(z.object({
  id: z.string().min(1).max(200), selected: z.array(z.string().max(1000)).max(32), custom: z.string().max(20000).optional(),
}).strict()).min(1).max(16) }).strict()
/** Wire binding prevents a reply reaching a different Session or a replacement question. */
export const questionBindingSchema = z.object({ questionId: questionIdSchema, revision: z.number().int().positive(),
  sessionId: z.string().min(1).max(200).transform(value => brandString<SessionId>(value)),
  callId: z.string().min(1).max(200).transform(value => brandString<ToolCallId>(value)) }).strict()
/** Persistent question and accepted answer; interruption expires unresolved questions. */
export const experimentQuestionSchema = questionBindingSchema.extend({
  version: z.literal(1), experimentId: experimentIdSchema, stage: z.enum(['planning', 'running']),
  questions: z.array(questionItemSchema).min(1).max(16).refine(items => new Set(items.map(item => item.id)).size === items.length),
  state: z.enum(['open', 'answered', 'expired']), createdAt: z.number().int(),
  answer: questionAnswerSchema.optional(), answeredAt: z.number().int().optional(),
}).strict()
/** Validated reply to an immutable question revision. */
export const answerExperimentQuestionSchema = questionBindingSchema.extend({ answer: questionAnswerSchema }).strict()
/** Desktop answer request. */
export type AnswerExperimentQuestion = z.infer<typeof answerExperimentQuestionSchema>
/** Durable question record. */
export type ExperimentQuestion = z.infer<typeof experimentQuestionSchema>

/** Complete remote receipt; queued experiments have no execution Goal yet. */
export const clusterRecordSchema = z.object({
  submission: clusterSubmissionSchema,
  payloadHash: deploymentIdSchema,
  sequence: z.number().int().nonnegative(),
  revision: z.number().int().positive(),
  state: clusterStateSchema,
  resourcesReleased: z.boolean(),
  updatedAt: z.number().int(),
  handover: z.literal(CLUSTER_HANDOVER),
  detail: z.string().optional(),
  sessionId: z.string().optional(),
  goalId: z.string().optional(),
  planningSessionId: z.string().optional(),
  plan: planSchema.optional(), approval: approvalSchema.optional(),
  startedAt: z.number().int().optional(),
  progress: progressSchema.optional(),
  executions: z.array(executionEntrySchema).default([]),
  services: z.array(serviceSchema).default([]),
  questions: z.array(experimentQuestionSchema).optional(),
}).strict()
/** Persisted scheduler record returned to Web. */
export type ClusterRecord = z.infer<typeof clusterRecordSchema>

/** Count each experiment once, regardless of the number of open questions.
 * @param record - current coordinator receipt. @returns whether an operator decision is pending.
 */
export function needsExperimentAttention(record: ClusterRecord): boolean {
  return record.state === 'awaiting-approval' || (record.state === 'waiting-reply' && (record.questions ?? []).some(question => question.state === 'open'))
}

/** Bounded byte reads preserve UTF-8 by transporting raw bytes as base64. */
export const clusterChunkSchema = z.object({
  generation: z.string(), offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(), data: z.string(),
  reset: z.boolean(), eof: z.boolean(),
}).strict()
/** Incremental log or file payload. */
export type ClusterChunk = z.infer<typeof clusterChunkSchema>
/** Output metadata never grants access outside an experiment directory. */
export const clusterFileSchema = z.object({
  serverId: serverIdSchema, path: z.string(), size: z.number().int().nonnegative(), modifiedAt: z.number(),
}).strict()
/** One remotely stored artifact. */
export type ClusterFile = z.infer<typeof clusterFileSchema>

/** A command belongs to one allocation and one idempotent launch identity. */
export const clusterCommandSchema = z.object({
  commandId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), command: z.string().min(1).max(65_536),
}).strict()
/** Receiver-owned command result, including confirmed process cleanup. */
export const clusterCommandResultSchema = z.object({
  commandId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), state: z.enum(['starting', 'running', 'completed', 'failed',
    'cancelled', 'interrupted']),
  exitCode: z.number().int().nullable(), released: z.boolean(), detail: z.string().optional(),
}).strict()
/** Process facts exposed to the experiment Agent. */
export type ClusterCommandResult = z.infer<typeof clusterCommandResultSchema>
