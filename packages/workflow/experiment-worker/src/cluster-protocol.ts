/** Versioned cluster requests and durable experiment receipts. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Stable configured server identity, independent of list order and address edits. */
export type ExperimentServerId = string & Branded<'ExperimentServerId'>
/** One immutable experiment submission; retries retain this identity. */
export type ExperimentId = string & Branded<'ExperimentId'>

/** Server ids accepted from settings and the receiver. */
export const serverIdSchema = z.uuid().transform(value => brandString<ExperimentServerId>(value))
/** Experiment ids accepted from browser and receiver requests. */
export const experimentIdSchema = z.uuid().transform(value => brandString<ExperimentId>(value))
/** Fixed source content digest. */
export const deploymentIdSchema = z.string().regex(/^[a-f0-9]{64}$/)

/** Non-secret connection and execution settings captured at submission. */
export const clusterServerSchema = z.object({
  id: serverIdSchema,
  name: z.string().trim().min(1).max(100),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/),
  username: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/),
  sshPort: z.number().int().min(1).max(65535),
  remotePort: z.number().int().min(1).max(65535),
  remoteRoot: z.string().regex(/^\/[a-zA-Z0-9_./-]+$/).refine(path => !path.split('/').some(part => part === '.' || part === '..') && path.replaceAll('/', '') !== ''),
  trainingAddress: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/).optional(),
  authMode: z.enum(['password', 'key']),
  passwordRef: z.string().optional(),
  identityFile: z.string().optional(),
  knownHostsFile: z.string().optional(),
}).strict()
/** Saved server definition; credentials are resolved separately. */
export type ClusterServer = z.infer<typeof clusterServerSchema>

/** CUDA and sandbox facts checked during server preparation. */
export const clusterNodeSchema = z.object({
  server: clusterServerSchema,
  devicePaths: z.array(z.string().regex(/^\/dev\/nvidia[a-zA-Z0-9_/-]*$/)).min(1),
  backendPath: z.string().startsWith('/'),
  hiddenPaths: z.array(z.string().startsWith('/')),
  gpuInfo: z.string(),
}).strict()
/** One prepared member of a submitted server group. */
export type ClusterNode = z.infer<typeof clusterNodeSchema>

/** Inputs committed remotely before a queued receipt is returned. */
export const clusterSubmissionSchema = z.object({
  protocol: z.literal(2),
  experimentId: experimentIdSchema,
  deploymentId: deploymentIdSchema,
  objective: z.string().trim().min(1).max(20_000),
  coordinator: clusterServerSchema,
  nodes: z.array(clusterNodeSchema).min(1).max(32),
  inputs: z.array(z.object({ name: z.string().min(1).max(255).refine(name => !/[\\/\u0000]/.test(name) && name !== '.' && name !== '..'), sha256: deploymentIdSchema })).max(128),
  createdAt: z.number().int(),
}).strict().refine(value => new Set(value.nodes.map(node => node.server.id)).size === value.nodes.length, 'duplicate server')
/** Immutable request shared by the dispatcher and remote coordinator. */
export type ClusterSubmission = z.infer<typeof clusterSubmissionSchema>

/** Durable scheduling and execution states. */
export const clusterStateSchema = z.enum(['preparing', 'queued', 'starting', 'running', 'cancelling', 'completed', 'blocked',
  'failed', 'cancelled', 'interrupted'])
/** Scheduling state, separate from the local dispatch Goal. */
export type ClusterState = z.infer<typeof clusterStateSchema>
/** Remote ownership statement displayed verbatim after durable acceptance. */
export const CLUSTER_HANDOVER = '本机派发完成，远端实验已接管' as const

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
}).strict()
/** Persisted scheduler record returned to Web. */
export type ClusterRecord = z.infer<typeof clusterRecordSchema>

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
