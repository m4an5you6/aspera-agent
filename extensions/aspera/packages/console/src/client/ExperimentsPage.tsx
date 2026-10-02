import { needsExperimentAttention } from '@aspera/experiments'
/** Experiment forms and read-only execution details receive all effects through props. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import {
  Button, Checkbox, IconChevronDownOutlineRegular, IconGoalOutlineRegular, IconPaperclipOutlineRegular,
  IconPlusOutlineRegular, IconRefreshOutlineRegular, Input, Menu, Tag, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { FleetExperiment, ClusterServer, FleetServerInput } from '@aspera/dispatch/types'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentsController } from './controller.ts'
import css from './ExperimentsPage.module.css'
import { experimentConversation } from './conversation.ts'
import { experimentAttentionCount, attentionLabel } from './attention.ts'
import { ExperimentQuestionCard } from './QuestionCard.tsx'

/** Actions and observable state owned by the plugin controller. */
export interface ExperimentsInjected {
  controller: ExperimentsController
  hooks: { experiments: ExperimentsController['store'] }
}

type PageProps = InjectFace<ExperimentsInjected> & PropsLocale<'experiments'>
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
export function ExperimentsPage({ controller, useExperiments, t }: PageProps) {
  const state = useExperiments(value => value)
  const [view, setView] = useState<'list' | 'servers' | 'new' | 'services'>('list')
  const [draft, setDraft] = useState<FleetExperiment | undefined>()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'pending' | 'running' | 'queued' | 'completed' | 'failed'>('all')
  const pendingCount = experimentAttentionCount(state.experiments)
  const rows = state.experiments.filter(row => {
    const status = row.latest?.state ?? row.state
    const matches = filter === 'all' || (filter === 'pending' ? row.latest !== undefined && needsExperimentAttention(row.latest) : status === filter)
    return matches && `${row.request.objective} ${row.request.experimentId} ${row.servers.map(server => server.name).join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())
  })
  useEffect(() => { controller.setVisible(true); return () => { controller.setVisible(false) } }, [controller])
  const detail = state.experiments.find(row => row.request.experimentId === state.selectedId)
  const act = (operation: () => Promise<unknown>) => { void operation().catch((error: unknown) => { controller.report(error) }) }
  return <section className={css.page}>
    <header className={css.header}>
      <div className={css.heading}><h1>{t('title')}</h1><p>{t('introduction')}</p></div>
      <div className={css.actions}>
        <Button variant="ghost" onClick={() => { controller.select(null); setView('list'); setFilter('pending') }}>{t('pending')}{pendingCount > 0 && <span className={css.count}>{attentionLabel(pendingCount)}</span>}</Button>
        <Button variant="outline" onClick={() => { controller.select(null); setView('servers') }}>{t('servers')}</Button>
        <Button variant="outline" onClick={() => { controller.select(null); setView('services') }}>{t('services')}</Button>
        <Button variant="primary" icon={<IconPlusOutlineRegular />} onClick={() => { controller.select(null); setDraft(undefined); setView('new') }}>{t('newExperiment')}</Button>
        <Button variant="ghost" icon={<IconRefreshOutlineRegular />} onClick={() => { act(() => controller.refresh()) }}>{t('refresh')}</Button>
      </div>
    </header>
    {state.error !== null && <p role="alert" className={css.error}>{t('error')}: {state.error}</p>}
    <div className={css.content}>
    {(view !== 'list' || detail !== undefined) && <div className={css.actions}><Button variant="ghost" size="sm" onClick={() => { controller.select(null); setView('list') }}>{t('back')}</Button></div>}
    {view === 'services' ? <section className={css.list}><p className={css.hint}>{t('serviceHint')}</p>{state.experiments.every(row => !row.latest?.services.length) && <p className={css.empty}>{t('serviceEmpty')}</p>}{state.experiments.map(row => <Services key={row.request.experimentId} controller={controller} t={t} row={row} />)}</section> : view === 'servers' ? <Servers controller={controller} t={t} state={state} />
      : view === 'new' ? <NewExperiment key={draft?.request.experimentId ?? 'new'} controller={controller} t={t}
        servers={state.registry.servers} state={state} draft={draft} onSubmitted={() => { setView('list') }} />
        : detail !== undefined ? <ExperimentDetail controller={controller} t={t} row={detail} state={state} onClone={() => {
          controller.select(null); setDraft(detail); setView('new')
        }} /> : <div className={css.list}>
          <div className={css.listTools}><Input aria-label={t('search')} placeholder={t('search')} value={search} onChange={event => { setSearch(event.target.value) }} />
            <Selection label={t('statusFilter')} value={filter} options={(['all', 'pending', 'running', 'queued', 'completed', 'failed'] as const).map(value => ({ value, label: t(value) }))} onChange={setFilter} /></div>
          {rows.length === 0 ? <div className={css.emptyState}><IconGoalOutlineRegular size={28} /><h2>{state.experiments.length === 0 ? t('empty') : t('noMatches')}</h2><p>{t('newHint')}</p></div> : <div className={css.tableWrap}><table className={css.table}>
            <thead><tr><th>{t('goal')}</th><th>{t('status')}</th><th>{t('servers')}</th><th>{t('updated')}</th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.request.experimentId}>
              <td><button className={css.rowLink} onClick={() => { controller.select(row.request.experimentId) }}>{row.request.objective}</button><small>{row.latest?.progress?.phase ?? (row.receipt !== undefined ? t('handoverShort') : t(row.state))}</small></td>
              <td><Tag tone={row.latest !== undefined && needsExperimentAttention(row.latest) ? 'warning' : 'neutral'}>{t(row.latest?.state ?? row.state)}</Tag></td>
              <td>{row.servers.map(server => server.name).join(' · ')}</td><td><time>{new Date(row.latest?.updatedAt ?? row.createdAt).toLocaleString()}</time></td>
            </tr>)}</tbody></table></div>}
        </div>}
    </div>
  </section>
}

type Snapshot = ReturnType<ExperimentsController['store']['getSnapshot']>

function Servers({ controller, t, state }: ViewProps & { state: Snapshot }) {
  const [editing, setEditing] = useState<ClusterServer | 'new' | undefined>()
  return <section className={css.list}>
    <div className={css.sectionHeading}><p className={css.hint}>{t('coordinatorHint')}</p>
      <Button variant="outline" icon={<IconPlusOutlineRegular />} onClick={() => { setEditing('new') }}>{t('addServer')}</Button></div>
    <Modal open={editing !== undefined} onClose={() => { setEditing(undefined) }} title={editing === 'new' ? t('addServer') : t('editServer')} closeLabel={t('discard')} backdropBlur={false} className={css.serverModal}>
      {editing !== undefined && <ServerForm key={editing === 'new' ? 'new' : editing.id} controller={controller} t={t}
        server={editing === 'new' ? undefined : editing} done={() => { setEditing(undefined) }} />}
    </Modal>
    {state.registry.servers.map((server) => {
      const probe = state.probes[server.id]
      const allocated = new Set<string>(state.experiments.filter(row => row.latest?.resourcesReleased === false
        && row.servers.some(node => node.id === server.id)).map(row => row.request.experimentId))
      for (const id of probe?.allocations ?? []) if (!state.experiments.some(row => row.request.experimentId === id)) allocated.add(id)
      return <article key={server.id} className={css.card}>
        <div className={css.cardHeading}><h2>{server.name}</h2>{server.id === state.registry.coordinatorId && <Tag tone="info">{t('coordinator')}</Tag>}</div>
        <p className={css.hint}>{server.username}@{server.host}:{server.sshPort}</p>
        {state.probeErrors[server.id] !== undefined ? <p role="alert" className={css.error}>{state.probeErrors[server.id]}</p>
          : state.probes[server.id] === undefined && <p className={css.hint}>{t('connectionUnchecked')}</p>}
        <div className={css.actions}><Tag tone={allocated.size > 0 ? 'warning' : 'neutral'}>{t('allocations', { count: allocated.size })}</Tag>
          {probe !== undefined && <Tag tone="success">{t('connectionReady')}</Tag>}</div>
        {probe !== undefined && <pre className={css.log}>{probe.gpuInfo}</pre>}
        <div className={css.actions}>
          <Button variant="outline" onClick={() => { setEditing(server) }}>{t('edit')}</Button>
          <Button variant="outline" onClick={() => { void controller.probe(server.id).catch((error: unknown) => { controller.report(error) }) }}>{t('test')}</Button>
          <Button variant="ghost" disabled={server.id === state.registry.coordinatorId} onClick={() => { void controller.removeServer(server.id).catch((error: unknown) => { controller.report(error) }) }}>{t('remove')}</Button>
        </div>
      </article>})}
  </section>
}

function ServerForm({ controller, t, server, done }: ViewProps & { server: ClusterServer | undefined; done: () => void }) {
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (pending.current) return
    const data = new FormData(event.currentTarget)
    const field = (name: string) => { const value = data.get(name); return typeof value === 'string' ? value : '' }
    const value: FleetServerInput = { id: server?.id ?? controller.newId(), name: field('name'), host: field('host'),
      username: field('username'), sshPort: Number(field('sshPort')), remotePort: Number(field('remotePort')),
      remoteRoot: field('remoteRoot'), authMode: 'password',
      ...(server?.passwordRef === undefined ? {} : { passwordRef: server.passwordRef }),
      ...(server?.knownHostsFile === undefined ? {} : { knownHostsFile: server.knownHostsFile }),
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
    <label>{t('password')}<Input name="password" type="password" autoComplete="new-password" required={server?.authMode !== 'password'} /></label>
    <label>{t('sshPort')}<Input name="sshPort" type="number" min={1} max={65535} defaultValue={server?.sshPort ?? 22} required /></label>
    <label>{t('remotePort')}<Input name="remotePort" type="number" min={1} max={65534} defaultValue={server?.remotePort ?? controller.initialControlPort()} required /></label>
    <label>{t('remoteRoot')}<Input name="remoteRoot" defaultValue={server?.remoteRoot} required /></label>
    <label>{t('trainingAddress')}<Input name="trainingAddress" defaultValue={server?.trainingAddress} /></label>
    </div>
    <div className={css.hints}><p>{t('passwordHint')}</p><p>{t('networkHint')}</p></div>
    <div className={css.actions}>
      <Button type="submit" variant="primary" disabled={busy}>{busy ? t('busy') : t('save')}</Button>
      <Button variant="ghost" disabled={busy} onClick={done}>{t('discard')}</Button>
    </div>
  </form>
}

function Selection<Value extends string>({ label, value, options, onChange, disabled = false }: {
  label: string; value: Value; options: readonly { value: Value; label: string }[]
  onChange: (value: Value) => void; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} portal className={css.selection} selectedId={value}
    items={options.map(option => ({ id: option.value, label: option.label }))}
    onClose={() => { setOpen(false) }} onSelect={id => {
      const selected = options.find(option => option.value === id)
      if (selected !== undefined) onChange(selected.value)
      setOpen(false)
    }} anchor={<Button variant="outline" className={css.selectButton} aria-label={label}
      aria-haspopup="menu" aria-expanded={open && !disabled} disabled={disabled} onClick={() => { setOpen(current => !current) }}>
      <span>{options.find(option => option.value === value)?.label}</span><IconChevronDownOutlineRegular />
    </Button>} />
}

function NewExperiment({ controller, t, servers, state, draft, onSubmitted }: ViewProps & {
  servers: ClusterServer[]
  state: Snapshot
  draft: FleetExperiment | undefined
  onSubmitted: () => void
}) {
  const [objective, setObjective] = useState(draft?.request.objective ?? '')
  const [ids, setIds] = useState<string[]>(draft?.servers.map(server => server.id)
    .filter(id => servers.some(server => server.id === id)) ?? [])
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
    try { await controller.create(objective, ids, files, uploads, id.current, mode); onSubmitted() }
    catch (error) { controller.report(error) }
    finally { pending.current = false; setBusy(false) }
  }
  return <form className={`${css.form} ${css.newForm}`} onSubmit={(event) => { void submit(event) }}>
    <div className={css.formMain}><section className={css.formSection}><h2><span>01</span>{t('goal')}</h2>
    <label className={css.field}><textarea aria-label={t('goal')} value={objective} onChange={(event) => { setObjective(event.target.value) }} placeholder={t('goalHint')} rows={6} required disabled={busy} /></label>
    <p className={css.hint}>{t('goalConstraintHint')}</p></section>
    <section className={css.formSection}><h2><span>02</span>{t('selectServers')}</h2><p className={css.hint}>{t('selectHint')}</p>
    <fieldset disabled={busy} className={css.serverOptions}>
      <legend className={css.srOnly}>{t('selectServers')}</legend>
      {servers.length === 0 && <p className={css.empty}>{t('noServers')}</p>}
      {servers.map(server => <div key={server.id} className={`${css.serverOption} ${ids.includes(server.id) ? css.selected : ''}`}>
        <Checkbox label={server.name} checked={ids.includes(server.id)} onChange={(checked) => { setIds(current => checked ? [...current, server.id] : current.filter(id => id !== server.id)) }} />
        <small>{server.username}@{server.host}</small><small>{state.probes[server.id]?.gpuInfo ?? t('connectionUnchecked')}</small>
      </div>)}
    </fieldset></section>
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
    <div className={css.formFooter}><span className={css.hint}>{t('handoverHint')}</span><Button type="submit" variant="primary" disabled={busy || ids.length === 0 || objective.trim() === ''}>{busy ? t('submitting') : t('submit')}</Button></div>
    </div><aside className={css.summary}><h3>{t('summary')}</h3><dl><dt>{t('goal')}</dt><dd>{objective || t('goalHint')}</dd><dt>{t('servers')}</dt><dd>{servers.filter(server => ids.includes(server.id)).map(server => server.name).join(' · ') || t('noSelection')}</dd><dt>{t('attachments')}</dt><dd>{uploadNames.join(' · ') || t('noFilesSelected')}</dd><dt>{t('automation')}</dt><dd>{t(mode)}</dd></dl><p>{t('agentModelHint')}</p></aside>
  </form>
}

function ExperimentDetail({ controller, t, row, state,
  onClone }: ViewProps & { row: FleetExperiment; state: Snapshot; onClone: () => void }) {
  const [tab, setTab] = useState<'overview' | 'conversation' | 'logs' | 'files' | 'services'>('overview')
  const [nodeId, setNodeId] = useState<string>(row.servers[0]?.id ?? '')
  const status = row.latest?.state ?? row.state
  const id = row.request.experimentId
  const source = state.streams[`${id}/${tab === 'conversation' ? 'events' : nodeId}`]
  const ended = ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(status) && row.latest?.resourcesReleased !== false
  return <article className={css.detail}>
    <h2>{row.request.objective}</h2><p role="status"><Tag>{t(status)}</Tag></p>
    {row.receipt !== undefined && <p className={css.handover}>{row.receipt.handover}</p>}
    <div className={css.actions}>
      <Button variant="outline" onClick={onClone}>{t('clone')}</Button>
      <Button variant="outline" disabled={ended} onClick={() => { void controller.cancel(id).catch((error: unknown) => { controller.report(error) }) }}>{t('cancel')}</Button>
    </div>
    <nav className={css.actions}>{(['overview', 'conversation', 'logs', 'files', 'services'] as const).map(key =>
      <Button key={key} variant={tab === key ? 'primary' : 'ghost'} onClick={() => { setTab(key) }}>{t(key)}</Button>)}</nav>
    {(row.latest?.detail ?? row.detail) !== undefined && <p role="alert" className={css.error}>{row.latest?.detail ?? row.detail}</p>}
    {row.waitingFor.length > 0 && <p>{t('waiting',
      { servers: row.servers.filter(server => row.waitingFor.includes(server.id)).map(server => server.name).join(', ') })}</p>}
    {row.latest?.resourcesReleased === false && ['failed', 'blocked', 'interrupted', 'cancelling'].includes(status) && <p>{t('held')}</p>}
    {row.latest?.questions?.filter(question => question.state === 'open').map(question => <ExperimentQuestionCard key={question.questionId} controller={controller} t={t} question={question}
      records={state.streams[`${id}/events`]?.text.split('\n').filter(line => line.includes(question.sessionId)).join('\n') ?? ''} />)}
    {row.latest?.questions?.some(question => question.state === 'answered') && <p role="status" className={css.hint}>{t('replySaved')}</p>}
    {row.latest?.plan !== undefined && <section aria-label={t('plan')}>
      <h3>{t('plan')}</h3><p>{row.latest.plan.summary}</p><ol>{row.latest.plan.steps.map((step, index) => <li key={index}>{step}</li>)}</ol>
      {row.latest.plan.frameworks.map(framework => <p key={framework.name}>{framework.name} {framework.version} · <a href={framework.documentation} target="_blank" rel="noreferrer">{framework.documentation}</a></p>)}
      {status === 'awaiting-approval' && <><p>{t('planHint')}</p><Button variant="primary" onClick={() => { void controller.approve(id, row.latest!.plan!.revision).catch(error => { controller.report(error) }) }}>{t('approve')}</Button></>}
    </section>}
    {row.latest?.progress !== undefined && <section><h3>{t('progress')}</h3><p>{row.latest.progress.phase}</p><div className={css.metrics}>{Object.entries(row.latest.progress.metrics).map(([name, value]) => <div key={name}><span>{name}</span><strong>{value.toLocaleString()}</strong></div>)}</div><p className={css.hint}>{t('latestMetrics', { time: new Date(row.latest.progress.updatedAt).toLocaleString() })}</p></section>}
    {tab === 'services' && <Services controller={controller} t={t} row={row} />}
    {tab === 'overview' && <dl className={css.facts}>
      <dt>{t('experimentId')}</dt><dd>{id}</dd><dt>{t('servers')}</dt><dd>{row.servers.map(server => server.name).join(', ')}</dd>
      <dt>{t('dispatchSession')}</dt><dd>{row.sessionId}</dd><dt>{t('executionSession')}</dt><dd>{row.latest?.sessionId ?? t('sessionEmpty')}</dd>
      <dt>{t('sourceVersion')}</dt><dd>{row.submission?.deploymentId ?? t('preparing')}</dd>
      {row.submission?.protocol === 1 && <><dt>{t('legacyLimits')}</dt><dd><pre className={css.log}>{JSON.stringify(row.submission.strategy.budget, null, 2)}</pre></dd></>}
      {row.latest?.executions.length !== 0 && row.latest !== undefined && <><dt>{t('actualVersions')}</dt><dd><pre className={css.log}>{JSON.stringify(row.latest.executions, null, 2)}</pre></dd></>}
      {row.receipt !== undefined && <><dt>{t('receipt')}</dt><dd><details><summary>{t('receipt')}</summary><pre className={css.log}>{JSON.stringify(row.receipt, null, 2)}</pre></details></dd></>}
    </dl>}
    {tab === 'logs' && <div className={css.field}><span>{t('selectNode')}</span><Selection label={t('selectNode')} value={nodeId}
      options={row.servers.map(server => ({ value: server.id, label: server.name }))} onChange={setNodeId} /></div>}
    {(tab === 'logs' || tab === 'conversation') && <section aria-label={t(tab)}>
      {source?.generation === '' && <p>{t('logMissing')}</p>}
      {source?.reset === true && <p>{t('logReset')}</p>}
      {tab === 'conversation' ? <section>
        {experimentConversation(source?.text ?? '').map(message => <article key={message.seq}>
          <h3>{t(message.role)}</h3><pre className={css.log}>{message.text}</pre>
        </article>)}
        {!source?.text && <p>{t('sessionEmpty')}</p>}
        <details><summary>{t('sessionRecords')}</summary><pre className={css.log}>{source?.text}</pre></details>
      </section> : <pre className={css.log}>{source?.text || t('noOutput')}</pre>}
      {tab === 'logs' && <details><summary>{t('execution')}</summary><pre className={css.log}>{state.streams[`${id}/agent-log`]?.text || t('noOutput')}</pre></details>}
    </section>}
    {tab === 'files' && <section aria-label={t('files')}>
      {state.filesTruncated && <p>{t('fileTruncated')}</p>}
      {state.files.length === 0 && <p>{t('noOutput')}</p>}
      {state.files.map(file => <div key={`${file.serverId}/${file.path}`} className={css.file}>
        <span>{row.servers.find(server => server.id === file.serverId)?.name}: {file.path}</span><small>{t('bytes',
          { size: file.size })}</small>
        <time>{new Date(file.modifiedAt).toLocaleString()}</time>
        <Button variant="outline" onClick={() => { void controller.download(id, file).then((url) => {
          const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.path.slice(file.path.lastIndexOf('/') + 1); anchor.click()
        }).catch((error: unknown) => { controller.report(error) }) }}>{t('download')}</Button>
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
      <h3>{row.request.objective}</h3><p>{row.servers.find(server => server.id === service.serverId)?.name} · {t(service.state)}</p>
      <p>{t('modelArtifact')}: {service.modelPath}</p><p>{service.id} · 127.0.0.1:{service.port}</p>
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
