/** Shared inference connection, diagnostics and historical services for both navigation entries. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Input, Menu, Modal, StateDot, Tag, Tooltip, IconCopyOutlineRegular,
  IconChevronDownOutlineRegular, IconRefreshOutlineRegular, IconWarningOutlineRegular,
  IconCheckOutlineRegular, IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExperimentsController } from './controller.ts'
import { Choice } from './ModelFields.tsx'
import { collectServices, serviceExample, serviceKeyBlocker, serviceRequestIdentity, serviceStatus } from './inference-services.ts'
import type { ServiceExampleKind, ServiceExampleLanguage, ServiceView } from './inference-services.ts'
import type { ExperimentLocaleKey } from './locales.ts'
import css from './InferenceServices.module.css'

type Props = { controller: ExperimentsController; t: TranslateNS<'experiments'> }
type DetailProps = Props & { item: ServiceView; offline: boolean; readError?: string }

/**
 * Show one canonical service detail without exposing recovery-task implementation identities.
 * @param props - saved rows, optional detail owner and independently observed archive availability.
 * @returns active service selection, connection details and compact released history.
 */
export function InferenceServices({ controller, t, rows, experimentId, offline = false }: Props & {
  rows: FleetExperiment[]; experimentId?: string; offline?: boolean
}) {
  const forms = useSyncExternalStore(controller.services.store.subscribe, controller.services.store.getSnapshot)
  const snapshot = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot)
  const items = collectServices(rows, experimentId, snapshot.deletedIds)
  const scope = experimentId ?? 'services'
  const chosen = items.find(item => item.key === forms.selections[scope]) ?? items[0]
  const active = items.filter(item => !item.service.released)
  const history = items.filter(item => item.service.released)
  const [historyOpen, setHistoryOpen] = useState(false)
  if (chosen === undefined) return <div className={css.empty}><IconLinkOutlineRegular size={24} /><h3>{t('serviceEmpty')}</h3><p>{t('serviceEmptyHint')}</p></div>
  const readError = snapshot.serviceReadError ?? snapshot.sourceErrors[JSON.stringify({ experimentId: chosen.service.experimentId, operation: 'status' })]
  const uncertain = readError !== undefined || offline && chosen.service.experimentId === experimentId
  return <section className={css.root} aria-label={t('services')}>
    {active.length > 1 && <div className={css.selector} role="group" aria-label={t('serviceChoose')}>
      {active.map(item => {
        const status = serviceStatus(item.service, snapshot.serviceReadError !== null || snapshot.sourceErrors[JSON.stringify({ experimentId: item.service.experimentId, operation: 'status' })] !== undefined)
        return <button key={item.key} className={css.option} aria-pressed={item.key === chosen.key} onClick={() => { controller.services.select(scope, item.key) }}>
          <strong>{item.service.modelName ?? item.experimentName}</strong><span><StateDot state={status.dot} />{item.nodeName} · {t(status.label)}</span>
        </button>
      })}
    </div>}
    <ServiceDetail key={serviceRequestIdentity(chosen.service)} controller={controller} t={t} item={chosen} offline={uncertain} readError={readError} />
    {history.length > 0 && <details className={`${css.fold} ${css.history}`} open={historyOpen} onToggle={event => { setHistoryOpen(event.currentTarget.open) }}>
      <summary><IconChevronDownOutlineRegular /><strong>{t('serviceHistory')}</strong><Tag>{history.length}</Tag><span>{t('serviceHistoryReleased')}</span></summary>
      <div className={css.historyRows}>{history.map(item => <div key={item.key} className={css.historyRow}>
        <div><strong>{item.service.modelName ?? item.experimentName}</strong><small>{item.nodeName} · {item.experimentName}</small></div>
        <Tag>{t(serviceStatus(item.service).label)}</Tag><time>{new Date(item.service.updatedAt).toLocaleString()}</time>
        <Button size="sm" onClick={() => { controller.services.select(scope, item.key) }}>{t('serviceViewHistory')}</Button>
      </div>)}</div>
    </details>}
  </section>
}

function ServiceDetail({ controller, t, item, offline, readError }: DetailProps) {
  const { service } = item
  useSyncExternalStore(controller.services.store.subscribe, controller.services.store.getSnapshot)
  const form = controller.services.read(item)
  const [menu, setMenu] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const diagnostics = useRef<HTMLDetailsElement>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const uncertain = offline || form.exitUnconfirmed
  const status = serviceStatus(service, uncertain, form.stopping)
  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true)
    try { await controller.refresh() } finally { if (mounted.current) setRefreshing(false) }
  }
  const blocked = controller.store.getSnapshot().experiments.filter(row => row.request.experimentId !== item.displayExperimentId
    && row.request.experimentId !== service.experimentId && row.waitingFor.includes(service.serverId))
  const hint: ExperimentLocaleKey | undefined = service.released ? 'serviceHistoryHint' : uncertain ? 'serviceOfflineHint'
    : form.stopping || service.state === 'stopping' ? 'serviceStoppingHint'
    : service.state !== 'healthy' && service.state !== 'starting' ? 'serviceUnreleasedHint'
    : service.external?.state === 'unreachable' ? 'servicePublicIssueHint' : undefined
  return <>
    <header className={css.summary}>
      <div className={css.title}><span className={css.serviceIcon}><IconLinkOutlineRegular size={20} /></span><div>
        <div className={css.titleLine}><h3>{service.modelName ?? item.experimentName}</h3><Tag tone={status.tone}><span className={css.statusTag}><StateDot state={status.dot} />{t(status.label)}</span></Tag></div>
        <p>{item.nodeName} · {item.experimentName} · {t('serviceStateUpdated')} {new Date(service.updatedAt).toLocaleString()}</p>
      </div></div>
      <div className={css.actions}><Button size="sm" disabled={refreshing} icon={refreshing ? <StateDot state="ongoing" /> : <IconRefreshOutlineRegular />} onClick={() => { void refresh() }}>{t('serviceRefresh')}</Button>
        <Menu open={menu} portal onClose={() => { setMenu(false) }} items={[
          { id: 'details', label: t('serviceDiagnostics') },
          { id: 'stop', label: t('stopService'), danger: true, disabled: service.released || offline || form.stopping || service.state === 'stopping' },
        ]} onSelect={action => { setMenu(false); if (action === 'stop') setConfirm(true); else { controller.services.update(item, { diagnosticOpen: true }); requestAnimationFrame(() => { diagnostics.current?.scrollIntoView({ block: 'nearest' }); diagnostics.current?.querySelector('summary')?.focus() }) } }}
          anchor={<Button variant="outline" size="sm" aria-haspopup="menu" aria-expanded={menu} onClick={() => { setMenu(!menu) }}>{t('serviceManage')}<IconChevronDownOutlineRegular /></Button>} />
      </div>
    </header>
    {hint !== undefined && <div className={css.notice} data-warning={!service.released}><IconWarningOutlineRegular /><p>{t(hint)}{blocked.length > 0 && <small>{t('serviceBlocks', { goals: blocked.map(row => row.request.name ?? row.request.objective.split('\n')[0]).join(' · ') })}</small>}</p></div>}
    {hint === undefined && blocked.length > 0 && <p className={css.notice}>{t('serviceBlocks', { goals: blocked.map(row => row.request.name ?? row.request.objective.split('\n')[0]).join(' · ') })}</p>}
    <div className={css.connectionGrid}>
      <ConnectionInfo controller={controller} t={t} item={item} offline={uncertain} stopping={form.stopping} />
      <ConnectionStatus t={t} item={item} offline={uncertain} stopping={form.stopping} />
    </div>
    {!service.released && <>
      <Examples controller={controller} t={t} item={item} offline={uncertain} stopping={form.stopping} />
      <details className={css.fold} open={form.requestOpen} onToggle={event => { if (form.requestOpen !== event.currentTarget.open) controller.services.update(item, { requestOpen: event.currentTarget.open }) }}>
        <summary><IconChevronDownOutlineRegular /><strong>{t('serviceRequestDebug')}</strong><span>{t('serviceManagedRoute')}</span></summary>
        <div className={css.foldBody}><p className={css.note}>{t('serviceManagedHint')}</p>
          <div className={css.requestGrid}><div className={css.formField}><span>{t('httpMethod')}</span><Choice label={t('httpMethod')} value={form.method}
            options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]} onChange={method => { controller.services.update(item, { method }) }} /></div>
            <label className={css.formField}>{t('servicePath')}<Input value={form.path} onChange={event => { controller.services.update(item, { path: event.target.value }) }} /></label></div>
          {form.method === 'POST' && <label className={css.formField}>{t('serviceBody')}<textarea value={form.body} rows={5} onChange={event => { controller.services.update(item, { body: event.target.value }) }} /></label>}
          <div className={css.requestActions}><Button variant="primary" disabled={uncertain || form.requesting || form.stopping || service.state !== 'healthy'} icon={form.requesting ? <StateDot state="ongoing" /> : undefined} onClick={() => {
            try {
              if (!form.path.startsWith('/') || form.path.startsWith('//') || form.path.includes('\\')) throw new Error(t('serviceInvalidPath'))
              if (form.method === 'POST') { try { JSON.parse(form.body) } catch (error) { void error; throw new Error(t('serviceInvalidJson')) } }
              void controller.services.request(item)
            } catch (error) { controller.services.update(item, { error: String(error) }); controller.report(error, { experimentId: service.experimentId, operation: 'service-request' }) }
          }}>{t(form.requesting ? 'serviceRequesting' : 'serviceSend')}</Button><span className={css.note}>{t('serviceRequestTarget')}</span></div>
          {form.error !== undefined && <p className={css.operationError} role="alert">{t('serviceOperationFailed')}</p>}
          {form.result !== undefined && <section className={css.response} aria-label={t('serviceResponse')}><h4>{t('serviceResponse')}</h4><pre>{form.result}</pre></section>}
        </div>
      </details>
    </>}
    <details ref={diagnostics} className={css.fold} open={form.diagnosticOpen} onToggle={event => { if (form.diagnosticOpen !== event.currentTarget.open) controller.services.update(item, { diagnosticOpen: event.currentTarget.open }) }}>
      <summary><IconChevronDownOutlineRegular /><strong>{t('serviceDiagnostics')}</strong><span>{t('serviceDiagnosticsHint')}</span></summary>
      <div className={css.foldBody}><dl className={css.diagnostics}>
        {([{ label: 'serviceIdentity', value: service.id }, { label: 'serviceOwner', value: service.experimentId },
          { label: 'modelArtifact', value: service.modelPath }, { label: 'serviceInternalAddress', value: `127.0.0.1:${service.port}` },
          ...(service.external === undefined ? [] : [{ label: 'mappedPort' as const, value: String(service.external.port) }]),
          { label: 'serviceLaunchCommand', value: service.command }] satisfies { label: ExperimentLocaleKey; value: string }[]).map(field => <div key={field.label}><dt>{t(field.label)}</dt><dd><code>{field.value}</code></dd><CopyButton controller={controller} t={t} value={field.value} label={t(field.label)} /></div>)}
      </dl>{[service.detail, service.external?.detail, readError, form.error].filter((value): value is string => value !== undefined).map((value, index) => <div className={css.raw} key={index}><h4>{t('serviceOriginalDetail')}</h4><pre>{value}</pre></div>)}</div>
    </details>
    <Modal open={confirm} onClose={() => { setConfirm(false) }} title={t('serviceStopTitle')} closeLabel={t('close')} backdropBlur={false}
      footer={<div className={css.modalActions}><Button variant="outline" data-modal-autofocus onClick={() => { setConfirm(false) }}>{t('serviceKeepRunning')}</Button><Button variant="primary" className={css.dangerButton} onClick={() => { setConfirm(false); void controller.services.stop(item) }}>{t('stopService')}</Button></div>}>
      <p>{t('serviceStopImpact')}</p><p className={css.stopIdentity}>{service.modelName ?? item.experimentName} · {item.nodeName}</p>
    </Modal>
  </>
}

function CopyButton({ controller, t, value, label }: Props & { value: string; label: string }) {
  const [busy, setBusy] = useState(false)
  return <Tooltip label={t('serviceCopyField', { field: label })} portal><Button size="sm" disabled={busy} aria-label={t('serviceCopyField', { field: label })}
    icon={busy ? <StateDot state="ongoing" /> : <IconCopyOutlineRegular />} onClick={() => {
      setBusy(true)
      void navigator.clipboard.writeText(value).then(() => { controller.notify('serviceCopied') }).catch(error => { controller.report(error) }).finally(() => { setBusy(false) })
    }}><span className={css.copyLabel}>{t('serviceCopy')}</span></Button></Tooltip>
}

function ConnectionInfo({ controller, t, item, offline, stopping }: DetailProps & { stopping: boolean }) {
  const { service } = item
  const [key, setKey] = useState<string>()
  const [busy, setBusy] = useState<'show' | 'copy'>()
  const lifetime = useRef(0)
  const blocker = serviceKeyBlocker(service, stopping)
  const disabled = blocker !== undefined
  useEffect(() => {
    const clear = () => { lifetime.current++; setKey(undefined); setBusy(undefined) }
    const hidden = () => { if (document.hidden) clear() }
    document.addEventListener('visibilitychange', hidden)
    if (disabled || offline) clear()
    return () => { lifetime.current++; document.removeEventListener('visibilitychange', hidden) }
  }, [disabled, offline])
  const load = async (action: 'show' | 'copy') => {
    if (disabled || busy !== undefined) return
    if (action === 'show' && key !== undefined) { lifetime.current++; setKey(undefined); return }
    const generation = ++lifetime.current
    setBusy(action)
    try {
      const access = await controller.serviceAccessInfo(service.experimentId, service.id)
      if (generation !== lifetime.current || document.hidden) return
      if (access.url !== service.external?.url || access.modelName !== service.modelName) throw new Error(t('serviceCallingInfoChanged'))
      if (action === 'show') setKey(access.token)
      else { await navigator.clipboard.writeText(access.token); if (generation === lifetime.current) controller.notify('serviceCopied') }
    } catch (error) { if (generation === lifetime.current) controller.report(error, { experimentId: service.experimentId, operation: 'service-key' }) }
    finally { if (generation === lifetime.current) setBusy(undefined) }
  }
  return <section className={`${css.panel} ${css.connection}`} aria-label={t('serviceConnectionInfo')}>
    <div className={css.panelHeading}><h4>{t('serviceConnectionInfo')}</h4><span>{t(service.released ? 'serviceHistoricalConnection' : 'serviceClientSetup')}</span></div>
    <ConnectionField controller={controller} t={t} label={t('serviceAddress')} value={service.external?.url} missing={t('serviceNoExternal')} />
    <ConnectionField controller={controller} t={t} label={t('servedModel')} value={service.modelName} missing={t('serviceNoModel')} />
    <div className={css.field}><span>{t('serviceApiKey')}</span><div className={css.valueRow}><code className={key === undefined ? css.mask : undefined}>{key ?? '••••••••••••••••••••••••'}</code>
      <div className={css.actions}><Button size="sm" disabled={disabled || busy !== undefined} icon={busy === 'show' ? <StateDot state="ongoing" /> : undefined} onClick={() => { void load('show') }}>{t(key === undefined ? 'serviceShowKey' : 'serviceHideKey')}</Button>
        <Tooltip label={t('serviceCopyField', { field: t('serviceApiKey') })} portal><Button size="sm" disabled={disabled || busy !== undefined} aria-label={t('serviceCopyField', { field: t('serviceApiKey') })} icon={busy === 'copy' ? <StateDot state="ongoing" /> : <IconCopyOutlineRegular />} onClick={() => { void load('copy') }}><span className={css.copyLabel}>{t('serviceCopy')}</span></Button></Tooltip></div>
    </div></div><p className={css.note}>{t(blocker ?? (offline ? 'serviceKeyRetryHint' : 'serviceKeyOnDemand'))}</p>
  </section>
}

function ConnectionField({ controller, t, label, value, missing }: Props & { label: string; value?: string; missing: string }) {
  return <div className={css.field}><span>{label}</span><div className={css.valueRow}><code>{value ?? missing}</code>{value !== undefined && <CopyButton controller={controller} t={t} value={value} label={label} />}</div></div>
}

function ConnectionStatus({ t, item, offline, stopping }: Pick<DetailProps, 't' | 'item' | 'offline'> & { stopping: boolean }) {
  const { service } = item
  const process = serviceStatus(service, offline, stopping)
  const external = service.external
  const publicTone = offline ? 'warning' : external?.state === 'reachable' ? 'success' : external?.state === 'unreachable' ? 'error' : 'neutral'
  const publicLabel: ExperimentLocaleKey = offline ? 'serviceStatusUnconfirmed' : external === undefined ? 'serviceNoExternal' : `external-${external.state}`
  const processLabel: ExperimentLocaleKey = offline ? 'serviceStatusUnconfirmed' : service.released ? 'serviceProcessExited'
    : stopping || service.state === 'stopping' ? 'serviceExitPending' : service.state === 'healthy' ? 'serviceProcessHealthy' : service.state
  const processTone = service.state === 'healthy' && !offline && !stopping && !service.released ? 'success' : process.tone === 'danger' ? 'error' : process.tone
  const rows = [
    { title: 'serviceProcess' as const, label: processLabel, tone: processTone, time: service.updatedAt, hint: 'serviceStateUpdated' as const },
    { title: 'servicePublicAccess' as const, label: publicLabel, tone: publicTone, time: external?.checkedAt, hint: 'serviceCheckRecorded' as const },
  ]
  return <aside className={`${css.panel} ${css.connectionStatus}`} aria-label={t('serviceConnectionStatus')}><div className={css.panelHeading}><h4>{t('serviceConnectionStatus')}</h4><span>{t('serviceRetainedObservations')}</span></div>
    {rows.map(row => <div className={css.checkRow} data-tone={row.tone} key={row.title}><span className={css.checkIcon}>{row.tone === 'success' ? <IconCheckOutlineRegular /> : row.tone === 'error' || row.tone === 'warning' ? <IconWarningOutlineRegular /> : <StateDot state={row.title === 'serviceProcess' && !offline && !service.released && (service.state === 'starting' || stopping) ? 'ongoing' : 'idle'} />}</span><div>
      <div className={css.checkHeading}><strong>{t(row.title)}</strong><span>{t(row.label)}</span></div><p>{t(row.hint)}</p><time>{row.time === undefined ? t('serviceNoCheck') : new Date(row.time).toLocaleString()}</time>
    </div></div>)}<p className={css.statusNote}>{t('serviceHealthNotGeneration')}</p></aside>
}

function Examples({ controller, t, item, offline, stopping }: DetailProps & { stopping: boolean }) {
  const [kind, setKind] = useState<ServiceExampleKind>('inference')
  const [language, setLanguage] = useState<ServiceExampleLanguage>('powershell')
  const [copying, setCopying] = useState(false)
  const lifetime = useRef(0)
  const blocker = serviceKeyBlocker(item.service, stopping)
  useEffect(() => {
    const invalidate = () => { lifetime.current++; setCopying(false) }
    const hidden = () => { if (document.hidden) invalidate() }
    invalidate()
    document.addEventListener('visibilitychange', hidden)
    return () => { lifetime.current++; document.removeEventListener('visibilitychange', hidden) }
  }, [kind, language, blocker, offline])
  const code = serviceExample(item.service, kind, language, t('serviceExampleMessage'), t(language === 'curl' ? 'serviceExampleSetupCurl' : 'serviceExampleSetupPowerShell'))
  const copyWithKey = async () => {
    if (copying || blocker !== undefined || code === undefined) return
    const generation = ++lifetime.current
    setCopying(true)
    try {
      const access = await controller.serviceAccessInfo(item.service.experimentId, item.service.id)
      if (generation !== lifetime.current || document.hidden) return
      if (access.url !== item.service.external?.url || access.modelName !== item.service.modelName) throw new Error(t('serviceCallingInfoChanged'))
      const command = serviceExample(item.service, kind, language, t('serviceExampleMessage'), t('serviceExampleReady'), access.token)!
      await navigator.clipboard.writeText(command)
      if (generation === lifetime.current) controller.notify('serviceCopied')
    } catch (error) { if (generation === lifetime.current) controller.report(error, { experimentId: item.service.experimentId, operation: 'service-example-key' }) }
    finally { if (generation === lifetime.current) setCopying(false) }
  }
  return <section className={`${css.panel} ${css.examples}`} aria-label={t('serviceExamples')}>
    <div className={css.exampleHeader}><h4>{t('serviceExamples')}</h4><div className={css.languages} role="group" aria-label={t('serviceExampleLanguage')}>
      {(['powershell', 'curl'] as const).map(value => <Button key={value} size="sm" aria-pressed={language === value} onClick={() => { setLanguage(value) }}>{value === 'curl' ? 'cURL' : 'PowerShell'}</Button>)}</div></div>
    <div className={css.exampleKinds} role="group" aria-label={t('serviceExamplePurpose')}>{(['inference', 'health'] as const).map(value => <button key={value} aria-pressed={kind === value} onClick={() => { setKind(value) }}>{t(value === 'inference' ? 'serviceDirectCall' : 'serviceHealthCheck')}</button>)}</div>
    <p className={css.exampleDescription}><code>{kind === 'inference' ? 'POST' : 'GET'}</code><code>{kind === 'inference' ? '/v1/chat/completions' : '/_aspera/health'}</code><span>{t(kind === 'inference' ? 'serviceOpenAiExample' : 'serviceHealthExampleHint')}</span></p>
    {code === undefined ? <p className={css.exampleMissing}>{t(item.service.external === undefined ? 'serviceNoExternalExample' : 'serviceNoModelExample')}</p>
      : <div className={css.code}><pre>{code}</pre><div><CopyButton controller={controller} t={t} value={code} label={t('serviceExamples')} /></div></div>}
    {code !== undefined && <div className={css.exampleActions}><Button size="sm" variant="outline" disabled={copying || blocker !== undefined}
      icon={copying ? <StateDot state="ongoing" /> : <IconCopyOutlineRegular />} onClick={() => { void copyWithKey() }}>{t('serviceCopyWithKey')}</Button></div>}
    <p className={css.exampleNote}>{t(kind === 'inference' ? 'serviceGenerationOutput' : 'serviceHealthNotGeneration')} {t('serviceExampleKeyPlaceholder')}</p>
  </section>
}
