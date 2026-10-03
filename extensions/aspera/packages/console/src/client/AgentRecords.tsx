/** Read-only phase traces with independently scrolling records and details. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentRecord, AgentRecordCursor, ExperimentPhase } from '@aspera/experiments/types'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { ExperimentsController } from './controller.ts'
import { experimentConversation } from './conversation.ts'
import css from './ExperimentsPage.module.css'

function summary(record: AgentRecord): string {
  try {
    const event: unknown = JSON.parse(record.data)
    if (typeof event !== 'object' || event === null) return record.type
    if ('name' in event && typeof event.name === 'string') return event.name
    const messages = experimentConversation(JSON.stringify({ sessionId: record.sessionId, event: { type: record.type, seq: record.seq, data: event } }) + '\n')
    return messages[0]?.text.split('\n')[0] ?? record.type
  } catch (error) { void error; return record.type } // A marked oversized payload can be partial JSON.
}
function kind(record: AgentRecord): 'user' | 'assistant' | 'tool' | 'system' {
  return record.type.startsWith('tool/') ? 'tool' : record.type.startsWith('assistant/') || record.type.startsWith('llm/') ? 'assistant' : record.type === 'user/message' ? 'user' : 'system'
}

/** @param props - one immutable experiment and its record API. @returns phase timeline, conversation and event inspector. */
export function AgentRecords({ controller, row, t, onLog }: { controller: ExperimentsController; row: FleetExperiment;
  t: TranslateNS<'experiments'>; onLog: (serverId: string, commandId: string) => void }) {
  const [phase, setPhase] = useState<ExperimentPhase>('preparation')
  const [view, setView] = useState<'trace' | 'dialogue'>('trace')
  const [records, setRecords] = useState<AgentRecord[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [detail, setDetail] = useState<'overview' | 'rawContent' | 'eventSource'>('overview')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [follow, setFollow] = useState(true)
  const following = useRef(true); following.current = follow
  const loader = useRef<(before?: number) => Promise<void>>(async () => {})
  useEffect(() => {
    let alive = true; let pending = false; let cursor: AgentRecordCursor | undefined
    setRecords([]); setSelected(null); setLoading(true); setMissing(false); setError(null)
    const load = async (before?: number) => {
      if (pending || !alive) return
      pending = true
      try {
        const page = await controller.records({ experimentId: row.request.experimentId, phase,
          ...(before === undefined ? cursor === undefined ? {} : { cursor } : { beforeSeq: before }) })
        if (!alive) return
        if (before === undefined) cursor = page.cursor
        setMissing(page.missing); setError(null); setHasMore(page.hasMore)
        setRecords(previous => {
          const items = new Map((page.reset ? [] : previous).map(item => [item.seq, item]))
          for (const item of page.records) items.set(item.seq, item)
          const sorted = [...items.values()].sort((a, b) => a.seq - b.seq)
          let chars = 0; const retained: AgentRecord[] = []
          for (const item of before === undefined ? sorted.toReversed() : sorted) {
            if (chars >= controller.displayLimits().retainedTextChars) break
            retained.push(item); chars += item.data.length
          }
          return retained.sort((a, b) => a.seq - b.seq)
        })
      } catch (cause) { if (alive) setError(String(cause)) }
      finally { pending = false; if (alive) setLoading(false) }
    }
    loader.current = load; void load()
    const timer = setInterval(() => { if (following.current) void load() }, controller.displayLimits().pollIntervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [controller, row.request.experimentId, phase])
  const visible = records.filter(record => `${record.type} ${summary(record)}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  const active = records.find(record => record.seq === selected) ?? visible.at(-1)
  const start = records[0]?.time ?? 0; const end = records.at(-1)?.time ?? start
  const model = row.models?.[phase]
  const messages = experimentConversation(records.filter(record => !record.truncated).map(record => JSON.stringify({ sessionId: record.sessionId,
    event: { type: record.type, seq: record.seq, data: JSON.parse(record.data) } })).join('\n') + '\n')
  return <section className={css.records} aria-label={t('agentRecords')}>
    <div className={css.recordToolbar}>
      <div className={css.segmented}>{(['preparation', 'planning', 'execution'] as const).map(value => <button key={value} aria-pressed={phase === value} onClick={() => { setPhase(value) }}>{t(value === 'preparation' ? 'phasePreparation' : value === 'planning' ? 'phasePlanning' : 'phaseExecution')}</button>)}</div>
      <div className={css.viewSwitch}>{(['dialogue', 'trace'] as const).map(value => <button key={value} aria-pressed={view === value} onClick={() => { setView(value) }}>{t(value)}</button>)}</div>
      <span className={css.recordModel} title={model === undefined ? row.agentModel.model : `${model.provider}/${model.model}`}>{model?.model ?? row.agentModel.model}</span>
    </div>
    {error !== null && <details className={css.inlineWarning} open><summary>{t('disconnected')}</summary>{error}</details>}
    {missing && <p className={css.hint}>{t('eventsMissing')}</p>}
    <div className={css.traceSurface}>
      <div className={css.traceTools}><span>{t('eventTime')}</span><div className={css.actions}>
        {(records[0]?.seq ?? 0) > 0 && <Button size="sm" variant="ghost" onClick={() => { setFollow(false); void loader.current(records[0]?.seq) }}>{t('loadEarlier')}</Button>}
        <Button size="sm" variant="ghost" aria-pressed={follow} onClick={() => { setFollow(value => !value) }}>{t(follow ? 'pauseFollow' : 'follow')}</Button>
        {hasMore && <Button size="sm" variant="ghost" onClick={() => { void loader.current() }}>{t('loadMore')}</Button>}
        <Input aria-label={t('searchEvents')} placeholder={t('searchEvents')} value={search} onChange={event => { setSearch(event.target.value) }} />
      </div></div>
      {view === 'trace' ? <>
        <div className={css.timeline} aria-label={t('trace')}><div className={css.timelineScale}><span>{start === 0 ? '—' : new Date(start).toLocaleTimeString()}</span><span>{end === 0 ? '—' : new Date(end).toLocaleTimeString()}</span></div>
          {(['user', 'assistant', 'tool'] as const).map(role => <div className={css.timelineLane} key={role}><span>{t(role === 'user' ? 'traceInput' : role === 'assistant' ? 'traceModel' : 'traceTools')}</span><div>{records.filter(record => kind(record) === role || (role === 'user' && kind(record) === 'system')).map(record =>
            <button key={record.seq} className={css[role]} title={`${new Date(record.time).toLocaleTimeString()} · ${summary(record)}`} aria-label={`${record.seq} · ${summary(record)}`}
              style={{ left: `${end === start ? 0 : Math.min(98, (record.time - start) / (end - start) * 98)}%` }} onClick={() => { setSelected(record.seq) }} />)}</div></div>)}
        </div>
        <div className={css.traceSplit}><div className={css.eventList} role="list" aria-label={t('trace')}>
          {loading && <p className={css.hint}>{t('loading')}</p>}
          {!loading && visible.length === 0 && <p className={css.empty}>{t('eventsMissing')}</p>}
          {visible.map(record => <button className={css.eventRow} role="listitem" key={record.seq} aria-pressed={active?.seq === record.seq}
            onClick={() => { setSelected(record.seq) }}><span className={`${css.eventRole} ${css[kind(record)]}`}>{kind(record) === 'tool' ? '#' : kind(record) === 'assistant' ? '✦' : '·'}</span>
            <span className={css.eventSummary}>{summary(record)}</span><small>{new Date(record.time).toLocaleTimeString()}</small></button>)}
        </div><aside className={css.eventInspector} aria-label={t('eventDetails')}>
          {active !== undefined && <><div className={css.sectionHeading}><Tag>{t(kind(active))}</Tag><small>#{active.seq}</small></div>
            <h3>{summary(active)}</h3><div className={css.viewSwitch}>{(['overview', 'rawContent', 'eventSource'] as const).map(value => <button key={value} aria-pressed={detail === value} onClick={() => { setDetail(value) }}>{t(value)}</button>)}</div>
            <div className={css.inspectorContent}>
              {detail === 'rawContent' ? <><pre>{active.truncated ? active.data : JSON.stringify(JSON.parse(active.data), null, 2)}</pre>{active.truncated && <p>{t('recordTruncated')}</p>}</>
                : detail === 'eventSource' ? <dl className={css.facts}><dt>{t('experimentId')}</dt><dd>{active.experimentId}</dd><dt>{t('eventSource')}</dt><dd>{active.sessionId}</dd><dt>{t('eventSequence')}</dt><dd>{active.seq}</dd><dt>{t('eventTime')}</dt><dd>{new Date(active.time).toLocaleString()}</dd></dl>
                : <><dl className={css.facts}><dt>{t('latestStage')}</dt><dd>{t(active.phase)}</dd><dt>{t('eventTime')}</dt><dd>{new Date(active.time).toLocaleString()}</dd><dt>{t('eventSource')}</dt><dd>{active.type}</dd></dl><p className={css.prewrap}>{summary(active)}</p>
                  {active.log !== undefined && <Button size="sm" variant="outline" onClick={() => { if (active.log !== undefined) onLog(active.log.serverId, active.log.commandId) }}>{t('viewLogs')}</Button>}</>}
            </div></>}
        </aside></div>
      </> : <div className={css.conversationPane}>{messages.length === 0 && <p className={css.empty}>{t('eventsMissing')}</p>}{messages.map(message => <article className={css.messageCard} key={message.seq}><h3>{t(message.role)}</h3><pre>{message.text}</pre></article>)}</div>}
    </div>
  </section>
}
