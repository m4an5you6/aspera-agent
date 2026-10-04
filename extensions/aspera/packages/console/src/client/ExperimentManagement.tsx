/** Compact experiment management and explicit deletion confirmation. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Button, Checkbox, Input, Menu, Modal, Tag, Toast, Tooltip, StateDot,
  IconEllipsisOutlineRegular, IconTrashOutlineRegular, IconWarningOutlineRegular,
  IconClockOutlineRegular, IconCheckCircleOutlineRegular, IconCloseCircleFillRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FleetExperiment, ExperimentDeletion, ExperimentDeletionPreview } from '@aspera/dispatch/types'
import { experimentRemovalBlocker } from '@aspera/dispatch/server-usage'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentsController } from './controller.ts'
import type { ExperimentsPageProps } from './ExperimentsPage.tsx'
import type { ExperimentLocaleKey } from './locales.ts'
import { experimentProgress, experimentPhases } from './experiment-progress.ts'
import { experimentTodos } from './attention.ts'
import css from './ExperimentsPage.module.css'

type Props = { controller: ExperimentsController; t: TranslateNS<'experiments'> }

/** @param props - actual experiment status. @returns consistent text, glyph and semantic color. */
export function ExperimentStatus({ row, t }: { row: FleetExperiment; t: Props['t'] }) {
  const { status } = experimentProgress(row)
  const danger = status === 'failed' || status === 'interrupted'
  const warning = ['blocked', 'awaiting-approval', 'waiting-reply'].includes(status)
  const success = status === 'completed' || status === 'serving'
  return <Tag tone={danger ? 'danger' : warning ? 'warning' : success ? 'success' : status === 'cancelled' ? 'neutral' : 'info'}
    className={`${css.statusTag} ${status === 'queued' ? css.queuedTag : ''}`}>
    {danger ? <IconCloseCircleFillRegular size={14} /> : warning ? <IconWarningOutlineRegular size={14} />
      : success ? <IconCheckCircleOutlineRegular size={14} /> : <IconClockOutlineRegular size={14} />}{t(status)}
  </Tag>
}

/** @param props - plugin-owned feedback. @returns a notification that survives page navigation. */
export function ManagementFeedback({ controller, useExperiments, t }: ExperimentsPageProps) {
  const toast = useExperiments(value => value.toast)
  return toast === null ? null : <Toast key={toast.sequence} text={t(toast.key)} {...(toast.failed ? { icon: <IconWarningOutlineRegular /> } : { tone: 'success' as const })}
    onDone={() => { controller.clearToast() }} />
}

/** @param props - confirmed record selection. @returns a recoverable deletion dialog. */
export function DeleteExperimentsDialog({ controller, t, ids, close }: Props & { ids: string[]; close: () => void }) {
  const live = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
  const [preview, setPreview] = useState<ExperimentDeletionPreview[]>()
  const [cleanup, setCleanup] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [results, setResults] = useState<ExperimentDeletion[]>([])
  const operation = useRef(controller.newId())
  useEffect(() => {
    let mounted = true
    void controller.previewDeletion(ids).then(value => { if (mounted) setPreview(value) }, reason => { if (mounted) setError(String(reason)) })
    return () => { mounted = false }
  }, [controller, ids])
  const submit = async () => {
    if (busy || preview === undefined) return
    setBusy(true); setError(undefined)
    try {
      const result = await controller.deleteExperiments(preview.map(row => row.experimentId), cleanup, operation.current)
      setResults(result)
      const remaining = preview.filter(row => !result.some(value => value.experimentId === row.experimentId && value.state === 'deleted'))
      setPreview(remaining)
      if (result.every(row => row.state === 'deleted')) close()
    } catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  const stop = async (id: string) => {
    setBusy(true)
    try { await controller.cancel(id); setPreview(await controller.previewDeletion(preview?.map(row => row.experimentId) ?? ids)) }
    catch (reason) { setError(String(reason)) }
    finally { setBusy(false) }
  }
  return <Modal open onClose={() => { if (!busy) close() }} title={t('deleteExperiments')} closeLabel={t('close')} backdropBlur={false} className={css.serverModal} contentClassName={css.serverModalContent}>
    <div className={css.deleteContent}>
      <p>{t('deleteRecordsHint')}</p>
      {preview === undefined && error === undefined && <StateDot state="ongoing" />}
      {preview?.map(row => <div key={row.experimentId} className={css.deleteRow}>
        <strong>{row.name}</strong>
        {!row.eligible && <><p className={css.hint}>{t(row.reason === 'cleanup-unconfirmed' ? 'deleteCleanupUnconfirmed' : 'deleteStopFirst')}</p>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void stop(row.experimentId) }}>{t('cancel')}</Button></>}
        {cleanup && row.nodes.map(node => <p className={css.cleanupPath} key={node.serverId}>{node.name} · {t(live.deletions.find(job => job.experimentId === row.experimentId)?.nodes.find(value => value.serverId === node.serverId)?.state === 'cleaned' ? 'cleanupDone' : busy ? 'deleting' : 'cleanupPending')}<code>{node.path}</code></p>)}
      </div>)}
      <Checkbox label={t('cleanupRemoteFiles')} checked={cleanup} disabled={busy || preview?.some(row => row.eligible && !row.cleanupAvailable)}
        onChange={value => { setCleanup(value); operation.current = controller.newId() }} />
      <p className={css.hint}>{t('cleanupScopeHint')}</p>
      {preview?.some(row => !row.cleanupAvailable) && <p className={css.hint}>{t('cleanupUnavailable')}</p>}
      {results.filter(row => row.state !== 'deleted').map(row => <details key={row.experimentId} className={css.operationError}><summary>{t('deletionIncomplete')}</summary><p>{row.detail}</p></details>)}
      {error !== undefined && <details className={css.operationError} open><summary>{t('error')}</summary><p>{error}</p></details>}
      <div className={css.modalActions}><Button variant="ghost" disabled={busy} onClick={close}>{t('discard')}</Button>
        <Button variant="primary" className={css.destructiveButton} disabled={busy || !preview?.some(row => row.eligible)} icon={busy ? <StateDot state="ongoing" /> : <IconTrashOutlineRegular />}
          onClick={() => { void submit() }}>{t(busy ? 'deleting' : cleanup ? 'confirmDeleteAndCleanup' : 'confirmDeleteRecords')}</Button></div>
    </div>
  </Modal>
}

function RowMenu({ row, controller, t, clone, remove }: Props & { row: FleetExperiment; clone: () => void; remove: () => void }) {
  const [open, setOpen] = useState(false)
  return <Menu open={open} portal onClose={() => { setOpen(false) }} items={[
    { id: 'open', label: t('openExperiment') }, { id: 'copy', label: t('clone') },
    { id: 'delete', label: <span className={css.dangerText}>{t('deleteExperiment')}</span> },
  ]} onSelect={id => { setOpen(false); if (id === 'open') controller.select(row.request.experimentId); else if (id === 'copy') clone(); else if (id === 'delete') remove() }}
    anchor={<Tooltip label={t('moreActions')} portal><Button variant="ghost" size="sm" aria-label={`${t('moreActions')} ${row.request.name ?? row.request.experimentId}`}
      icon={<IconEllipsisOutlineRegular />} onClick={() => { setOpen(!open) }} /></Tooltip>} />
}

/** @param props - saved records and navigation. @returns the approved compact table with shared status semantics. */
export function ExperimentList({ controller, t, rows, onClone, pendingOnly, onPendingChange }: Props & { rows: FleetExperiment[]; onClone: (row: FleetExperiment) => void; pendingOnly: boolean; onPendingChange: (pending: boolean) => void }) {
  const management = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'pending' | 'attention' | 'active' | 'ended'>(pendingOnly ? 'pending' : 'all')
  const [selected, setSelected] = useState<string[]>([])
  const [deleting, setDeleting] = useState<string[]>()
  useEffect(() => { if (pendingOnly) setFilter('pending') }, [pendingOnly])
  const changeFilter = (value: typeof filter) => { setFilter(value); onPendingChange(value === 'pending'); setSelected([]) }
  const attention = (row: FleetExperiment) => experimentProgress(row).attention
  const pending = (row: FleetExperiment) => experimentTodos([row]).length > 0
  const ended = (row: FleetExperiment) => experimentRemovalBlocker(row) === undefined
  const active = (row: FleetExperiment) => !attention(row) && !ended(row)
  const visible = rows.filter(row => (filter === 'all' || (filter === 'pending' ? pending(row) : filter === 'attention' ? attention(row) : filter === 'active' ? active(row) : ended(row)))
    && `${row.request.name ?? ''} ${row.request.objective} ${row.servers.map(node => node.name).join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const selectedVisible = visible.filter(row => selected.includes(row.request.experimentId))
  const filters: { id: typeof filter; key: ExperimentLocaleKey; count: number }[] = [
    { id: 'all', key: 'all', count: rows.length }, { id: 'attention', key: 'needsAttention', count: rows.filter(attention).length },
    { id: 'active', key: 'inProgress', count: rows.filter(active).length }, { id: 'ended', key: 'endedExperiments', count: rows.filter(ended).length },
  ]
  const tabs = [filters[0]!, { id: 'pending' as const, key: 'pending' as const, count: rows.filter(pending).length }, ...filters.slice(1)]
  return <div className={css.list}>
    <div className={css.listSummary}>{filters.map(item => <button key={item.id} aria-pressed={filter === item.id} onClick={() => { changeFilter(item.id) }}>
      <span>{t(item.key)}</span><strong>{item.count}</strong></button>)}</div>
    <div className={css.listToolbar}><div className={css.filterTabs}>{tabs.map(item => <Button key={item.id} size="sm" variant="ghost" aria-pressed={filter === item.id}
      onClick={() => { changeFilter(item.id) }}>{t(item.key)}</Button>)}</div>
      <Input aria-label={t('search')} placeholder={t('search')} value={search} onChange={event => { setSearch(event.target.value); setSelected([]) }} /></div>
    {selectedVisible.length > 0 && <div className={css.batchBar}><span>{t('selectedExperiments', { count: selectedVisible.length })}</span><Button variant="ghost" size="sm" className={css.dangerText}
      icon={<IconTrashOutlineRegular />} onClick={() => { setDeleting(selectedVisible.map(row => row.request.experimentId)) }}>{t('batchDelete')}</Button></div>}
    {visible.length === 0 ? <div className={css.emptyState}><h2>{t(rows.length === 0 ? 'empty' : 'noMatches')}</h2><p>{t('newHint')}</p></div>
      : <div className={css.managementTableWrap}><table className={css.managementTable}><thead><tr>
        <th className={css.checkColumn}><Checkbox label={t('selectVisible')} checked={visible.every(row => selected.includes(row.request.experimentId))}
          onChange={value => { setSelected(value ? visible.map(row => row.request.experimentId) : []) }} /></th>
        <th>{t('shortName')}</th><th>{t('status')}</th><th>{t('latestStage')}</th><th>{t('servers')}</th><th>{t('updated')}</th><th className={css.actionColumn}>{t('actions')}</th>
      </tr></thead><tbody>{visible.map(row => {
        const id = row.request.experimentId
        const name = row.request.name ?? row.request.objective.split('\n')[0]?.slice(0, 120)
        const progress = experimentProgress(row)
        const phase = row.latest?.progress?.phase ?? t(progress.local && row.preparation !== undefined ? row.preparation.stage : experimentPhases[progress.phase])
        const deletion = management.deletions.find(value => value.experimentId === id && value.started && value.state !== 'deleted')
        const detail = deletion?.detail ?? row.latest?.detail ?? row.detail
        return <tr key={id} data-experiment-id={id} data-selected={selected.includes(id)}>
          <td className={css.checkColumn}><Checkbox label={`${t('selectExperiment')} ${name}`} checked={selected.includes(id)} onChange={value => { setSelected(current => value ? [...current, id] : current.filter(item => item !== id)) }} /></td>
          <td><button className={css.rowLink} onClick={() => { controller.select(id) }}>{name}</button><small>{t(row.request.mode)} · {row.coordinator.name}</small></td>
          <td><ExperimentStatus row={row} t={t} /></td>
          <td><span className={css.stageText}>{deletion === undefined ? phase : t(deletion.state === 'deleting' ? 'deleting' : 'deletionIncomplete')}</span>{detail !== undefined && <Tooltip label={detail} portal><button className={css.issueLink} onClick={() => { if (deletion === undefined) controller.select(id); else setDeleting([id]) }}>{t('viewIssue')}</button></Tooltip>}</td>
          <td><span className={css.stageText}>{row.servers.map(server => server.name).join(' · ')}</span></td>
          <td><time dateTime={new Date(row.latest?.updatedAt ?? row.createdAt).toISOString()}>{new Date(row.latest?.updatedAt ?? row.createdAt).toLocaleString()}</time></td>
          <td className={css.actionColumn}><RowMenu row={row} controller={controller} t={t} clone={() => { onClone(row) }} remove={() => { setDeleting([id]) }} /></td>
        </tr>
      })}</tbody></table></div>}
    {deleting !== undefined && <DeleteExperimentsDialog ids={deleting} controller={controller} t={t} close={() => { setDeleting(undefined); setSelected([]) }} />}
  </div>
}
