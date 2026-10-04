/** Current work and recovery actions, backed by saved experiment progress. */
import { Button, Tag, StateDot, IconCheckOutlineRegular, IconWarningOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment } from '@aspera/dispatch/types'
import { experimentPhases, experimentProgress } from './experiment-progress.ts'
import css from './ExperimentsPage.module.css'

/**
 * Render the active work area with retained diagnostics and real navigation actions.
 * @param props - saved experiment, pending retry and detail-page navigation.
 * @returns the current-stage card; Agent claims never mark checks complete.
 */
export function ExperimentStage({ row, t, retrying, onRetry, onRecords, onMonitor, onFiles, onServices, onPlan }: {
  row: FleetExperiment; t: TranslateNS<'experiments'>; retrying: boolean; onRetry: () => void; onRecords: () => void
  onMonitor: () => void; onFiles: () => void; onServices: () => void; onPlan: () => void
}) {
  const { phase, status, local, issue, attention, busy, remote } = experimentProgress(row)
  const detail = remote?.detail ?? row.detail
  const active = busy || retrying
  const stopped = issue || status === 'cancelled'
  const step = remote?.progress?.phase || (local && row.preparation !== undefined ? t(row.preparation.stage) : undefined)
  const title = retrying ? t('retryingPreparation') : local && issue ? t('preparationFailed')
    : phase === 1 && ['preparing', 'planning'].includes(status) ? t('planningWork') : status === 'running' ? t('executionWork')
      : status === 'completed' ? t('resultsReady') : local && busy ? t('preparationWork') : t(status)
  const tone = retrying ? 'active' : attention ? 'attention' : status === 'completed' ? 'complete' : busy ? 'active' : 'idle'
  return <section className={css.stageCard} aria-label={t('latestStage')} data-tone={tone} aria-busy={active}>
    <div className={css.workHeader}>
      <div className={css.sectionHeading}><span className={css.hint}>{t('latestStage')} · {t(experimentPhases[phase]!)}</span><Tag tone={attention && !retrying ? 'warning' : status === 'completed' ? 'success' : 'neutral'}>{t(retrying ? 'retrying' : status)}</Tag></div>
      <div className={css.workTitle}><span className={css.workIcon} aria-hidden="true">{active ? <StateDot state="ongoing" size={22} /> : attention ? <IconWarningOutlineRegular size={22} /> : status === 'completed' ? <IconCheckOutlineRegular size={22} /> : <StateDot state="idle" size={16} />}</span><h3>{title}</h3></div>
      <p className={css.workDescription}>{t(retrying ? 'retryingHint' : issue ? 'failedHint' : status === 'awaiting-approval' ? 'planHint'
        : status === 'waiting-reply' ? 'questionPauseHint' : status === 'completed' ? 'resultsHint' : status === 'cancelled' ? 'cancelledHint'
          : status === 'cancelling' ? 'cancellingHint' : local ? 'preparationHint' : phase === 1 ? 'planningHint' : status === 'queued' ? 'queuedHint' : 'executionHint')}</p>
    </div>
    <div className={css.workBody}>
      {step !== undefined && <div className={css.currentActivity}><span className={css.hint}>{t(stopped || retrying ? 'lastRecordedAction' : 'currentAction')}</span><p>{step}</p></div>}
      {row.waitingFor.length > 0 && <p>{t('waiting', { servers: row.servers.filter(server => row.waitingFor.includes(server.id)).map(server => server.name).join(', ') })}</p>}
      {remote?.resourcesReleased === false && ['failed', 'blocked', 'interrupted', 'cancelling'].includes(status) && <p>{t('held')}</p>}
      {detail !== undefined && <div className={css.stageMessage} role={issue && !retrying ? 'alert' : undefined}>
        <details><summary>{t(issue ? 'lastError' : 'stageDetails')}</summary><pre className={css.log}>{detail}</pre></details>
      </div>}
      {remote?.progress !== undefined && Object.keys(remote.progress.metrics).length > 0 && <div className={css.workMetrics}>
        <dl>{Object.entries(remote.progress.metrics).map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value.toLocaleString()}</dd></div>)}</dl>
        <p className={css.hint}>{t('latestMetrics', { time: new Date(remote.progress.updatedAt).toLocaleString() })}</p>
      </div>}
    </div>
    <div className={css.workActions}>
      {(retrying || row.state === 'failed' && row.preparation?.protocol === 4 && local) && <Button variant="primary" size="sm" disabled={retrying} icon={retrying ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular />} onClick={onRetry}>{t(retrying ? 'retrying' : 'retryPreparation')}</Button>}
      {!retrying && !issue && phase === 1 && remote?.plan !== undefined && <Button variant="primary" size="sm" onClick={onPlan}>{t(status === 'awaiting-approval' ? 'reviewPlan' : 'viewPlan')}</Button>}
      {!issue && phase === 2 && <Button variant="primary" size="sm" onClick={status === 'serving' ? onServices : onMonitor}>{t(status === 'serving' ? 'services' : 'monitoring')}</Button>}
      {phase === 3 && <Button variant="primary" size="sm" onClick={onFiles}>{t('viewOutputFiles')}</Button>}
      <Button variant="ghost" size="sm" onClick={onRecords}>{t('viewAgentRecords')}</Button>
      {phase >= 2 && remote?.plan !== undefined && <Button variant="ghost" size="sm" onClick={onPlan}>{t('viewPlan')}</Button>}
    </div>
  </section>
}
