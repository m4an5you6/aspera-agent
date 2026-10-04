/** Non-secret storage observations and immutable experiment directory assignments. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ExperimentId, ExperimentServerId } from './cluster-protocol.ts'

/** Candidate identity includes its directory and observed filesystem identity. */
export type StorageCandidateId = string & Branded<'StorageCandidateId'>
/** Absolute Linux paths accepted from SSH observations and explicit settings. */
export const remotePathSchema = z.string().min(1).max(4096).refine(value => value.startsWith('/')
  // oxlint-disable-next-line no-control-regex -- Reject control characters at the SSH and durable-data parser.
  && !/[\\\u0000-\u001f]/.test(value) && !value.split('/').some(part => part === '.' || part === '..')
  && (value === '/' || (!value.endsWith('/') && !value.includes('//'))), 'Use a normalized absolute Linux directory')
const ownedPath = remotePathSchema.refine(value => value !== '/', 'An owned directory cannot be the filesystem root')
/** User preference is resolved before deployment, independently of control-state placement. */
export const storagePreferenceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('auto') }).strict(),
  z.object({ mode: z.literal('manual'), directory: ownedPath }).strict(),
])
/** Server form storage preference. */
export type StoragePreference = z.infer<typeof storagePreferenceSchema>
/** Filesystem evidence distinguishes a missing data mount from its parent filesystem. */
export const storageMountSchema = z.object({ mountPoint: remotePathSchema, root: remotePathSchema,
  source: z.string(), filesystem: z.string(), device: z.string(), uuid: z.string().optional() }).strict()
/** Observed filesystem identity; mount sequence numbers are not durable identities. */
export type StorageMountIdentity = z.infer<typeof storageMountSchema>
/** Candidate metadata returned without listing file contents or credentials. */
export const storageCandidateSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/).transform(value => brandString<StorageCandidateId>(value)),
  directory: remotePathSchema, mount: storageMountSchema, availableBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(), writable: z.boolean(), systemVolume: z.boolean(),
  persistence: z.enum(['confirmed', 'ephemeral', 'unknown']),
}).strict()
/** One verified source of a prospective experiment directory. */
export type StorageCandidate = z.infer<typeof storageCandidateSchema>
/** A bounded read-only inventory produced by the server, not by the model. */
export const serverInventorySchema = z.object({ observedAt: z.number().int(), home: remotePathSchema,
  candidates: z.array(storageCandidateSchema).max(512),
  addresses: z.array(z.object({ address: z.string(), interface: z.string(), family: z.enum(['IPv4', 'IPv6']),
    private: z.boolean() }).strict()).max(512),
  routes: z.array(z.string()).max(1024),
}).strict()
/** SSH storage and network facts available to the preparation Agent. */
export type ServerInventory = z.infer<typeof serverInventorySchema>
/** Actual locations are persisted before any directories or releases are created. */
export const storagePlacementSchema = z.object({
  version: z.literal(1),
  layout: z.enum(['legacy', 'separated']),
  serverId: z.uuid().transform(value => brandString<ExperimentServerId>(value)),
  experimentId: z.uuid().transform(value => brandString<ExperimentId>(value)),
  candidate: storageCandidateSchema, controlRoot: ownedPath, namespaceRoot: ownedPath,
  releaseRoot: ownedPath, runRoot: ownedPath, workspaceRoot: ownedPath,
  reason: z.string().trim().min(1).max(4000), minimumFreeBytes: z.number().int().positive(),
}).strict().refine(value => value.runRoot === `${value.namespaceRoot}/runs/${value.experimentId}`
  && (value.layout === 'legacy'
    ? value.namespaceRoot === value.candidate.directory && value.controlRoot === value.namespaceRoot
    : value.namespaceRoot === `${value.candidate.directory === '/' ? '' : value.candidate.directory}/.aspera/${value.serverId}`)
  && value.workspaceRoot === `${value.runRoot}/workspace`
  && value.releaseRoot.startsWith(`${value.namespaceRoot}/releases/`)
  && /^[a-f0-9]{64}$/.test(value.releaseRoot.slice(`${value.namespaceRoot}/releases/`.length)),
  'Storage paths must belong to the recorded experiment and release')
/** One node's frozen directory assignment, including the observed mount and rationale. */
export type StoragePlacement = z.infer<typeof storagePlacementSchema>
/** Read-only connection check also reports inventory without creating an Agent. */
export interface ServerProbe {
  gpuInfo: string
  allocations: string[]
  inventory?: ServerInventory
  environment?: import('./environment-protocol.ts').ServerEnvironment
  environmentReady?: boolean
  detail?: string
}
