/** Local running-record copies are independent of released Sessions and remote submissions. */
import { z } from 'zod'
import { experimentIdSchema, serverIdSchema } from './cluster-protocol.ts'
import { observationSourceIdSchema } from './observations.ts'
import { experimentPhases } from './models.ts'

/** Synchronization health does not describe experiment execution success. */
export const archiveStateSchema = z.enum(['idle', 'syncing', 'caught-up', 'disconnected', 'paused', 'incomplete'])
/** One copied physical generation retains its own remote and local read positions. */
export const archiveSourceStatusSchema = z.object({
  id: observationSourceIdSchema, serverId: serverIdSchema, label: z.string(),
  kind: z.enum(['trace', 'log', 'process-log']), phase: z.enum(experimentPhases).optional(),
  state: archiveStateSchema, savedBytes: z.number().int().nonnegative(), pendingBytes: z.number().int().nonnegative(),
  lastSyncedAt: z.number().optional(), sourceUpdatedAt: z.number().optional(), complete: z.boolean(),
  gaps: z.array(z.string()), error: z.string().optional(),
}).strict()
/** Version-1 local copy availability, including stale execution evidence and incomplete history. */
export const experimentArchiveStatusSchema = z.object({
  version: z.literal(1), experimentId: experimentIdSchema, state: archiveStateSchema,
  lastAttemptAt: z.number().optional(), lastSyncedAt: z.number().optional(), lastRemoteStateAt: z.number().optional(),
  runtimeAvailable: z.boolean(), savedBytes: z.number().int().nonnegative(), complete: z.boolean(),
  sources: z.array(archiveSourceStatusSchema), gaps: z.array(z.string()), error: z.string().optional(),
}).strict()
/** Public read-only copy health returned by the management Host. */
export type ExperimentArchiveStatus = z.infer<typeof experimentArchiveStatusSchema>
/** One identity-bound copied source. */
export type ArchiveSourceStatus = z.infer<typeof archiveSourceStatusSchema>
