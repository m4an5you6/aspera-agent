/** Shared removal checks include coordinator work and unconfirmed remote commands. */
import type { ExperimentServerId, ServerProbe } from '@aspera/experiments/types'
import type { FleetExperiment } from './types.ts'

/** Explain why a record cannot be removed or handed to another coordinator.
 * @param record - immutable submission and latest execution evidence. @returns the outstanding obligation, if any.
 */
export function experimentRemovalBlocker(record: FleetExperiment): 'active' | 'cleanup-unconfirmed' | undefined {
  if (record.preparation?.environments?.some(value => value.pendingCommand !== undefined)) return 'cleanup-unconfirmed'
  if (record.state === 'staging' || record.state === 'preparing') return 'active'
  const remote = record.latest ?? record.receipt
  if (record.submission === undefined) return ['failed', 'cancelled'].includes(record.state) ? undefined : 'active'
  if (remote === undefined || !remote.resourcesReleased || remote.services.some(service => !service.released)) return 'cleanup-unconfirmed'
  return ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(remote.state) ? undefined : 'active'
}

/**
 * Find experiments that still require this registration for pending work or cleanup.
 * @param id - configured server identity.
 * @param records - local records, including pinned historical coordinators.
 * @param probe - last remote allocation observation.
 * @param deletedIds - locally deleted terminal identities whose stale allocations have already been reconciled.
 * @returns experiment identities that prevent removing this registration.
 */
export function serverRemovalBlockers(id: ExperimentServerId, records: readonly FleetExperiment[], probe?: ServerProbe, deletedIds: readonly string[] = []): string[] {
  const blockers = new Set<string>()
  for (const record of records) {
    if (record.coordinator.id !== id && !record.servers.some(server => server.id === id)) continue
    if (experimentRemovalBlocker(record) !== undefined) {
      blockers.add(record.request.experimentId)
    }
  }
  for (const allocation of probe?.allocations ?? []) {
    if (!deletedIds.includes(allocation) && !records.some(record => record.request.experimentId === allocation)) blockers.add(allocation)
  }
  return [...blockers]
}
