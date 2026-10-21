/** Current work and recovery actions, backed by saved experiment progress. */
import { Button, Tag, StateDot, IconCheckOutlineRegular, IconWarningOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment, InstallationProgress as Progress } from '@aspera/dispatch/types'
import { InstallationProgress } from './InstallationProgress.tsx'
import { experimentPhases, experimentProgress } from './experiment-progress.ts'
import { overviewMetrics, overviewReportTime, overviewSummary } from './overview-data.ts'
import css from './ExperimentsPage.module.css'
import type { ExperimentInterruptionStatus } from '@aspera/experiments/types'
import { interruptionView } from './interruption-view.ts'
import type { PreparationBlockedTask } from './interruption-view.ts'
import { InterruptionProgress } from './InterruptionProgress.tsx'

/**
 * Render the active work area with retained diagnostics and real navigation actions.
 * @param props - saved experiment, pending retry and detail-page navigation.
 * @returns the current-stage card; Agent claims never mark checks complete.
 */
export function ExperimentStage({ row, t, retrying, onRetry, onRecords, onMonitor, onFiles, onServices, onPlan, onDiagnostics, installations, activityConfirmed, interruption, interrupting, onInterrupt, blockingTasks, onOpenTask }: {
  blockingTasks?: PreparationBlockedTask[]; onOpenTask?: (id: PreparationBlockedTask['experimentId']) => void
  interruption?: ExperimentInterruptionStatus; interrupting?: boolean; onInterrupt?: () => void
  activityConfirmed?: boolean
  row: FleetExperiment; t: TranslateNS<'experiments'>; retrying: boolean; onRetry: () => void; onRecords: () => void
  installations: Progress[]
  onMonitor: () => void; onFiles: () => void; onServices: () => void; onPlan: () => void
  onDiagnostics: () => void
}) {
  const { phase, status, local, issue, attention, busy, remote } = experimentProgress(row)
  const stopping = interruptionView(row, interruption, interrupting)
  const active = status === 'reviewing' || stopping.busy || !stopping.blocked && interruption?.phase !== 'released' && ((busy && (local || activityConfirmed !== false)) || retrying)
  const stopped = issue || status === 'cancelled' || interruption !== undefined
  const step = status === 'reviewing' ? t(row.completionReview?.phase === 'verifying' ? 'reviewVerifying' : 'reviewCollecting')
    : remote?.progress?.phase || (local && row.preparation !== undefined ? t(row.preparation.stage) : undefined)
  const title = status === 'reviewing' ? t(row.completionReview?.phase === 'verifying' ? 'reviewVerifying' : 'reviewCollecting') : status === 'revalidated' ? t('revalidated') : status === 'review-blocked' ? t('review-blocked') : stopping.busy ? t('interruptingExperiment') : stopping.blocked ? t('interruptionBlocked') : stopping.userInterrupted ? t('interruptedByUser') : !local && busy && activityConfirmed === false ? t('archiveRuntimeUnconfirmed') : retrying ? t('retryingPreparation') : local && issue ? t('preparationFailed')
    : issue && phase === 2 ? t('executionStopped') : phase === 1 && ['preparing', 'planning'].includes(status) ? t('planningWork') : status === 'running' ? t('executionWork')
      : status === 'completed' ? t('resultsReady') : local && busy ? t('preparationWork') : t(status)
  const tone = stopping.blocked ? 'attention' : stopping.busy || retrying ? 'active' : attention ? 'attention' : (status === 'completed' || status === 'revalidated') ? 'complete' : active ? 'active' : 'idle'
  const metrics = overviewMetrics(remote?.progress?.metrics ?? {})
  const training = metrics.find(metric => metric.total !== undefined)
  const reportedAt = overviewReportTime(remote)
  const failure = row.completionReview?.detail ?? remote?.detail ?? row.detail
  const attempts = remote?.progress?.metrics.run_experiment_command_attempts
  const successes = remote?.progress?.metrics.run_experiment_command_successes
  return <section className={css.stageCard} aria-label={t('latestStage')} data-tone={tone} aria-busy={active}>
    <div className={css.workHeader}>
      <div className={css.sectionHeading}><span className={css.hint}>{t('latestStage')} · {t(experimentPhases[phase]!)}</span><Tag tone={stopping.blocked || attention && !retrying ? 'warning' : (status === 'completed' || status === 'revalidated') ? 'success' : 'neutral'}>{t(stopping.busy ? 'interruptingExperiment' : stopping.blocked ? 'interruptionBlocked' : stopping.userInterrupted ? 'interruptedByUser' : retrying ? 'retrying' : status)}</Tag></div>
      <div className={css.workTitle}><span className={css.workIcon} aria-hidden="true">{active ? <StateDot state="ongoing" size={22} /> : stopping.blocked || attention ? <IconWarningOutlineRegular size={22} /> : (status === 'completed' || status === 'revalidated') ? <IconCheckOutlineRegular size={22} /> : <StateDot state="idle" size={16} />}</span><h3>{title}</h3></div>
      <p className={css.workDescription} role={stopping.blocked || issue && !retrying ? 'alert' : undefined}>{t(status === 'reviewing' || status === 'review-blocked' ? 'reviewReadOnlyHint' : stopping.blocked ? 'interruptionBlockedHint' : stopping.busy ? 'interruptionHint' : stopping.userInterrupted ? 'interruptionCompleteHint' : retrying ? 'retryingHint' : issue ? 'failedHint' : status === 'awaiting-approval' ? 'planHint'
        : status === 'waiting-reply' ? 'questionPauseHint' : (status === 'completed' || status === 'revalidated') ? 'resultsHint' : status === 'cancelled' ? 'cancelledHint'
          : status === 'cancelling' ? 'cancellingHint' : local ? 'preparationHint' : phase === 1 ? 'planningHint' : status === 'queued' ? 'queuedHint' : 'executionHint')}</p>
      {issue && failure !== undefined && !retrying && <details className={css.stageIssue}><summary className={css.issueSummary}>{overviewSummary(failure)}</summary><pre className={css.prewrap}>{failure}</pre></details>}
    </div>
    <div className={css.workBody}>
      {local && <InstallationProgress row={row} installations={installations} t={t} onLogs={onMonitor} />}
      {interruption !== undefined && <InterruptionProgress status={interruption} t={t} />}
      {blockingTasks !== undefined && blockingTasks.length > 0 && <section aria-label={t('priorTasksBlocked')}><h4>{t('priorTasksBlocked')}</h4><p className={css.hint}>{t('priorTasksHint')}</p>
        <div className={css.workActions}>{blockingTasks.map(task => <Button variant="outline" size="sm" key={task.experimentId} onClick={() => { onOpenTask?.(task.experimentId) }}>{t('inspectPriorTask', { name: task.name })}</Button>)}</div>
      </section>}
      {step !== undefined && <div className={css.currentActivity}><span className={css.hint}>{t(stopped || retrying || activityConfirmed === false ? 'lastRecordedAction' : 'currentAction')}</span><p>{overviewSummary(step)}</p></div>}
      {row.waitingFor.length > 0 && <p>{t('waiting', { servers: row.servers.filter(server => row.waitingFor.includes(server.id)).map(server => server.name).join(', ') })}</p>}
      {remote?.resourcesReleased === false && ['failed', 'blocked', 'interrupted', 'cancelling'].includes(status) && <p>{t('held')}</p>}
      {issue && attempts !== undefined && successes !== undefined && <p className={css.hint}>{t('commandReportSummary', { attempts, successes })}</p>}
      {phase >= 2 && metrics.length > 0 && <div className={css.workMetrics}>
        <dl>{metrics.map(metric => <div key={metric.label}><dt>{t(metric.label)}</dt><dd>{metric.value.toLocaleString(undefined, { maximumFractionDigits: 4 })}{metric.total !== undefined && <small> / {metric.total.toLocaleString()}</small>}</dd></div>)}</dl>
        {training?.total !== undefined && <><div className={css.trainingProgress} role="progressbar" aria-label={t('trainingProgress')} aria-valuemin={0} aria-valuemax={training.total} aria-valuenow={training.value}><span style={{ width: `${training.value / training.total * 100}%` }} /></div>
          <div className={css.progressCaption}><span>{t('trainingProgressHint')}</span><span>{(training.value / training.total * 100).toLocaleString(undefined, { maximumFractionDigits: 1 })}%</span></div></>}
      </div>}
      {phase === 2 && !issue && metrics.length === 0 && <p className={css.hint}>{t('noCoreMetrics')}</p>}
      {(reportedAt !== undefined || remote?.updatedAt !== undefined) && <p className={css.reportTime}><time>{t(reportedAt === undefined ? 'stageUpdatedAt' : 'agentReportedAt', { time: new Date(reportedAt ?? remote!.updatedAt).toLocaleString() })}</time></p>}
    </div>
    <div className={css.workActions}>
      {stopping.blocked && onInterrupt !== undefined && <Button variant="primary" size="sm" onClick={onInterrupt}>{t('retryInterruption')}</Button>}
      {(retrying || row.state === 'failed' && row.preparation?.protocol === 4 && local) && <Button variant="primary" size="sm" disabled={retrying || stopping.busy || stopping.blocked} icon={retrying ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular />} onClick={onRetry}>{t(retrying ? 'retrying' : 'retryPreparation')}</Button>}
      {issue && !local && <Button variant="primary" size="sm" onClick={onRecords}>{t('viewFailureRecords')}</Button>}
      {!retrying && !issue && phase === 1 && remote?.plan !== undefined && <Button variant="primary" size="sm" onClick={onPlan}>{t(status === 'awaiting-approval' ? 'reviewPlan' : 'viewPlan')}</Button>}
      {!issue && phase === 2 && <Button variant="primary" size="sm" onClick={status === 'serving' ? onServices : onMonitor}>{t(status === 'serving' ? 'services' : 'monitoring')}</Button>}
      {phase === 3 && <Button variant="primary" size="sm" onClick={onFiles}>{t('viewOutputFiles')}</Button>}
      {(!issue || local) && <Button variant="ghost" size="sm" onClick={onRecords}>{t('viewAgentRecords')}</Button>}
      {issue && <Button variant="ghost" size="sm" onClick={onDiagnostics}>{t('viewDiagnostics')}</Button>}
      {phase >= 2 && remote?.plan !== undefined && <Button variant="ghost" size="sm" onClick={onPlan}>{t('viewPlan')}</Button>}
    </div>
  </section>
}
