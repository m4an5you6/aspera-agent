/** Peer server cards, dated observations and on-demand password reveal. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Modal, Tag, Tooltip, StateDot, IconTrashOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ServerSettings, ServerProbe, ServerDeletionPreview } from '@aspera/dispatch/types'
import { ExperimentStatus } from './ExperimentManagement.tsx'
import { serverRemovalBlockers } from '@aspera/dispatch/server-usage'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentsController } from './controller.ts'
import css from './ExperimentsPage.module.css'

type Props = { controller: ExperimentsController; t: TranslateNS<'experiments'> }

/** @param props - editor account. @returns a masked field that never submits the display mask or an unchanged revealed value. */
export function ServerPassword({ controller, t, server }: Props & { server?: ServerSettings | undefined }) {
  const [value, setValue] = useState('')
  const [dirty, setDirty] = useState(false)
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const revision = useRef(0)
  useEffect(() => () => { revision.current++ }, [])
  const toggle = async () => {
    const request = ++revision.current
    if (visible) { setVisible(false); if (!dirty) setValue(''); return }
    if (server === undefined || dirty) { setVisible(true); return }
    setBusy(true); setError(false)
    try {
      const password = await controller.revealServerPassword(server.id)
      if (revision.current === request) { setValue(password); setVisible(true) }
    } catch (error) { /* Credential errors are kept out of page notifications. */ void error; if (revision.current === request) setError(true) }
    finally { if (revision.current === request) setBusy(false) }
  }
  return <div className={css.passwordField}><span>{t('password')}</span><div className={css.passwordControl}>
    <Input aria-label={t('password')} type={visible ? 'text' : 'password'} autoComplete="new-password" required={server === undefined} value={value}
      placeholder={server === undefined ? undefined : '••••••••'} onChange={event => { revision.current++; setBusy(false); setValue(event.target.value); setDirty(true) }} />
    <input type="hidden" name="password" value={dirty ? value : ''} />
    <Tooltip label={t(visible ? 'hidePassword' : 'showPassword')} portal><Button variant="ghost" size="sm" disabled={busy} aria-label={t(visible ? 'hidePassword' : 'showPassword')}
      aria-pressed={visible} onClick={() => { void toggle() }} icon={busy ? <StateDot state="ongoing" /> : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" />{visible && <path d="m3 3 18 18" />}</svg>} /></Tooltip>
  </div>{error && <span className={css.operationError} role="alert">{t('passwordRevealFailed')}</span>}</div>
}

function Hardware({ probe, t }: { probe: ServerProbe; t: Props['t'] }) {
  return <div className={css.hardwareDetails}>
    <pre className={css.log}>{probe.gpuInfo || t('gpuUnavailable')}</pre>
    {probe.environmentReady === false && <div><Tag tone="warning">{t('environmentIncomplete')}</Tag></div>}
    {probe.detail !== undefined && <details><summary>{t('environmentDiagnostics')}</summary><pre className={css.log}>{probe.detail}</pre></details>}
    {probe.inventory !== undefined && <details className={css.inventory}><summary>{t('storageInventory')}</summary>
      <p className={css.hint}>{t('observedAt', { time: new Date(probe.inventory.observedAt).toLocaleString() })}</p>
      <ul>{probe.inventory.candidates.map(candidate => <li key={candidate.id}><code>{candidate.directory}</code> · {t('availableGiB', { size: (candidate.availableBytes / 1073741824).toFixed(1) })} · {t(candidate.persistence)}</li>)}</ul>
      <p>{t('trainingAddress')}: {probe.inventory.addresses.map(item => item.address).join(' · ') || t('noNetworkAddress')}</p>
    </details>}
  </div>
}

/** @param props - registry state and editor navigation. @returns independently checked peer servers and explicit removal actions. */
export function ServerCards({ controller, t, state, edit }: Props & { state: ReturnType<ExperimentsController['store']['getSnapshot']>; edit: (server: ServerSettings) => void }) {
  const [removal, setRemoval] = useState<ServerSettings>()
  const [removalError, setRemovalError] = useState<string>()
  const [removalPreview, setRemovalPreview] = useState<ServerDeletionPreview>()
  const [previewAttempt, setPreviewAttempt] = useState(0)
  useEffect(() => {
    let live = true; setRemovalPreview(undefined); setRemovalError(undefined)
    if (removal !== undefined) void controller.previewServerRemoval(removal.id).then(value => { if (live) setRemovalPreview(value) },
      reason => { if (live) { setRemovalError(t('deleteServerFailedRetained')); controller.report(reason, { serverId: removal.id, operation: 'server-delete-preview' }) } })
    return () => { live = false }
  }, [controller, removal, previewAttempt, t])
  const blockers = (server: ServerSettings) => serverRemovalBlockers(server.id, state.experiments, state.registry.checks?.[server.id]?.result ?? state.registry.probes?.[server.id], state.deletedIds)
  const remove = async () => {
    if (removal === undefined) return
    try { await controller.removeServer(removal.id); setRemoval(undefined) }
    catch (error) { setRemovalError(t('deleteServerFailedRetained')); controller.report(error, { serverId: removal.id, operation: 'server-delete' }) }
  }
  return <>
    {state.registry.servers.length === 0 && <div className={css.emptyState}>{t('noServers')}</div>}
    {state.registry.servers.map(server => {
      const check = state.registry.checks?.[server.id]
      const probing = state.probing.includes(server.id) || check?.status === 'checking'
      const status = probing ? 'checking' : state.probeErrors[server.id] !== undefined ? 'failed' : check?.status ?? 'unchecked'
      const error = state.probeErrors[server.id] ?? check?.error
      const previous = check?.lastSuccess
      const current = status === 'passed' ? check?.result : undefined
      const old = previous?.result ?? state.registry.probes?.[server.id]
      const blocked = blockers(server)
      return <article key={server.id} className={css.serverCard} data-server-id={server.id}>
        <div className={css.cardHeading}><div><h2>{server.name}</h2><p className={css.hint}>{server.username}@{server.host}:{server.sshPort}</p></div>
          <Tag tone={status === 'passed' ? 'success' : status === 'failed' ? 'danger' : status === 'checking' ? 'info' : 'neutral'}>{t(`check-${status}`)}</Tag></div>
        {status === 'failed' && <div className={css.connectionFailure}><p>{t(error?.toLowerCase().includes('handshake') ? 'sshHandshakeFailed' : 'connectionFailedHint')}</p>
          {error !== undefined && <details><summary>{t('technicalDetails')}</summary><pre>{error}</pre></details>}</div>}
        <div className={css.serverFacts}><span>{t('linkedExperiments', { count: blocked.length })}</span>
          {check?.checkedAt !== undefined && <time>{t('observedAt', { time: new Date(check.checkedAt).toLocaleString() })}</time>}</div>
        {state.unconfirmedWork.some(work => work.serverIds.includes(server.id)) && <div className={css.deleteWarning}><div><strong>{t('removedWorkUnconfirmed')}</strong><p>{t('removedWorkHint')}</p>
          <Button variant="ghost" size="sm" disabled={probing} onClick={() => { void controller.reconcileRemovedWork(server.id).catch(reason => { controller.report(reason, { serverId: server.id, operation: 'release-check' }) }) }}>{t('recheckRemoteWork')}</Button></div></div>}
        {current !== undefined ? <><div className={css.actions}><Tag tone="success">{t('sshPassed')}</Tag><Tag tone={check?.gpu === 'passed' ? 'success' : 'warning'}>{t(check?.gpu === 'passed' ? 'gpuPassed' : 'gpuUnavailable')}</Tag>
          <Tag tone={check?.control === 'passed' ? 'success' : 'neutral'}>{t(check?.control === 'passed' ? 'controlPassed' : 'controlUnavailable')}</Tag></div><Hardware probe={current} t={t} /></>
          : old !== undefined && <details className={css.historicalCheck}><summary>{previous === undefined ? t('currentConnectionUnconfirmed') : t('lastSuccessfulCheck', { time: new Date(previous.checkedAt).toLocaleString() })}</summary><Hardware probe={old} t={t} /></details>}
        {server.inferenceMapping !== undefined && <details className={css.inventory}><summary>{t('publicInferenceSettings')}</summary><p className={css.cleanupPath}>{server.inferenceMapping.url}</p><p>{t('mappedPort')}: {server.inferenceMapping.port}</p></details>}
        <div className={css.serverActions}><Button variant="outline" disabled={probing} onClick={() => { edit(server) }}>{t('edit')}</Button>
          <Button variant="outline" disabled={probing} aria-busy={probing} icon={probing ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular />}
            onClick={() => { void controller.probe(server.id).catch(reason => { controller.report(reason, { serverId: server.id, operation: 'probe' }) }) }}>{t(probing ? 'checkingConnection' : 'test')}</Button>
          <Button variant="ghost" className={css.dangerText} disabled={state.removingServers.includes(server.id)} icon={<IconTrashOutlineRegular />}
            onClick={() => { setRemoval(server); setRemovalError(undefined) }}>{t('deleteServer')}</Button></div>
      </article>
    })}
    <Modal open={removal !== undefined} onClose={() => { if (removal === undefined || !state.removingServers.includes(removal.id)) setRemoval(undefined) }} title={t('deleteServer')} closeLabel={t('close')} backdropBlur={false} className={css.deleteModal} contentClassName={css.deleteModalScroll}>
      {removal !== undefined && <><div className={css.deleteContent}><div className={css.deleteObject}><strong>{removal.name}</strong><small className={css.hint}>{removal.username}@{removal.host}:{removal.sshPort}</small></div><p>{t('deleteServerHint')}</p>
        {removalPreview === undefined ? removalError === undefined ? <div className={css.deleteLoading}><StateDot state="ongoing" /></div> : <Button variant="outline" size="sm" onClick={() => { setPreviewAttempt(value => value + 1) }}>{t('refresh')}</Button> : removalPreview.linkedExperiments.length > 0 && <div><p className={css.hint}>{t('retainedLinkedExperiments', { count: removalPreview.linkedExperiments.length })}</p>
          {removalPreview.linkedExperiments.map(item => {
            const row = state.experiments.find(value => value.request.experimentId === item.experimentId)
            return <Button key={item.experimentId} variant="ghost" className={css.linkedDeleteRecord} onClick={() => { setRemoval(undefined); controller.navigate('list'); controller.select(item.experimentId) }}>
              <span>{item.name}</span>{row !== undefined && <ExperimentStatus row={row} t={t} />}</Button>
          })}</div>}
        <div className={css.deleteInfo}><p>{t('serverDeleteKeepsTasks')}</p></div>
        {removalError !== undefined && <p className={css.deleteFailure}>{removalError}</p>}
        </div><div className={css.deleteActions}><Button variant="ghost" disabled={state.removingServers.includes(removal.id)} onClick={() => { setRemoval(undefined) }}>{t('keepRecords')}</Button><Button variant="primary" className={css.destructiveButton}
          disabled={removalPreview === undefined || state.removingServers.includes(removal.id)} icon={state.removingServers.includes(removal.id) ? <StateDot state="ongoing" /> : <IconTrashOutlineRegular />} onClick={() => { void remove() }}>{t('confirmDeleteServer')}</Button></div></>}
    </Modal>
  </>
}
