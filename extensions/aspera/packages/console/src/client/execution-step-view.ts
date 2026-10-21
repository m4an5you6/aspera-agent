/** Display excerpts never replace the approved plan or the bound Agent report. */
import type { ExecutionProgress, ReviewStep } from '@aspera/experiments/types'

/** @param steps - bound original reports. @param count - current approved plan length. @param supplements - independently stored review reports.
 * @returns reports keyed by one-based plan step; unrelated cached positions never affect completion counts.
 */
export function displayedStepReports(steps: ExecutionProgress['steps'], count: number, supplements: ReviewStep[]): Map<number, ExecutionProgress['steps'][number]> {
  const reports = new Map(steps.filter(step => step.step >= 1 && step.step <= count).map(step => [step.step, step]))
  for (const step of supplements) if (step.step >= 1 && step.step <= count && step.state !== 'blocked') {
    reports.set(step.step, { step: step.step, state: 'completed', detail: step.detail, updatedAt: step.recordedAt })
  }
  return reports
}

/** @param text - original step requirement. @returns a short heading with the original text retained by the caller. */
export function stepTitle(text: string): string {
  const first = text.trim().split(/\r?\n/)[0] ?? ''
  const heading = first.replace(/^\s*#{1,6}\s*/, '').replace(/^\s*(?:(?:步骤|step)\s*\d+\s*[：:.、)）-]?\s*|\d+[.、)）：:\s]+)/i, '')
  const clause = heading.split(/[：:；;。]/)[0]?.trim() || heading
  return clause.length > 64 ? clause.slice(0, 64) + '…' : clause
}

/** @param text - original result. @returns a single-line excerpt, without inferring a successful outcome. */
export function stepExcerpt(text: string): string {
  const line = text.trim().replace(/\s+/g, ' ')
  return line.length > 160 ? line.slice(0, 160) + '…' : line
}
