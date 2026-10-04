/** Main experiment phases derived from saved scheduling and Session evidence. */
import type { FleetExperiment } from '@aspera/dispatch/types'

/** Stable overview steps; preparation substeps remain in the node records. */
export const experimentPhases = ['prepareEnvironment', 'makePlan', 'executePlan', 'viewResults'] as const

/**
 * Locate the last evidenced phase, including paused and failed remote work.
 * @param row - saved experiment and its latest coordinator receipt.
 * @returns phase index, status and whether work is actively progressing.
 */
export function experimentProgress(row: FleetExperiment) {
  const remote = row.latest ?? row.receipt
  const status = remote?.state ?? row.state
  const local = row.receipt === undefined && remote === undefined
  let phase: 0 | 1 | 2 | 3 = 0
  if (!local && remote !== undefined) {
    if (status === 'completed') phase = 3
    else if (['queued', 'starting', 'running', 'serving'].includes(status)) phase = 2
    else if (['preparing', 'planning', 'awaiting-approval'].includes(status)) phase = 1
    else {
      const question = remote.questions?.find(value => value.state === 'open')
      if (question !== undefined) phase = question.stage === 'running' ? 2 : 1
      else if (remote.sessionId !== undefined || remote.startedAt !== undefined || remote.approval !== undefined
        || remote.executions.length > 0 || remote.services.length > 0) phase = 2
      // Remote acceptance starts planning. A stopped record may have no Session yet.
      else phase = 1
    }
  }
  const issue = ['failed', 'blocked', 'interrupted'].includes(status)
  const attention = issue || status === 'awaiting-approval' || status === 'waiting-reply'
  const busy = ['staging', 'preparing', 'submitted', 'planning', 'starting', 'running', 'serving', 'cancelling'].includes(status)
  return { phase, status, local, issue, attention, busy, remote }
}
