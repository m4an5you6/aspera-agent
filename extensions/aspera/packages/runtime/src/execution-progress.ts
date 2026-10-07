/** The coordinator alone writes step reports in the experiment's owned run directory. */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { executionProgressSchema } from '@aspera/experiments'
import type { ClusterRecord, ExecutionProgress, ExecutionStepReport, ExecutionStepResult } from '@aspera/experiments'
import { serverRunRoot } from './storage.ts'

/** Read and atomically replace version 1 reports without modifying queue records. */
export class ExecutionProgressStore {
  constructor(private readonly root: string) {}

  /** @param record - current queue owner. @returns saved reports or unreported plan steps; rejects mismatched saved ownership. */
  read(record: ClusterRecord): ExecutionProgress | undefined {
    const plan = record.plan
    if (plan === undefined) return undefined
    const experimentId = record.submission.experimentId
    const sessionId = record.sessionId ?? `aspera-execution-${experimentId}`
    const path = this.path(record)
    if (!existsSync(path)) return { version: 1, experimentId, planRevision: plan.revision, sessionId, revision: 0,
      steps: plan.steps.map((_text, index) => ({ step: index + 1, state: 'pending' })) }
    const progress = executionProgressSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (progress.experimentId !== experimentId || progress.planRevision !== plan.revision || progress.sessionId !== sessionId
      || progress.steps.length !== plan.steps.length || progress.steps.some((step, index) => step.step !== index + 1)) {
      throw new Error('Saved execution progress belongs to another experiment, plan or Session; inspect the retained record')
    }
    return progress
  }

  /** Synchronous validation and rename prevent concurrent handlers from overwriting newer reports.
   * @param record - current queue state. @param report - validated worker identity and requested revision.
   * @returns the committed snapshot or a diagnostic with the current revision; rejected reports leave the file unchanged.
   */
  report(record: ClusterRecord, report: ExecutionStepReport): ExecutionStepResult {
    const reject = (error: string, progress?: ExecutionProgress): ExecutionStepResult => ({ accepted: false, error,
      ...(progress === undefined ? {} : { progress }) })
    if (report.experimentId !== record.submission.experimentId) return reject('Step report belongs to another experiment')
    if (report.generation !== readFileSync(resolve(this.root, 'state/coordinator.generation'), 'utf8')) return reject('Coordinator changed; this execution worker cannot report')
    const progress = this.read(record)
    if (progress === undefined || record.approval?.planRevision !== progress.planRevision) return reject('Execution requires the exact approved plan')
    if (report.planRevision !== progress.planRevision || report.sessionId !== progress.sessionId) return reject('Step report belongs to another plan or execution Session')
    if (!['starting', 'running'].includes(record.state)) return reject('Experiment is paused, cancelled or ended; step updates are no longer accepted', progress)
    const previous = progress.steps[report.step - 1]
    if (previous === undefined) return reject('Step number is outside the approved plan', progress)
    const same = previous.state === report.state && previous.detail === report.detail
    if (same && (report.expectedRevision === progress.revision || report.expectedRevision === previous.previousRevision)) return { accepted: true, progress }
    if (report.expectedRevision !== progress.revision) return reject('Execution progress changed; read the latest revision before reporting again', progress)
    if (previous.state === 'completed') return reject('A completed step cannot be reopened; retain its report and inspect the approved plan', progress)
    if (report.state === 'completed' && previous.state !== 'running') return reject('Report the step as running before marking it completed', progress)
    const updatedAt = Date.now()
    const next: ExecutionProgress = { ...progress, revision: progress.revision + 1, updatedAt,
      steps: progress.steps.map(step => step.step === report.step ? { step: report.step, state: report.state,
        ...(report.detail === undefined ? {} : { detail: report.detail }), updatedAt, callId: report.callId, previousRevision: progress.revision } : step) }
    const path = this.path(record)
    writeFileSync(`${path}.incoming`, JSON.stringify(next) + '\n', { mode: 0o600 })
    renameSync(`${path}.incoming`, path)
    return { accepted: true, progress: next }
  }

  private path(record: ClusterRecord): string {
    return resolve(serverRunRoot(record.submission.coordinator, record.submission.experimentId), 'execution-progress.v1.json')
  }
}
