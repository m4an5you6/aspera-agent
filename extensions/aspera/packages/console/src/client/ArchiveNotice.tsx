/** Copy availability remains visible beside retained records when remote execution is unconfirmed. */
import { Button, StateDot, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { useRunArchive } from './useRunArchive.ts'
import css from './ExperimentsPage.module.css'

const stateLabels = { idle: 'archiveWaiting', syncing: 'archiveSyncing', 'caught-up': 'archiveCaughtUp',
  disconnected: 'archiveOffline', paused: 'archivePaused', incomplete: 'archiveIncomplete' } as const
const gapLabels = {
  'Earlier metric samples are unavailable; only the retained remote window was recovered': 'archiveMetricGap',
  'No retained metric samples cover the interval between the saved and recovered windows': 'archiveMetricGap',
  'Source generation changed; earlier bytes remain in a separate copy': 'archiveGenerationGap',
  'Source discovery exceeded its configured limit': 'archiveDiscoveryLimit',
  'Agent events are missing for a saved Session': 'archiveEventsMissing',
} as const
function gapLabel(value: string, t: TranslateNS<'experiments'>): string {
  const entry = Object.entries(gapLabels).find(([message]) => message === value)
  return entry === undefined ? value : t(entry[1])
}

/** @param props - retained experiment and detail-owned copy reads. @returns current copy health with separate historical gaps. */
export function ArchiveNotice({ row, archive, t }: { row: FleetExperiment; archive: ReturnType<typeof useRunArchive>;
  t: TranslateNS<'experiments'> }) {
  const { status, error, syncing, sync } = archive
  const state = status?.state === 'incomplete' ? 'caught-up' : status?.state ?? 'idle'
  const ended = row.latest?.resourcesReleased && ['completed', 'failed', 'cancelled', 'blocked', 'interrupted'].includes(row.latest.state)
  const pendingBytes = status?.sources.reduce((total, source) => total + source.pendingBytes, 0) ?? 0
  const gaps = [...new Set(status?.gaps ?? [])]
  const sourceGaps = status?.sources.filter(source => source.gaps.length > 0) ?? []
  const gapCount = gaps.length + sourceGaps.reduce((count, source) => count + source.gaps.length, 0)
  const label = state === 'caught-up' ? ended ? 'archiveSaved' : 'archiveAutomatic' : stateLabels[state]
  return <section className={css.archiveNotice} aria-label={t('archiveTitle')} data-state={state}>
    <div className={css.archiveHeading}><h3>{t('archiveTitle')}</h3>
      <Button variant="ghost" size="sm" icon={syncing ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular />} disabled={syncing}
        onClick={sync}>{t('archiveSyncAction')}</Button></div>
    <p className={css.archiveStatus}><StateDot state={state === 'caught-up' ? 'done' : state === 'paused' || state === 'disconnected' ? 'warning' : 'idle'} />{t(label)}</p>
    <dl className={css.archiveFacts}>
      <div><dt>{t('archiveLastSync')}</dt><dd>{status?.lastSyncedAt === undefined ? t('archiveNoCopy') : <time dateTime={new Date(status.lastSyncedAt).toISOString()}>{new Date(status.lastSyncedAt).toLocaleString()}</time>}</dd></div>
      {status !== undefined && <div><dt>{t('archiveSize')}</dt><dd>{t('archiveMiB', { size: (status.savedBytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 }) })}</dd></div>}
      {pendingBytes > 0 && <div><dt>{t('archivePending')}</dt><dd>{t('archiveMiB', { size: (pendingBytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 }) })}</dd></div>}
    </dl>
    {state === 'syncing' && <p className={css.hint}>{t('archiveCatchupHint')}</p>}
    {state === 'disconnected' && <p className={css.hint}>{t('archiveRetryHint')}</p>}
    {error !== undefined && <p role="status" className={css.hint}>{t('archiveReadFailed')}</p>}
    {gapCount > 0 && <details className={css.archiveGaps}>
      <summary>{t('archiveHistoryGaps', { count: gapCount })}</summary>
      {gaps.map(gap => <p key={gap}>{gapLabel(gap, t)}</p>)}
      {sourceGaps.map(source => <div key={source.id}><span>{source.label}</span>{source.gaps.map(gap => <p key={gap}>{gapLabel(gap, t)}</p>)}</div>)}
    </details>}
    <details className={css.archiveDiagnostics}>
      <summary>{t('archiveDetails')}</summary>
      {status?.lastRemoteStateAt !== undefined && <p>{t('archiveStateRecordedAt', { time: new Date(status.lastRemoteStateAt).toLocaleString() })}</p>}
      {status?.runtimeAvailable === false && <p>{t('archiveRuntimeUnconfirmed')}</p>}
      {error !== undefined && <code>{error}</code>}
      {status?.error !== undefined && <pre className={css.log}>{status.error}</pre>}
      <ul className={css.archiveSources}>{status?.sources.map(source => <li key={source.id}><span>{row.servers.find(server => server.id === source.serverId)?.name} · {source.kind === 'trace' ? t(source.phase === 'planning' ? 'phasePlanning' : 'phaseExecution') : source.label}</span>
        <span>{t(stateLabels[source.state])}</span></li>)}</ul>
    </details>
  </section>
}
