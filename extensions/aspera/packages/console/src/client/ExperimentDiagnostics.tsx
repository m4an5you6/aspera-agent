/** Retained raw errors and Agent metrics are available without dominating the overview. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment } from '@aspera/dispatch/types'
import { diagnosticMetricLabel } from './overview-data.ts'
import { experimentProgress } from './experiment-progress.ts'
import css from './ExperimentsPage.module.css'

/** @param props - saved diagnostics and optional read failure. @returns a collapsed disclosure with original evidence preserved. */
export function ExperimentDiagnostics({ row, t, readError }: { row: FleetExperiment; t: TranslateNS<'experiments'>; readError: string | undefined }) {
  const { remote, issue } = experimentProgress(row)
  const detail = remote?.detail ?? row.detail
  const metrics = remote?.progress?.metrics ?? {}
  const entries = Object.entries(metrics)
  const activity = remote?.progress?.phase
  if (detail === undefined && entries.length === 0 && readError === undefined && activity === undefined) return null
  return <section className={css.diagnostics} aria-label={t('diagnostics')}>
    <details><summary><span>{t('diagnostics')}</span><small>{entries.length > 0 ? t('diagnosticCount', { count: entries.length }) : t('retainedDiagnostics')}</small></summary>
      <div className={css.diagnosticBody}>
        {detail !== undefined && <details><summary>{t(issue ? 'lastError' : 'stageDetails')}</summary><pre className={css.log}>{detail}</pre></details>}
        {activity !== undefined && <details><summary>{t('lastRecordedAction')}</summary><pre className={css.log}>{activity}</pre></details>}
        {readError !== undefined && <details><summary>{t('stepReadError')}</summary><pre className={css.log}>{readError}</pre></details>}
        {entries.length > 0 && <><p className={css.hint}>{t('diagnosticMetricsHint')}</p><dl className={css.diagnosticMetrics}>{entries.map(([name, value]) => {
          const label = diagnosticMetricLabel(name)
          return <div key={name}><dt>{label === undefined ? name : t(label)}</dt><dd>{value.toLocaleString()}</dd></div>
        })}</dl><details><summary>{t('rawMetricFields')}</summary><pre className={css.log}>{JSON.stringify(metrics, null, 2)}</pre></details></>}
      </div>
    </details>
  </section>
}
