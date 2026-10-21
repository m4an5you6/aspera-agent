/** Operator actions derive from saved operation receipts, independently of cached execution activity. */
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { ExperimentInterruptionStatus } from '@aspera/experiments/types'
import type { ExperimentLocaleKey } from './locales.ts'

/** Program-observed prior work retains an entry to its original experiment. */
export interface PreparationBlockedTask { experimentId: FleetExperiment['request']['experimentId']; name: string }

/** @param row - current local preparation. @param records - saved experiments. @param journals - program-observed limitations.
 * @returns original task entries sharing selected nodes; no process or state is inferred from metrics.
 */
export function blockedPreparationTasks(row: FleetExperiment, records: FleetExperiment[], journals: ExperimentInterruptionStatus[]): PreparationBlockedTask[] {
  if (row.submission !== undefined || !['preparing', 'failed'].includes(row.state)) return []
  return journals.flatMap(journal => {
    if (journal.experimentId === row.request.experimentId || journal.reason !== 'controller-recovery' || journal.phase !== 'blocked') return []
    const previous = records.find(record => record.request.experimentId === journal.experimentId)
    if (previous === undefined || !previous.servers.some(server => row.servers.some(selected => selected.id === server.id))) return []
    return [{ experimentId: journal.experimentId, name: previous.request.name ?? previous.request.objective.split('\n')[0]!.slice(0, 120) }]
  })
}

/** @param row - fixed experiment and latest execution. @param interruption - retained operation. @param requesting - request acknowledgement in flight.
 * @returns the available action and actual operation activity; released work never animates.
 */
export function interruptionView(row: FleetExperiment, interruption?: ExperimentInterruptionStatus, requesting = false): {
  busy: boolean; blocked: boolean; available: boolean; action: ExperimentLocaleKey; userInterrupted: boolean
} {
  const state = row.latest?.state ?? row.receipt?.state ?? row.state
  const busy = requesting || interruption !== undefined && !['released', 'blocked'].includes(interruption.phase)
  const blocked = interruption?.phase === 'blocked'
  const ended = ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(state) && row.latest?.resourcesReleased !== false
  const pending = ['staging', 'preparing', 'submitted', 'queued', 'awaiting-approval'].includes(state)
  return { busy, blocked, available: !ended || blocked,
    action: busy ? 'interruptingExperiment' : blocked ? 'retryInterruption' : pending ? 'cancel' : 'interruptExperiment',
    userInterrupted: state === 'cancelled' && interruption?.phase === 'released' && interruption.stopRequested,
  }
}
