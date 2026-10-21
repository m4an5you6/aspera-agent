/** Remote ownership identities survive deletion of the experiment's local presentation and history. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { experimentIdSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentInterruptionStatus, ExperimentServerId } from '@aspera/experiments'
import { removedWork, removedWorkSchema } from './removals.ts'
import type { FleetExperiment } from './types.ts'
import type { InterruptionTask } from './interruption.ts'

/** Minimal private identity; the original submission is read by digest from its owning coordinator. */
export const remoteTaskRecordSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, name: z.string(),
  work: removedWorkSchema, createdAt: z.number(), updatedAt: z.number(),
  release: z.object({ state: z.enum(['completed', 'failed', 'blocked', 'cancelled', 'interrupted']), revision: z.number().int(),
    observedAt: z.number() }).strict().optional(),
}).strict().refine(value => value.work.protocol === 4 && /^[a-f0-9]{64}$/.test(value.work.submissionHash ?? ''),
  'Remote task recovery requires a protocol-4 submission digest')
  .refine(value => new Set(value.work.nodes.map(node => node.server.id)).size === value.work.nodes.length
    && value.work.nodes.some(node => node.server.id === value.work.coordinatorId)
    && value.work.nodes.every(node => node.target.remoteRoot === node.server.remoteRoot), 'Remote task connections omit or differ from an original node')

/** Version-1 private task identity, independent from fleet and deletion generations. */
export type RemoteTaskRecord = z.infer<typeof remoteTaskRecordSchema>

/** User-selected task and explicit settlement intent at the Remote request parser. */
export const settleRemoteTaskRequestSchema = z.object({ taskId: experimentIdSchema, mode: z.enum(['reconcile', 'interrupt']) }).strict()

/** Independent identities remain readable when an experiment has a deletion tombstone. */
export const remoteTaskStoreSpec = defineDomain({ name: 'aspera_remote_tasks', version: 1, layout: 'per-record', tables: {
  tasks: domainTable<ExperimentId, RemoteTaskRecord>(remoteTaskRecordSchema),
} })

/** Credential-free task progress for server cards and the generated Remote interface. */
export interface RemoteTaskStatus {
  experimentId: ExperimentId
  name: string
  serverIds: ExperimentServerId[]
  deleted: boolean
  updatedAt: number
  released: boolean
  recoveryAvailable: true
  interruption?: ExperimentInterruptionStatus
}

/** @param record - original locally owned experiment. @returns its minimal recovery identity, if submitted with protocol 4. */
export function remoteTaskFromExperiment(record: FleetExperiment): RemoteTaskRecord | undefined {
  if (record.submission?.protocol !== 4) return undefined
  const latest = record.latest ?? record.receipt
  const release = latest !== undefined && latest.resourcesReleased && latest.services.every(service => service.released)
    && JSON.stringify(latest.submission) === JSON.stringify(record.submission)
    ? z.enum(['completed', 'failed', 'blocked', 'cancelled', 'interrupted']).safeParse(latest.state) : undefined
  return { version: 1, experimentId: record.request.experimentId,
    name: record.request.name ?? record.request.objective.split('\n')[0]!.slice(0, 120),
    work: removedWork(record, createHash('sha256').update(JSON.stringify(record.submission)).digest('hex')),
    createdAt: record.createdAt, updatedAt: Date.now(),
    ...(release?.success && latest !== undefined ? { release: { state: release.data, revision: latest.revision, observedAt: latest.updatedAt } } : {}) }
}

/** @param record - validated private identity. @returns the same interruption input used by visible experiments, without retaining a Goal. */
export function remoteTaskAsInterruption(record: RemoteTaskRecord): InterruptionTask {
  const coordinator = record.work.nodes.find(node => node.server.id === record.work.coordinatorId)
  if (coordinator === undefined) throw new Error('Remote task has no original coordinator connection')
  return { request: { experimentId: record.experimentId, name: record.name }, submissionHash: record.work.submissionHash!,
    coordinator: coordinator.server, coordinatorTarget: coordinator.target,
    servers: record.work.nodes.map(node => node.server), targets: record.work.nodes.map(node => node.target) }
}
