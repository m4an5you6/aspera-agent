/** Local deletion journals retain unresolved remote ownership independently of fleet generation 6. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { serverIdSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentServerId } from '@aspera/experiments'
import type { DeletionOperationId, FleetExperiment, PinnedDeployment, ServerSettings } from './types.ts'
import { fleetExperimentV5Schema } from './fleet-schema-v5.ts'
import { pinnedTargetSchema } from './deployment-settings.ts'
import { deletedExperimentSchema, experimentDeletionSchema } from './management-schema.ts'

/** Private connection references and immutable remote identities needed for read-only release checks. */
export interface RemovedWork {
  coordinatorId: ExperimentServerId
  protocol: number
  submissionHash?: string
  nodes: { server: ServerSettings; target: PinnedDeployment; pendingDirectory?: string }[]
}

/** The journal is authoritative as soon as the tombstone is written; local cleanup can finish later. */
export interface LocalRemoval {
  identity: z.infer<typeof deletedExperimentSchema>
  operationId: DeletionOperationId
  name: string
  localCleanup: 'pending' | 'complete'
  credentialRefs: string[]
  work?: RemovedWork
  error?: string
}

const workSchema = z.object({ coordinatorId: serverIdSchema, protocol: z.number().int().min(1).max(4), submissionHash: z.string().optional(),
  nodes: z.array(z.object({ server: fleetExperimentV5Schema.shape.coordinator, target: pinnedTargetSchema,
    pendingDirectory: z.string().optional() }).strict()), }).strict()
const removalSchema = z.object({ identity: deletedExperimentSchema, operationId: experimentDeletionSchema.shape.operationId, name: z.string(),
  localCleanup: z.enum(['pending', 'complete']), credentialRefs: z.array(z.string()), work: workSchema.optional(), error: z.string().optional() }).strict()

/** Independent version 1 storage never rewrites released fleet or remote records. */
export const removalStoreSpec = defineDomain({ name: 'aspera_removals', version: 1, layout: 'per-record', tables: {
  removals: domainTable<ExperimentId, LocalRemoval>(removalSchema),
  removed_servers: domainTable<ExperimentServerId, { removedAt: number }>(z.object({ removedAt: z.number() }).strict()),
} })

/** Compare pinned SSH endpoints across registration IDs and usernames.
 * @param a - saved endpoint. @param b - new registration. @returns whether both registrations reach the same SSH endpoint.
 */
export function sameServerEndpoint(a: ServerSettings, b: ServerSettings): boolean {
  return a.host.toLowerCase() === b.host.toLowerCase() && a.sshPort === b.sshPort
}

/** Capture references for unfinished work without retaining Goals, model requests or event contents.
 * @param record - experiment being removed. @param submissionHash - digest of its immutable submission.
 * @returns the minimal pinned connections and pending-command locations.
 */
export function removedWork(record: FleetExperiment, submissionHash?: string): RemovedWork {
  const servers = [...new Map([record.coordinator, ...record.servers].map(server => [server.id, server])).values()]
  return { coordinatorId: record.coordinator.id, protocol: record.submission?.protocol ?? 4,
    ...(submissionHash === undefined ? {} : { submissionHash }), nodes: servers.map(server => {
      const target = server.id === record.coordinator.id ? record.coordinatorTarget : record.targets[record.servers.findIndex(value => value.id === server.id)]!
      const pendingDirectory = record.preparation?.environments?.find(value => value.serverId === server.id)?.pendingCommand?.directory
      return { server, target, ...(pendingDirectory === undefined ? {} : { pendingDirectory }) }
    }) }
}
