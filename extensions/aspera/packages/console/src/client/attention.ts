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

/** One revision-specific decision displayed by the dismissible banner. */
export interface ExperimentTodo { key: string; experimentId: string; kind: 'plan' | 'question' }
/** @param rows - current receipts. @returns pending decisions with stable revision identities. */
export function experimentTodos(rows: readonly FleetExperiment[]): ExperimentTodo[] {
  return rows.flatMap(row => {
    const id = row.request.experimentId; const record = row.latest
    const pending: ExperimentTodo[] = []
    if (record?.state === 'awaiting-approval' && record.plan !== undefined) pending.push({ key: `${id}/plan/${record.plan.revision}`, experimentId: id, kind: 'plan' })
    for (const question of record?.questions ?? []) if (question.state === 'open') pending.push({ key: `${id}/question/${question.questionId}/${question.revision}`, experimentId: id, kind: 'question' })
    return pending
  })
}
