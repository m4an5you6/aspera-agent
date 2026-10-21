/** Program observations refresh independently of the pending Agent command tool. */
import { useEffect, useState } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentFinalizationStatus } from '@aspera/experiments/types'
import type { ExperimentsController } from './controller.ts'
import css from './ExperimentsPage.module.css'

/** @param props - fixed task, activity and lightweight reader. @returns command waits, stage arithmetic and separately classified finish diagnostics. */
export function FinalizationStatus({ id, active, controller, t }: { id: string; active: boolean; controller: ExperimentsController; t: TranslateNS<'experiments'> }) {
  const [value, setValue] = useState<ExperimentFinalizationStatus>(), [error, setError] = useState<string>()
  useEffect(() => {
    let alive = true, pending = false
    const read = async () => {
      if (!alive || pending) return
      pending = true
      try { const result = await controller.finalizationStatus(id); if (alive && result.experimentId === id) { setValue(result); setError(result.error) } }
      catch (failure) { if (alive) setError(String(failure)) }
      finally { pending = false }
    }
    setValue(undefined); setError(undefined); void read()
    const timer = active ? setInterval(() => { void read() }, controller.displayLimits().pollIntervalMs) : undefined
    return () => { alive = false; clearInterval(timer) }
  }, [id, active, controller])
  if (value?.supported !== true) return null
  const waiting = value.waits.filter(row => row.state === 'waiting' || row.state === 'unknown')
  const busy = active && !value.offline && waiting.some(row => row.state === 'waiting')
  return <section className={css.stageCard} aria-label={t('finalizationRecords')} aria-busy={busy} data-finalization-state={value.decision?.decision ?? (busy ? 'waiting' : 'observed')}>
    <div className={css.workBody}>
      <div className={css.sectionHeading}><h3>{t('finalizationRecords')}</h3>{busy && <StateDot state="ongoing" />}</div>
      <p className={css.hint}>{t(value.offline ? 'finalizationOffline' : 'finalizationProgramOwned')}</p>
      {waiting.map(row => <p key={`${row.serverId}/${row.commandId}`}>{row.commandId} · {t(row.state === 'unknown' ? 'finalizationExitUnknown' : 'finalizationWaiting')} · {t('finalizationElapsed', { seconds: Math.floor(row.elapsedMs / 1000) })}</p>)}
      {value.stages.map(stage => <div key={`${stage.serverId}/${stage.stageId}`}><p>{stage.stageId} · {t(stage.ready ? 'reviewStagePassed' : 'reviewStagePending')}</p>
        <p className={css.hint}>{t('stageOptimizerCounts', { start: stage.startStep, additional: stage.additionalSteps, end: stage.endStep })}</p></div>)}
      {value.decision !== undefined && <p>{t(value.decision.verified ? 'finalizationReasonVerified' : 'finalizationReasonReported')}</p>}
      <time>{t('stageUpdatedAt', { time: new Date(value.observedAt).toLocaleString() })}</time>
      {(error !== undefined || value.decision !== undefined || value.stages.some(stage => !stage.ready)) && <details><summary>{t('reviewDiagnostics')}</summary>
        {error !== undefined && <p role="status">{error}</p>}
        {value.decision !== undefined && <pre className={css.log}>{value.decision.detail}</pre>}
        {value.stages.flatMap(stage => stage.checks.filter(check => !check.passed).map((check, index) => <p key={`${stage.serverId}/${stage.stageId}/${index}`}>{check.detail}</p>))}
      </details>}
      {value.truncated && <p>{t('finalizationTruncated')}</p>}
    </div>
  </section>
}
