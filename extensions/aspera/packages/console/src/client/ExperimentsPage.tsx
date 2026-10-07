/** Experiment forms and read-only execution details receive all effects through props. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Button, Checkbox, IconGoalOutlineRegular, IconPaperclipOutlineRegular,
  IconPlusOutlineRegular, IconRefreshOutlineRegular, IconChevronLeftOutlineRegular, Input, Tag, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FleetExperiment, ServerSettings, FleetServerInput } from '@aspera/dispatch/types'
import { ExperimentList, ExperimentStatus, DeleteExperimentsDialog } from './ExperimentManagement.tsx'
import { ServerCards, ServerPassword } from './ServerManagement.tsx'
import type { InferenceService, ServiceAccessInfo } from '@aspera/experiments/types'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentsController } from './controller.ts'
import css from './ExperimentsPage.module.css'
import { AgentRecords } from './AgentRecords.tsx'
import { RuntimeMonitor } from './RuntimeMonitor.tsx'
import { ModelFields, modelsReady, Choice as Selection } from './ModelFields.tsx'
import type { ExperimentModels } from '@aspera/experiments/types'
import { experimentAttentionCount, attentionLabel, experimentTodos } from './attention.ts'
import { ExperimentQuestionCard } from './QuestionCard.tsx'
import { ExperimentOverview } from './ExperimentOverview.tsx'
import { ExecutionPlan } from './ExecutionPlan.tsx'
import type { PropsRenderFactories } from '@deepseek-ai/dsh-client-ui-slots'

/** Actions and observable state owned by the plugin controller. */
export interface ExperimentsInjected {
  controller: ExperimentsController
  hooks: { experiments: ExperimentsController['store'] }
}

/** Composed page props supplied by the DSH slot renderer. */
export type ExperimentsPageProps = InjectFace<ExperimentsInjected> & PropsLocale<'experiments'> & PropsRenderFactories
type PageProps = ExperimentsPageProps
type ViewProps = { controller: ExperimentsController; t: TranslateNS<'experiments'> }

/**
 * @param props - sidebar icon geometry.
 * @returns experiment navigation glyph.
 */
export function ExperimentsIcon({ size, useExperiments, t }: PropsRuntime<'sidebar.panellist'> & PageProps) {
  const count = useExperiments(value => experimentAttentionCount(value.experiments))
  return <span className={css.navIcon}><IconGoalOutlineRegular size={size} />{count > 0 && <span className={css.badge} aria-label={t('pendingCount', { count })}>{attentionLabel(count)}</span>}</span>
}

/**
 * Render independent experiment forms and execution details.
 * @param props - controller actions, live state, and dictionary.
 * @returns independent experiment panel.
 */
export function ExperimentsPage({ controller, useExperiments, t, renderFactorySlot }: PageProps) {
  const state = useExperiments(value => value)
  const view = state.view
  const setView = (value: Snapshot['view']) => { controller.navigate(value) }
  const todos = experimentTodos(state.experiments).filter(todo => !state.preferences.dismissed.includes(todo.key))
  const [draft, setDraft] = useState<FleetExperiment | undefined>()
  const [filter, setFilter] = useState<'all' | 'pending' | 'running' | 'queued' | 'completed' | 'failed'>('all')
  const pendingCount = experimentAttentionCount(state.experiments)
  useEffect(() => { controller.setVisible(true); return () => { controller.setVisible(false) } }, [controller])
  const detail = state.experiments.find(row => row.request.experimentId === state.selectedId)
  const act = (operation: () => Promise<unknown>) => { void operation().catch((error: unknown) => { controller.report(error) }) }
  return <section className={css.page}>
    {detail === undefined && <header className={css.header}>
      <div className={css.heading}><h1>{t(view === 'list' ? 'experiments' : view === 'new' ? 'newExperiment' : view)}</h1><p>{t('introduction')}</p></div>
      <div className={css.actions}>
        <Button variant="ghost" onClick={() => { controller.select(null); setView('list'); setFilter('pending') }}>{t('pending')}{pendingCount > 0 && <span className={css.count}>{attentionLabel(pendingCount)}</span>}</Button>
        <Button variant="primary" icon={<IconPlusOutlineRegular />} onClick={() => { controller.select(null); setDraft(undefined); setView('new') }}>{t('newExperiment')}</Button>
        <Button variant="ghost" icon={<IconRefreshOutlineRegular />} onClick={() => { act(() => controller.refresh()) }}>{t('refresh')}</Button>
      </div>
    </header>}
    <div className={css.content}>
    {view === 'list' && detail === undefined && todos.length > 0 && <aside className={css.todoBanner} role="status"><div><span>{t('todoHint', { count: new Set(todos.map(todo => todo.experimentId)).size })}</span><small>{t('todoResourceHint')}</small></div><Button variant="outline" size="sm" onClick={() => { const todo = todos[0]; if (todo !== undefined) controller.select(todo.experimentId) }}>{t('viewTodo')}</Button><button className={css.todoClose} aria-label={t('dismissTodo')} onClick={() => { controller.dismissTodos() }}>×</button></aside>}
    {view !== 'list' && <div className={css.actions}><Button variant="ghost" size="sm" onClick={() => { controller.select(null); setView('list') }}>{t('back')}</Button></div>}
    {view === 'services' ? <section className={css.list}><p className={css.hint}>{t('serviceHint')}</p>{state.experiments.every(row => !row.latest?.services.length) && <p className={css.empty}>{t('serviceEmpty')}</p>}{state.experiments.map(row => <Services key={row.request.experimentId} controller={controller} t={t} row={row} />)}</section> : view === 'servers' ? <Servers controller={controller} t={t} state={state} />
      : view === 'new' ? <NewExperiment key={draft?.request.experimentId ?? 'new'} controller={controller} t={t}
        servers={state.registry.servers} state={state} draft={draft} />
        : detail !== undefined ? <ExperimentDetail key={detail.request.experimentId} renderFactorySlot={renderFactorySlot} controller={controller} t={t} row={detail} state={state} onClone={() => {
          controller.select(null); setDraft(detail); setView('new')
        }} /> : <ExperimentList controller={controller} t={t} rows={state.experiments} pendingOnly={filter === 'pending'} onPendingChange={pending => { setFilter(pending ? 'pending' : 'all') }} onClone={row => { setDraft(row); setView('new') }} />}

    </div>
  </section>
}

type Snapshot = ReturnType<ExperimentsController['store']['getSnapshot']>

function Servers({ controller, t, state }: ViewProps & { state: Snapshot }) {
  const [editing, setEditing] = useState<ServerSettings | 'new' | undefined>()
  return <section className={css.list}>
    <div className={css.sectionHeading}><p className={css.hint}>{t('coordinatorHint')}</p>
      <Button variant="outline" icon={<IconPlusOutlineRegular />} onClick={() => { setEditing('new') }}>{t('addServer')}</Button></div>
    <Modal open={editing !== undefined} onClose={() => { setEditing(undefined) }} title={editing === 'new' ? t('addServer') : t('editServer')} closeLabel={t('discard')} backdropBlur={false} className={css.serverModal} contentClassName={css.serverModalContent}>
      {editing !== undefined && <ServerForm key={editing === 'new' ? 'new' : editing.id} controller={controller} t={t}
        server={editing === 'new' ? undefined : editing} done={() => { setEditing(undefined) }} />}
    </Modal>
    <ServerCards controller={controller} t={t} state={state} edit={setEditing} />
  </section>
}

function ServerForm({ controller, t, server, done }: ViewProps & { server: ServerSettings | undefined; done: () => void }) {
  const [busy, setBusy] = useState(false)
  const [storageMode, setStorageMode] = useState<'auto' | 'manual'>(server?.storagePreference?.mode ?? (server?.remoteRoot === undefined ? 'auto' : 'manual'))
  const [externalUrl, setExternalUrl] = useState(server?.inferenceMapping?.url ?? '')
  const pending = useRef(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending.current) return
    const data = new FormData(event.currentTarget)
    const field = (name: string) => { const value = data.get(name); return typeof value === 'string' ? value : '' }
    const value: FleetServerInput = { id: server?.id ?? controller.newId(), name: field('name'), host: field('host'),
      username: field('username'), sshPort: Number(field('sshPort')), remotePort: Number(field('remotePort')),
      authMode: 'password', storagePreference: storageMode === 'manual' ? { mode: 'manual', directory: field('remoteRoot').trim() } : { mode: 'auto' },
      ...(server?.remoteRoot === undefined ? {} : { remoteRoot: server.remoteRoot }),
      ...(server?.passwordRef === undefined ? {} : { passwordRef: server.passwordRef }),
      ...(server?.knownHostsFile === undefined ? {} : { knownHostsFile: server.knownHostsFile }),
      ...(externalUrl.trim() === '' ? {} : { inferenceMapping: { url: externalUrl.trim(), port: Number(field('inferencePort')) } }),
      ...(field('trainingAddress') === '' ? {} : { trainingAddress: field('trainingAddress') }) }
    pending.current = true; setBusy(true)
    try { await controller.saveServer(value, field('password')); done() }
    catch (error) { controller.report(error) }
    finally { pending.current = false; setBusy(false) }
  }
  return <form className={css.form} onSubmit={(event) => { void submit(event) }}>
    <div className={css.fields}>
    <label>{t('name')}<Input name="name" data-modal-autofocus defaultValue={server?.name} required /></label>
    <label>{t('host')}<Input name="host" defaultValue={server?.host} required /></label>
    <label>{t('username')}<Input name="username" autoComplete="username" defaultValue={server?.username} required /></label>
    <ServerPassword controller={controller} t={t} server={server} />
    <label>{t('sshPort')}<Input name="sshPort" type="number" min={1} max={65535} defaultValue={server?.sshPort ?? 22} required /></label>
    </div>
    <details className={css.advanced} open={server?.inferenceMapping !== undefined || undefined}><summary>{t('publicInferenceSettings')}</summary>
      <div className={css.fields}>
        <label>{t('externalInferenceUrl')}<Input name="inferenceUrl" type="url" placeholder="https://…" value={externalUrl} onChange={event => { setExternalUrl(event.target.value) }} /></label>
        <label>{t('mappedPort')}<Input name="inferencePort" type="number" min={1} max={65535} defaultValue={server?.inferenceMapping?.port} required={externalUrl.trim() !== ''} disabled={externalUrl.trim() === ''} /></label>
      </div><p className={css.hint}>{t('publicInferenceHint')}</p>
    </details>
    <details className={css.advanced}><summary>{t('advancedSettings')}</summary><div className={css.fields}>
    <div className={css.field}><span>{t('storageLocation')}</span><Selection label={t('storageLocation')} value={storageMode}
      options={[{ value: 'auto', label: t('automaticStorage') }, { value: 'manual', label: t('manualStorage') }]} onChange={setStorageMode} /></div>
    {storageMode === 'manual' && <label>{t('remoteRoot')}<Input name="remoteRoot" defaultValue={server?.storagePreference?.mode === 'manual' ? server.storagePreference.directory : server?.remoteRoot} required /></label>}
    <label>{t('remotePort')}<Input name="remotePort" type="number" min={1} max={65534} defaultValue={server?.remotePort ?? controller.initialControlPort()} required /></label>
    <label>{t('trainingAddress')}<Input name="trainingAddress" placeholder={t('networkPlaceholder')} defaultValue={server?.trainingAddress} /></label>
    </div><p className={css.hint}>{t('controlPortHint')}</p><p className={css.hint}>{t('networkHint')}</p></details>
    <div className={css.hints}><p>{t('passwordHint')}</p><p>{t('storageHint')}</p></div>
    <div className={css.actions}>
      <Button type="submit" variant="primary" disabled={busy}>{busy ? t('busy') : t('save')}</Button>
      <Button variant="ghost" disabled={busy} onClick={done}>{t('discard')}</Button>
    </div>
  </form>
}

function NewExperiment({ controller, t, servers, state, draft }: ViewProps & {
  servers: ServerSettings[]
  state: Snapshot
  draft: FleetExperiment | undefined
}) {
  const [objective, setObjective] = useState(draft?.request.objective ?? '')
  const [name, setName] = useState(draft?.request.name ?? '')
  const [models, setModels] = useState<ExperimentModels | undefined>(draft?.request.models ?? state.preferences.models)
  useEffect(() => { void controller.loadModels() }, [controller])
  useEffect(() => { const current = state.modelDirectory?.current; if (models === undefined && current !== undefined) setModels({ preparation: current, planning: current, execution: current }) }, [state.modelDirectory, models])
  const [ids, setIds] = useState<string[]>(draft?.servers.map(server => server.id)
    .filter(id => servers.some(server => server.id === id)) ?? [])
  const [chosenCoordinator, setChosenCoordinator] = useState(draft?.coordinator.id ?? '')
  const coordinatorId = ids.includes(chosenCoordinator) ? chosenCoordinator : ids[0] ?? ''
  useEffect(() => { if (!ids.includes(chosenCoordinator)) setChosenCoordinator(ids[0] ?? '') }, [ids, chosenCoordinator])
  const [mode, setMode] = useState<'semi' | 'automatic'>(draft?.request.mode ?? 'automatic')
  const [busy, setBusy] = useState(false)
  const uploadsInput = useRef<HTMLInputElement>(null)
  const [uploadNames, setUploadNames] = useState<string[]>([])
  const id = useRef(controller.newId())
  const pending = useRef(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending.current) return
    pending.current = true; setBusy(true)
    const data = new FormData(event.currentTarget)
    const paths = data.get('paths')
    const files = (typeof paths === 'string' ? paths : '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
    const uploads = data.getAll('uploads').filter((value): value is File => value instanceof File && value.name !== '')
    try { await controller.create(objective, ids, coordinatorId, files, uploads, id.current, mode, name, models) }
    catch (error) { controller.report(error) }
    finally { pending.current = false; setBusy(false) }
  }
  return <form className={`${css.form} ${css.newForm}`} onSubmit={(event) => { void submit(event) }}>
    <div className={css.formMain}><section className={css.formSection}><h2><span>01</span>{t('goal')}</h2>
    <label className={css.field}>{t('shortName')}<Input aria-label={t('shortName')} placeholder={t('shortNameHint')} value={name} maxLength={120} required disabled={busy} onChange={event => { setName(event.target.value) }} /></label>
    <label className={css.field}><textarea aria-label={t('goal')} value={objective} onChange={(event) => { setObjective(event.target.value) }} placeholder={t('goalHint')} rows={6} required disabled={busy} /></label>
    <p className={css.hint}>{t('goalConstraintHint')}</p></section>
    {state.modelsLoading && <p role="status">{t('loading')}</p>}{state.modelsError !== null && <details><summary>{t('chooseModelsHint')}</summary>{state.modelsError}</details>}
    <ModelFields t={t} models={models} directory={state.modelDirectory} change={setModels} manage={() => { controller.modelSettings(true) }} disabled={busy} />
    <section className={css.formSection}><h2><span>02</span>{t('selectServers')}</h2><p className={css.hint}>{t('selectHint')}</p>
    <fieldset disabled={busy} className={css.serverOptions}>
      <legend className={css.srOnly}>{t('selectServers')}</legend>
      {servers.length === 0 && <p className={css.empty}>{t('noServers')}</p>}
      {servers.map(server => <div key={server.id} className={`${css.serverOption} ${ids.includes(server.id) ? css.selected : ''}`}>
        <Checkbox label={server.name} checked={ids.includes(server.id)} onChange={(checked) => { setIds(current => checked ? [...current, server.id] : current.filter(id => id !== server.id)) }} />
        <small>{server.username}@{server.host}</small><small>{state.probes[server.id]?.gpuInfo ?? t('connectionUnchecked')}</small>
      </div>)}
    </fieldset><div className={css.coordinatorChoice}><span>{t('experimentCoordinator')}</span>
      <Selection label={t('experimentCoordinator')} value={coordinatorId} disabled={busy || ids.length < 2}
        options={servers.filter(server => ids.includes(server.id)).map(server => ({ value: server.id, label: server.name }))} onChange={setChosenCoordinator} />
      <p className={css.hint}>{t(ids.length === 1 ? 'singleNodeCoordinator' : 'coordinatorSelectionHint')}</p>
    </div><p className={css.hint}>{t('coordinatorOverlapHint')}</p></section>
    <section className={css.formSection}><h2><span>03</span>{t('attachments')}</h2>
    <div className={css.field}><span>{t('attachments')}</span><div className={css.actions}>
      <input ref={uploadsInput} type="file" name="uploads" aria-label={t('attachments')} hidden multiple disabled={busy}
        onChange={event => { setUploadNames(Array.from(event.currentTarget.files ?? [], file => file.name)) }} />
      <Button variant="outline" icon={<IconPaperclipOutlineRegular />} disabled={busy} onClick={() => { uploadsInput.current?.click() }}>{t('chooseFiles')}</Button>
      <span className={css.hint}>{uploadNames.length === 0 ? t('noFilesSelected') : uploadNames.join(' · ')}</span>
    </div></div>
    <label>{t('dataPaths')}<textarea name="paths" defaultValue={draft?.request.files.join('\n')} rows={2} disabled={busy} /></label>
    {draft !== undefined && draft.request.uploads.length > 0 && <p>{t('attachAgain')}</p>}
    </section>
    <section className={css.formSection}><h2><span>04</span>{t('automation')}</h2><div className={css.modes}>
      {(['automatic', 'semi'] as const).map(value => <Button key={value} variant="outline" className={`${css.mode} ${mode === value ? css.selected : ''}`} aria-pressed={mode === value} disabled={busy} onClick={() => { setMode(value) }}>
        <span>{t(value)}</span><small>{t(value === 'automatic' ? 'automaticHint' : 'semiHint')}</small>
      </Button>)}
    </div><p className={css.hint}>{t('noBudgetHint')}</p></section>
    <div className={css.formFooter}><span className={css.hint}>{t('handoverHint')}</span><Button type="submit" variant="primary" disabled={busy || ids.length === 0 || objective.trim() === '' || name.trim() === '' || !modelsReady(models, state.modelDirectory)}>{busy ? t('submitting') : t('submit')}</Button></div>
    </div><aside className={css.summary}><h3>{t('summary')}</h3><dl><dt>{t('goal')}</dt><dd>{objective || t('goalHint')}</dd><dt>{t('servers')}</dt><dd>{servers.filter(server => ids.includes(server.id)).map(server => server.name).join(' · ') || t('noSelection')}</dd><dt>{t('experimentCoordinator')}</dt><dd>{servers.find(server => server.id === coordinatorId)?.name ?? t('noSelection')}</dd><dt>{t('attachments')}</dt><dd>{uploadNames.join(' · ') || t('noFilesSelected')}</dd><dt>{t('automation')}</dt><dd>{t(mode)}</dd></dl><p>{t('agentModelHint')}</p>{models !== undefined && <dl>{(['preparation', 'planning', 'execution'] as const).map(phase => <div key={phase}><dt>{t(`${phase}Model`)}</dt><dd>{models[phase].provider} · {models[phase].model}</dd></div>)}</dl>}</aside>
  </form>
}

function ExperimentDetail({ controller, t, row, state, onClone, renderFactorySlot }: ViewProps & PropsRenderFactories & { row: FleetExperiment; state: Snapshot; onClone: () => void }) {
  const [tab, setTab] = useState<'overview' | 'agentRecords' | 'monitoring' | 'files' | 'services'>('overview')
  useEffect(() => { controller.setDetailView(tab) }, [controller, tab])
  const [deleting, setDeleting] = useState<string[]>()
  const [approving, setApproving] = useState(false)
  const [logDestination, setLogDestination] = useState<{ serverId: string; commandId: string }>()
  const status = row.latest?.state ?? row.state
  const id = row.request.experimentId
  const retrying = state.retrying.includes(id)
  const ended = ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(status) && row.latest?.resourcesReleased !== false
  const title = row.request.name ?? (row.submission?.protocol === 4 ? row.submission.name : row.request.objective.split('\n')[0]?.slice(0, 120))
  const act = (operation: () => Promise<unknown>) => { void operation().catch(error => { controller.report(error) }) }
  return <article className={`${css.detail} ${tab === 'agentRecords' || tab === 'monitoring' ? css.readerDetail : ''}`}>
    <header className={css.detailHeader}><Button variant="outline" size="sm" className={css.detailBack} icon={<IconChevronLeftOutlineRegular size={16} />} onClick={() => { controller.select(null) }}>{t('backToExperiments')}</Button><div className={css.detailHeading}><div className={css.titleLine}><h2 title={title}>{title}</h2><span role="status">{retrying ? <Tag tone="info">{t('retrying')}</Tag> : <ExperimentStatus row={row} t={t} />}</span></div>
      <p className={css.hint}>{row.servers.map(server => server.name).join(' · ')} · {t('coordinator')}: {row.coordinator.name} · {new Date(row.createdAt).toLocaleString()}{!state.registry.servers.some(server => server.id === row.coordinator.id) && <span> · {t('serverConfigurationRemoved')}</span>}</p></div>
      <div className={css.actions}><Button variant="ghost" size="sm" onClick={onClone}>{t('clone')}</Button><Button variant="ghost" size="sm" onClick={() => { act(() => controller.refresh()) }}>{t('refresh')}</Button>
        <Button variant="outline" size="sm" disabled={ended} onClick={() => { act(() => controller.cancel(id)) }}>{t('cancel')}</Button><Button variant="ghost" size="sm" className={css.dangerText} onClick={() => { setDeleting([id]) }}>{t('deleteExperiment')}</Button></div>
    </header>
    {deleting !== undefined && <DeleteExperimentsDialog controller={controller} t={t} ids={deleting} close={() => { setDeleting(undefined) }} />}
    <nav className={css.detailTabs}>{(['overview', 'agentRecords', 'monitoring', 'files', 'services'] as const).map(key => <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => { setTab(key) }}>{t(key)}</button>)}</nav>
    {tab === 'agentRecords' && <AgentRecords renderFactorySlot={renderFactorySlot} row={row} controller={controller} t={t} onLog={(serverId, commandId) => { setLogDestination({ serverId, commandId }); setTab('monitoring') }} />}
    {tab === 'monitoring' && <RuntimeMonitor row={row} controller={controller} t={t} {...(logDestination === undefined ? {} : { destination: logDestination })} />}
    {tab === 'overview' && <ExperimentOverview row={row} t={t} retrying={retrying} execution={state.executionReads[id]} installations={state.installations.filter(value => value.experimentId === id)} onRetry={() => { act(() => controller.retry(id)) }} onView={setTab}>
      {row.latest?.questions?.filter(question => question.state === 'open').map(question => <ExperimentQuestionCard key={question.questionId} controller={controller} t={t} question={question}
        records={state.streams[`${id}/events`]?.text.split('\n').filter(line => line.includes(question.sessionId)).join('\n') ?? ''} />)}
      {row.latest?.questions?.some(question => question.state === 'answered') && <p className={css.hint}>{t('replySaved')}</p>}
      <ExecutionPlan row={row} t={t} execution={state.executionReads[id]} approving={approving} onApprove={() => {
        const plan = (row.latest ?? row.receipt)?.plan
        if (approving || plan === undefined) return
        setApproving(true)
        void controller.approve(id, plan.revision).catch(error => { controller.report(error) }).finally(() => { setApproving(false) })
      }} />
    </ExperimentOverview>}
    {tab === 'services' && <div className={css.overview}>{(row.latest?.services.length ?? 0) === 0 && <p className={css.empty}>{t('serviceEmpty')}</p>}<Services controller={controller} t={t} row={row} /></div>}
    {tab === 'files' && <section className={css.overview} aria-label={t('files')}>
      {state.filesTruncated && <p>{t('fileTruncated')}</p>}{state.files.length === 0 && <p className={css.empty}>{t('noOutput')}</p>}
      {state.files.map(file => <div key={`${file.serverId}/${file.path}`} className={css.file}>
        <div><span>{file.path.slice(file.path.lastIndexOf('/') + 1)}</span><small>{row.servers.find(server => server.id === file.serverId)?.name} · {file.path}</small></div>
        <small>{t('bytes', { size: file.size })}</small><time>{new Date(file.modifiedAt).toLocaleString()}</time>
        <Button variant="outline" size="sm" onClick={() => { act(async () => { const url = await controller.download(id, file); const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.path.slice(file.path.lastIndexOf('/') + 1); anchor.click() }) }}>{t('download')}</Button>
      </div>)}
    </section>}
  </article>
}

function Services({ controller, t, row }: ViewProps & { row: FleetExperiment }) {
  const [response, setResponse] = useState<string>()
  const [path, setPath] = useState('/')
  const [method, setMethod] = useState<'GET' | 'POST'>('GET')
  const [body, setBody] = useState('')
  const blocked = controller.store.getSnapshot().experiments.filter(task => task.request.experimentId !== row.request.experimentId
    && task.waitingFor.some(id => row.servers.some(server => server.id === id)))
  return <section className={css.list}>
    {blocked.length > 0 && <p>{t('serviceBlocks', { goals: blocked.map(task => task.request.objective).join(' · ') })}</p>}
    {(row.latest?.services ?? []).map(service => <article key={service.id} className={css.card}>
      <h3>{row.request.name ?? row.request.objective.split('\n')[0]}</h3><p>{row.servers.find(server => server.id === service.serverId)?.name} · {t(service.state)}</p>
      <p>{t('modelArtifact')}: {service.modelPath}</p><p>{service.id} · 127.0.0.1:{service.port}</p>
      {service.modelName !== undefined && <p>{t('servedModel')}: {service.modelName}</p>}
      {service.external !== undefined && <PublicService key={service.id} controller={controller} t={t} service={service} />}
      {service.detail !== undefined && <p role="alert">{service.detail}</p>}
      <details><summary>{t('execution')}</summary><pre className={css.log}>{service.command}</pre></details>
      <div className={css.fields}>
        <label>{t('servicePath')}<Input value={path} onChange={event => { setPath(event.target.value) }} /></label>
        <div className={css.field}><span>{t('httpMethod')}</span><Selection label={t('httpMethod')} value={method}
          options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]} onChange={setMethod} /></div>
      </div>
      {method === 'POST' && <label>{t('serviceBody')}<textarea value={body} onChange={event => { setBody(event.target.value) }} rows={3} /></label>}
      <div className={css.actions}>
        <Button variant="outline" disabled={service.state !== 'healthy'} onClick={() => { void controller.accessService(row.request.experimentId, service.id, path, method, method === 'POST' ? body : undefined).then(setResponse).catch(error => { controller.report(error) }) }}>{t('accessService')}</Button>
        <Button variant="outline" disabled={service.released} onClick={() => { void controller.stopService(row.request.experimentId, service.id).catch(error => { controller.report(error) }) }}>{t('stopService')}</Button>
      </div>
    </article>)}
    {response !== undefined && <pre className={css.log}>{response}</pre>}
  </section>
}

function PublicService({ controller, t, service }: ViewProps & { service: InferenceService }) {
  const [access, setAccess] = useState<ServiceAccessInfo>()
  const [busy, setBusy] = useState(false)
  const external = service.external
  if (external === undefined) return null
  const show = async () => {
    setBusy(true)
    try { setAccess(await controller.serviceAccessInfo(service.experimentId, service.id)) }
    catch (error) { controller.report(error) }
    finally { setBusy(false) }
  }
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  return <section className={css.list} aria-label={t('publicInferenceSettings')}>
    <p>{t('externalInferenceUrl')}: <code>{external.url}</code> · {t('mappedPort')}: {external.port}</p>
    <div className={css.actions}><Tag tone={external.state === 'reachable' ? 'success' : external.state === 'unreachable' ? 'warning' : 'neutral'}>{t(`external-${external.state}`)}</Tag>
      {external.checkedAt !== undefined && <time>{new Date(external.checkedAt).toLocaleString()}</time>}</div>
    <p className={css.hint}>{t('externalCheckHint')}</p>
    {external.detail !== undefined && <p role="alert" className={css.error}>{external.detail}</p>}
    {!service.released && external.state !== 'stopped' && <>
      <Button variant="outline" disabled={busy} onClick={() => { if (access !== undefined) setAccess(undefined); else void show() }}>{access === undefined ? t('showServiceAccess') : t('hideServiceAccess')}</Button>
      {access !== undefined && <><p className={css.hint}>{t('serviceKeyHint')}</p><pre className={css.log}>{`curl ${quote(access.url.replace(/\/$/, '') + service.healthPath)} -H ${quote('Authorization: Bearer ' + access.token)}`}</pre></>}
    </>}
  </section>
}
