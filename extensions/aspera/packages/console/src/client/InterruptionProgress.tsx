/** Program-confirmed stopping and release are distinct from Agent training reports. */
import { StateDot, IconCheckOutlineRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentInterruptionStatus } from '@aspera/experiments/types'
import css from './ExperimentsPage.module.css'

/** @param props - retained operation facts and localized labels. @returns compact node progress with expandable diagnostics. */
export function InterruptionProgress({ status, t }: { status: ExperimentInterruptionStatus; t: TranslateNS<'experiments'> }) {
  const busy = !['released', 'blocked'].includes(status.phase)
  return <section className={css.interruptionProgress} aria-label={t('interruptionProgress')} aria-busy={busy}>
    <div className={css.sectionHeading}><h4>{t(status.stopRequested ? 'interruptionProgress' : 'remoteTaskExitVerification')}</h4><span className={css.hint}>{t(status.phase === 'blocked' ? 'interruptionBlocked' : status.phase === 'released' ? 'interruptionReleased' : status.stopRequested ? 'interruptingExperiment' : 'remoteTaskChecking')}</span></div>
    {status.phase === 'released' && <p className={css.hint}>{t(status.result !== undefined && ['completed', 'failed', 'blocked'].includes(status.result.state) ? 'interruptionRetainedOutcome' : status.stopRequested ? 'interruptionCompleteHint' : 'recoveryInterruptedHint')}</p>}
    <ul className={css.interruptionNodes}>{status.nodes.map(node => <li key={node.serverId}>
      <span aria-hidden="true">{node.phase === 'released' ? <IconCheckOutlineRegular size={16} /> : node.phase === 'blocked' ? <IconWarningOutlineRegular size={16} /> : busy ? <StateDot state="ongoing" size={16} /> : <StateDot state="idle" />}</span>
      <div><span>{node.name}</span><small>{t(node.phase === 'released' ? 'interruptionReleased' : node.phase === 'blocked' ? 'interruptionBlocked' : node.phase === 'stopping' ? 'interruptionStopping' : node.phase === 'pending' ? 'interruptionPending' : 'interruptionVerifying')}</small>
        <small>{t('interruptionAgents')}: {t(node.agentsExited ? 'interruptionConfirmed' : 'interruptionPending')} · {t('interruptionCommands')}: {t(node.commandsReleased ? 'interruptionConfirmed' : 'interruptionPending')} · {t('interruptionServices')}: {t(node.servicesReleased ? 'interruptionConfirmed' : 'interruptionPending')}</small>
      </div>
    </li>)}</ul>
    {(status.detail !== undefined || status.nodes.some(node => node.detail !== undefined)) && <details className={css.advanced}><summary>{t('interruptionDetails')}</summary>
      {status.detail !== undefined && <pre className={css.prewrap}>{status.detail}</pre>}{status.nodes.filter(node => node.detail !== undefined).map(node => <p className={css.prewrap} key={node.serverId}>{node.name} · {node.detail}</p>)}</details>}
    <time className={css.hint} dateTime={new Date(status.updatedAt).toISOString()}>{t('interruptionUpdatedAt', { time: new Date(status.updatedAt).toLocaleString() })}</time>
  </section>
}
