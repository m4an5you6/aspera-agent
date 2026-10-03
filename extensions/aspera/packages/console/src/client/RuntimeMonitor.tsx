/** A bounded stdout/stderr reader with explicit follow and reconnection state. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { ExperimentProcess, ProcessLogPage } from '@aspera/experiments/types'
import type { ExperimentsController } from './controller.ts'
import { Choice } from './ModelFields.tsx'
import css from './ExperimentsPage.module.css'

/** @param props - experiment sources and optional tool-log destination. @returns node and process log reader. */
export function RuntimeMonitor({ row, controller, t, destination, aggregate }: { row: FleetExperiment; controller: ExperimentsController;
  t: TranslateNS<'experiments'>; destination?: { serverId: string; commandId: string }; aggregate: Record<string, { text: string; reset: boolean }> }) {
  const [node, setNode] = useState(destination?.serverId ?? row.servers[0]?.id ?? '')
  const [processId, setProcess] = useState(destination?.commandId ?? '')
  const [processes, setProcesses] = useState<ExperimentProcess[]>([])
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout')
  const [follow, setFollow] = useState(true)
  const [text, setText] = useState('')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<'logMissing' | 'logReset' | null>(null)
  const output = useRef<HTMLPreElement>(null)
  const aggregateSource = useRef<string | undefined>(undefined)
  const following = useRef(follow); following.current = follow
  useEffect(() => {
    let alive = true; let pending = false
    const load = async () => {
      if (!alive || pending) return
      pending = true
      try { const rows = await controller.processes(row.request.experimentId, node); if (alive) setProcesses(rows) }
      catch (cause) { if (alive) setError(String(cause)) }
      finally { pending = false }
    }
    void load(); const timer = setInterval(() => { void load() }, controller.displayLimits().pollIntervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [controller, row.request.experimentId, node])
  useEffect(() => {
    if (processId !== '') { aggregateSource.current = undefined; return }
    const key = `${row.request.experimentId}/${node}`
    if (follow || aggregateSource.current !== key) {
      aggregateSource.current = key
      const source = aggregate[key]; setText(source?.text ?? ''); setNotice(source?.reset ? 'logReset' : null)
    }
  }, [aggregate, follow, processId, row.request.experimentId, node])
  useEffect(() => {
    if (processId === '') return
    let alive = true; let pending = false; let cursor: ProcessLogPage['cursor'] | undefined
    let decoder = new TextDecoder()
    setText(''); setError(null); setNotice(null)
    const load = async (initial = false) => {
      if (pending || (!initial && !following.current) || !alive) return
      pending = true
      try {
        const page = await controller.processLog({ experimentId: row.request.experimentId, serverId: node, commandId: processId, stream, ...(cursor === undefined ? {} : { cursor }) })
        if (!alive) return
        cursor = page.cursor; setError(null)
        if (page.chunk.reset) decoder = new TextDecoder()
        setNotice(page.missing ? 'logMissing' : page.chunk.reset ? 'logReset' : null)
        const bytes = Uint8Array.from(atob(page.chunk.data), character => character.charCodeAt(0))
        const appended = decoder.decode(bytes, { stream: true })
        setText(previous => ((page.chunk.reset ? '' : previous) + appended).slice(-controller.displayLimits().retainedTextChars))
      } catch (cause) { if (alive) setError(String(cause)) }
      finally { pending = false }
    }
    void load(true); const timer = setInterval(() => { void load() }, controller.displayLimits().pollIntervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [controller, row.request.experimentId, node, processId, stream])
  useEffect(() => { if (follow && output.current !== null) output.current.scrollTop = output.current.scrollHeight }, [text, follow])
  const process = processes.find(item => item.commandId === processId)
  return <section className={css.monitor} aria-label={t('monitoring')}>
    <div className={css.monitorControls}><Choice label={t('selectNode')} value={node} options={row.servers.map(server => ({ value: server.id, label: server.name }))}
      onChange={value => { setNode(value); setProcess(''); setProcesses([]) }} />
      <Choice label={t('selectProcess')} value={processId} options={[{ value: '', label: t('nodeOverview') }, ...processes.map(process => ({ value: process.commandId, label: process.commandId }))]} onChange={setProcess} />
      {processId !== '' && <Choice label={t('logs')} value={stream} options={[{ value: 'stdout', label: 'stdout' }, { value: 'stderr', label: 'stderr' }]} onChange={setStream} />}
      <Button variant="outline" size="sm" aria-pressed={follow} onClick={() => { setFollow(value => !value) }}>{t(follow ? 'pauseFollow' : 'follow')}</Button>
      <Input aria-label={t('searchLogs')} placeholder={t('searchLogs')} value={search} onChange={event => { setSearch(event.target.value) }} />
    </div>
    {process !== undefined && <div className={css.processSummary}><Tag>{t(process.state)}</Tag><code>{process.command}</code></div>}
    {error !== null && <details className={css.inlineWarning}><summary>{t('disconnected')}</summary>{error}</details>}
    {notice !== null && <p role="status" className={css.hint}>{t(notice)}</p>}
    {row.latest?.progress === undefined ? <p className={css.hint}>{t('noMetrics')}</p> : <div className={css.monitorMetrics}><span>{row.latest.progress.phase}</span>{Object.entries(row.latest.progress.metrics).map(([key, value]) => <span key={key}>{key}: <strong>{value}</strong></span>)}</div>}
    <pre ref={output} className={css.monitorOutput}>{search === '' ? text || t('noOutput') : text.split('\n').filter(line => line.toLocaleLowerCase().includes(search.toLocaleLowerCase())).join('\n') || t('noMatches')}</pre>
  </section>
}
