/** One pending count shared by sidebar, list and native desktop adapter. */
import { needsExperimentAttention } from '@aspera/experiments'
import type { FleetExperiment } from '@aspera/dispatch/types'

/** Count distinct experiments requiring a plan confirmation or reply.
 * @param experiments - latest durable receipts. @returns pending experiment count.
 */
export function experimentAttentionCount(experiments: readonly FleetExperiment[]): number {
  return new Set(experiments.filter(row => row.latest !== undefined && needsExperimentAttention(row.latest)).map(row => row.request.experimentId)).size
}

/** Render the common numeric badge.
 * @param count - pending experiments. @returns empty at zero, otherwise 1–99 or 99+.
 */
export function attentionLabel(count: number): string { return count === 0 ? '' : count > 99 ? '99+' : String(count) }
