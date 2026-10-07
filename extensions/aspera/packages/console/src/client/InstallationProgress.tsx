/** Saved installation progress occupies the existing preparation work area. */
import { useEffect, useState } from 'react'
import { Button, Tag, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment, InstallationProgress as Progress } from '@aspera/dispatch/types'
import css from './ExperimentsPage.module.css'

/** @param props - fixed budgets, sources and actual remote progress. @returns compact recovery facts and retained history. */
export function InstallationProgress({ row, installations, t, onLogs }: {
  row: FleetExperiment; installations: Progress[]; t: TranslateNS<'experiments'>; onLogs: () => void
}) {
  const [clock, setClock] = useState(Date.now)
  const live = installations.some(value => ['pending', 'installing', 'diagnosing'].includes(value.round.state))
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => { setClock(Date.now()) }, 1000)
    return () => { clearInterval(timer) }
  }, [live])
  if (installations.length === 0) return null
  return <section className={css.installation} aria-label={t('installationRecovery')}>
    <div className={css.sectionHeading}><h4>{t('installationRecovery')}</h4><Button size="sm" variant="ghost" onClick={onLogs}>{t('installationLogs')}</Button></div>
    {installations.map(({ serverId, round, policy, history }) => {
      const attempt = round.attempts.at(-1)
      const status = attempt?.status
      const ended = ['verified', 'failed', 'cancelled'].includes(round.state)
      const used = Math.min(policy.installationTotalTimeoutMs, Math.max(0, (ended ? round.finishedAt ?? status?.updatedAt ?? clock : clock) - round.startedAt))
      const seconds = Math.floor(used / 1000)
      const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
      const node = row.servers.find(value => value.id === serverId) ?? row.coordinator
      return <article key={serverId} className={css.installationNode}>
        <div className={css.sectionHeading}><strong>{node.name}</strong><Tag tone={round.state === 'verified' ? 'success' : round.state === 'unconfirmed' || round.state === 'failed' ? 'warning' : 'info'}>{t(round.state === 'verified' ? 'installationVerified' : round.state === 'diagnosing' ? 'installationDiagnosing' : round.state === 'failed' ? 'installationStopped' : round.state === 'unconfirmed' ? 'installationUnconfirmed' : round.state === 'cancelled' ? 'cancelled' : 'installingRelease')}</Tag></div>
        <dl className={css.installationFacts}>
          <dt>{t('installationStep')}</dt><dd>{t(!status || status.phase === 'starting' ? 'preparingInstaller' : status.phase === 'checking-material' ? 'checkingOriginalMaterial' : status.phase === 'download-node-headers' ? 'downloadingNodeHeaders' : status.phase === 'installed-release' ? 'verifyingInstalledRelease' : 'installingDependencies')}</dd>
          <dt>{t('installationElapsed')}</dt><dd>{time} / {t('installationMinutes', { count: Math.round(policy.installationTotalTimeoutMs / 60000) })}</dd>
          <dt>{t('installationRetries')}</dt><dd>{Math.max(0, round.attempts.length - 1)} / {policy.installationMaxRetries}</dd>
          <dt>{t('npmSource')}</dt><dd><Tooltip label={round.sources.npm} portal><span tabIndex={0} className={css.installationSource}>{round.sources.npm}</span></Tooltip></dd>
          <dt>{t('nodeHeaderSource')}</dt><dd><Tooltip label={round.sources.nodeHeaders} portal><span tabIndex={0} className={css.installationSource}>{round.sources.nodeHeaders}</span></Tooltip></dd>
        </dl>
        {round.state === 'unconfirmed' && <p className={css.hint}>{t('installationExitUnconfirmed')}</p>}
        {round.detail && <p className={css.prewrap}>{round.detail}</p>}
        {(round.attempts.length > 0 || round.changes.length > 0) && <details><summary>{t('installationHistory')}</summary>
          <ol>{round.attempts.map((entry, index) => <li key={entry.id}><time>{new Date(entry.startedAt).toLocaleString()}</time> · {t('installationAttempt', { count: index + 1 })}<p className={css.hint}>{entry.status?.reason ?? entry.sources.npm}</p>{entry.notices.map(notice => <p key={notice.code} className={css.prewrap}><time>{new Date(notice.time).toLocaleString()}</time> · {notice.reason}</p>)}</li>)}</ol>
          {round.changes.map(change => <p key={change.id} className={css.prewrap}><time>{new Date(change.changedAt).toLocaleString()}</time> · {change.reason}<br />{change.previous[change.probe.kind]} → {change.next[change.probe.kind]}</p>)}
          {history.map(previous => <details key={previous.id}><summary>{new Date(previous.startedAt).toLocaleString()} · {t('installationHistory')}</summary><p className={css.prewrap}>{previous.detail}</p><ol>{previous.attempts.map((entry, index) => <li key={entry.id}>{t('installationAttempt', { count: index + 1 })} · {entry.status?.reason ?? entry.sources.npm}</li>)}</ol></details>)}
        </details>}
      </article>
    })}
  </section>
}
