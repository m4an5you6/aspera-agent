/** Experiment forms and read-only execution details receive all effects through props. */
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Button, Checkbox, IconGoalOutline16, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { FleetExperiment, ClusterServer, FleetServerInput } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentsController } from './controller.ts'
import css from './ExperimentsPage.module.css'
import { experimentConversation } from './conversation.ts'

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
export function ExperimentsIcon({ size }: PropsRuntime<'sidebar.panellist'>) { return <IconGoalOutline16 size={size} /> }

/**
 * Render independent experiment forms and execution details.
 * @param props - controller actions, live state, and dictionary.
 * @returns independent experiment panel.
 */
export function ExperimentsPage({ controller, useExperiments, t }: PageProps) {
  const state = useExperiments(value => value)
  const [view, setView] = useState<'list' | 'servers' | 'new'>('list')
  const [draft, setDraft] = useState<FleetExperiment | undefined>()
  useEffect(() => { controller.setVisible(true); return () => { controller.setVisible(false) } }, [controller])
  const detail = state.experiments.find(row => row.request.experimentId === state.selectedId)
  const act = (operation: () => Promise<unknown>) => { void operation().catch((error: unknown) => { controller.report(error) }) }
  return <section className={css.page}>
    <header className={css.header}>
      <div><h1>{t('title')}</h1><p>{t('introduction')}</p></div>
      <div className={css.actions}>
        <Button variant="outline" onClick={() => { controller.select(null); setView('servers') }}>{t('servers')}</Button>
        <Button variant="primary" onClick={() => { controller.select(null); setDraft(undefined); setView('new') }}>{t('newExperiment')}</Button>
        <Button variant="ghost" onClick={() => { act(() => controller.refresh()) }}>{t('refresh')}</Button>
      </div>
    </header>
    {state.error !== null && <p role="alert" className={css.error}>{t('error')}: {state.error}</p>}
    {(view !== 'list' || detail !== undefined) && <Button variant="ghost" onClick={() => { controller.select(null); setView('list') }}>{t('back')}</Button>}
    {view === 'servers' ? <Servers controller={controller} t={t} state={state} />
      : view === 'new' ? <NewExperiment key={draft?.request.experimentId ?? 'new'} controller={controller} t={t}
        servers={state.registry.servers} draft={draft} onSubmitted={() => { setView('list') }} />
        : detail !== undefined ? <ExperimentDetail controller={controller} t={t} row={detail} state={state} onClone={() => {
          controller.select(null); setDraft(detail); setView('new')
        }} /> : <div className={css.list}>
          {state.experiments.length === 0 && <p>{t('empty')}</p>}
          {state.experiments.map(row => <button key={row.request.experimentId} className={css.card}
            onClick={() => { controller.select(row.request.experimentId) }}>
            <strong>{row.request.objective}</strong><span>{t(row.latest?.state ?? row.state)}</span>
            <small>{row.servers.map(server => server.name).join(' · ')}</small>
            {row.receipt !== undefined && <small>{t('handover')}</small>}
            {row.waitingFor.length > 0 && <small>{t('waiting',
              { servers: row.servers.filter(server => row.waitingFor.includes(server.id)).map(server => server.name).join(', ') })}</small>}
          </button>)}
        </div>}
  </section>
}

type Snapshot = ReturnType<ExperimentsController['store']['getSnapshot']>

function Servers({ controller, t, state }: ViewProps & { state: Snapshot }) {
  const [editing, setEditing] = useState<ClusterServer | 'new' | undefined>()
  return <section className={css.list}>
    <p>{t('coordinatorHint')}</p>
    <Button variant="outline" onClick={() => { setEditing('new') }}>{t('addServer')}</Button>
    {editing !== undefined && <ServerForm key={editing === 'new' ? 'new' : editing.id} controller={controller} t={t}
      server={editing === 'new' ? undefined : editing} done={() => { setEditing(undefined) }} />}
    {state.registry.servers.map((server) => {
      const probe = state.probes[server.id]
      return <article key={server.id} className={css.card}>
        <h2>{server.name} {server.id === state.registry.coordinatorId && <small>{t('coordinator')}</small>}</h2>
        <p>{server.username}@{server.host}:{server.sshPort}</p>
        {state.probeErrors[server.id] !== undefined ? <p role="alert">{state.probeErrors[server.id]}</p>
          : state.probes[server.id] === undefined && <p>{t('connectionUnchecked')}</p>}
        {probe !== undefined && <><p>{t('connectionReady')} · {t('allocations',
          { count: probe.allocations.length })}</p>
        <pre>{probe.gpuInfo}</pre></>}
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
    <label>{t('name')}<Input name="name" defaultValue={server?.name} required /></label>
    <label>{t('host')}<Input name="host" defaultValue={server?.host} required /></label>
    <label>{t('username')}<Input name="username" autoComplete="username" defaultValue={server?.username} required /></label>
    <label>{t('password')}<Input name="password" type="password" autoComplete="new-password" required={server?.authMode !== 'password'} /></label>
    <p>{t('passwordHint')}</p>
    <label>{t('sshPort')}<Input name="sshPort" type="number" min={1} max={65535} defaultValue={server?.sshPort ?? 22} required /></label>
    <label>{t('remotePort')}<Input name="remotePort" type="number" min={1} max={65534} defaultValue={server?.remotePort ?? 43019} required /></label>
    <label>{t('remoteRoot')}<Input name="remoteRoot" defaultValue={server?.remoteRoot} required /></label>
    <label>{t('trainingAddress')}<Input name="trainingAddress" defaultValue={server?.trainingAddress} /></label>
    <p>{t('networkHint')}</p>
    <Button type="submit" variant="primary" disabled={busy}>{busy ? t('busy') : t('save')}</Button>
  </form>
}

function NewExperiment({ controller, t, servers, draft, onSubmitted }: ViewProps & {
  servers: ClusterServer[]
  draft: FleetExperiment | undefined
  onSubmitted: () => void
}) {
  const [objective, setObjective] = useState(draft?.request.objective ?? '')
  const [ids, setIds] = useState<string[]>(draft?.servers.map(server => server.id)
    .filter(id => servers.some(server => server.id === id)) ?? [])
  const [busy, setBusy] = useState(false)
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
    try { await controller.create(objective, ids, files, uploads, id.current); onSubmitted() }
    catch (error) { controller.report(error) }
    finally { pending.current = false; setBusy(false) }
  }
  return <form className={css.form} onSubmit={(event) => { void submit(event) }}>
    <label>{t('goal')}<textarea value={objective} onChange={(event) => { setObjective(event.target.value) }} placeholder={t('goalHint')} rows={5} required disabled={busy} /></label>
    <fieldset disabled={busy}><legend>{t('selectServers')}</legend><p>{t('selectHint')}</p>
      {servers.length === 0 && <p>{t('noServers')}</p>}
      {servers.map(server => <Checkbox key={server.id} label={`${server.name} (${server.username}@${server.host})`} checked={ids.includes(server.id)}
        onChange={(checked) => { setIds(current => checked ? [...current, server.id] : current.filter(id => id !== server.id)) }} />)}
    </fieldset>
    <label>{t('attachments')}<input type="file" name="uploads" multiple disabled={busy} /></label>
    <label>{t('dataPaths')}<textarea name="paths" defaultValue={draft?.request.files.join('\n')} rows={2} disabled={busy} /></label>
    {draft !== undefined && draft.request.uploads.length > 0 && <p>{t('attachAgain')}</p>}
    <Button type="submit" variant="primary" disabled={busy || ids.length === 0 || objective.trim() === ''}>{busy ? t('submitting') : t('submit')}</Button>
  </form>
}

function ExperimentDetail({ controller, t, row, state,
  onClone }: ViewProps & { row: FleetExperiment; state: Snapshot; onClone: () => void }) {
  const [tab, setTab] = useState<'overview' | 'conversation' | 'logs' | 'files'>('overview')
  const [nodeId, setNodeId] = useState(row.servers[0]?.id ?? '')
  const status = row.latest?.state ?? row.state
  const id = row.request.experimentId
  const source = state.streams[`${id}/${tab === 'conversation' ? 'events' : nodeId}`]
  const ended = ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(status) && row.latest?.resourcesReleased !== false
  return <article className={css.detail}>
    <h2>{row.request.objective}</h2><p role="status">{t(status)}</p>
    {row.receipt !== undefined && <p className={css.handover}>{row.receipt.handover}</p>}
    <div className={css.actions}>
      <Button variant="outline" onClick={onClone}>{t('clone')}</Button>
      <Button variant="outline" disabled={ended} onClick={() => { void controller.cancel(id).catch((error: unknown) => { controller.report(error) }) }}>{t('cancel')}</Button>
    </div>
    <nav className={css.actions}>{(['overview', 'conversation', 'logs', 'files'] as const).map(key =>
      <Button key={key} variant={tab === key ? 'primary' : 'ghost'} onClick={() => { setTab(key) }}>{t(key)}</Button>)}</nav>
    {(row.latest?.detail ?? row.detail) !== undefined && <p role="alert" className={css.error}>{row.latest?.detail ?? row.detail}</p>}
    {row.waitingFor.length > 0 && <p>{t('waiting',
      { servers: row.servers.filter(server => row.waitingFor.includes(server.id)).map(server => server.name).join(', ') })}</p>}
    {row.latest?.resourcesReleased === false && ['failed', 'blocked', 'interrupted', 'cancelling'].includes(status) && <p>{t('held')}</p>}
    {tab === 'overview' && <dl className={css.facts}>
      <dt>{t('experimentId')}</dt><dd>{id}</dd><dt>{t('servers')}</dt><dd>{row.servers.map(server => server.name).join(', ')}</dd>
      <dt>{t('dispatchSession')}</dt><dd>{row.sessionId}</dd><dt>{t('executionSession')}</dt><dd>{row.latest?.sessionId ?? t('sessionEmpty')}</dd>
      <dt>{t('sourceVersion')}</dt><dd>{row.submission?.deploymentId ?? t('preparing')}</dd>
      {row.receipt !== undefined && <><dt>{t('receipt')}</dt><dd><details><summary>{t('receipt')}</summary><pre className={css.log}>{JSON.stringify(row.receipt, null, 2)}</pre></details></dd></>}
    </dl>}
    {tab === 'logs' && <label>{t('selectNode')}<select value={nodeId} onChange={(event) => { setNodeId(event.target.value) }}>
      {row.servers.map(server => <option key={server.id} value={server.id}>{server.name}</option>)}
    </select></label>}
    {(tab === 'logs' || tab === 'conversation') && <>
      {source?.reset === true && <p>{t('logReset')}</p>}
      {tab === 'conversation' ? <section>
        {experimentConversation(source?.text ?? '').map(message => <article key={message.seq}>
          <h3>{t(message.role)}</h3><pre className={css.log}>{message.text}</pre>
        </article>)}
        {!source?.text && <p>{t('sessionEmpty')}</p>}
        <details><summary>{t('sessionRecords')}</summary><pre className={css.log}>{source?.text}</pre></details>
      </section> : <pre className={css.log}>{source?.text || t('noOutput')}</pre>}
      {tab === 'logs' && <details><summary>{t('execution')}</summary><pre className={css.log}>{state.streams[`${id}/agent-log`]?.text || t('noOutput')}</pre></details>}
    </>}
    {tab === 'files' && <section>
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
