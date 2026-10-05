/** Official DSH trajectories consume independently owned, complete phase event feeds. */
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, Tooltip, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { PropsRenderFactories, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AgentRecord, AgentRecordCursor, ExperimentPhase } from '@aspera/experiments/types'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { ExperimentsController } from './controller.ts'
import { experimentProgress } from './experiment-progress.ts'
import css from './ExperimentsPage.module.css'

type Entry = { type: 'event'; event: { seq: number; time: number; type: string; data: unknown } }
type EventWindow = { entries: readonly Entry[]; hasMore: boolean; revision: number; change: { kind: 'replace' | 'append' | 'prepend'; entries: readonly Entry[] } }
type Paging = { openState: 'loading' | 'ready'; loadingOlder: boolean; hasMore: boolean }
type Cell = { sourceSeq?: number; callId?: string }
function fileAttachments(record: AgentRecord | undefined): { attachmentId: string; name: string }[] {
  if (record === undefined || record.truncated) return []
  const pending: unknown[] = [JSON.parse(record.data)]; const found = new Map<string, string>()
  while (pending.length > 0) {
    const value = pending.pop()
    if (value === null || typeof value !== 'object') continue
    if ('attachmentId' in value && typeof value.attachmentId === 'string' && 'name' in value && typeof value.name === 'string'
      && 'bytes' in value && typeof value.bytes === 'number' && !('mediaType' in value)) found.set(value.attachmentId, value.name)
    pending.push(...Object.values(value))
  }
  return [...found].map(([attachmentId, name]) => ({ attachmentId, name }))
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotFactoryMap {
    'trajectory.readonly': { scope: 'root'; props: { feed: TraceFeed['events']; paging: TraceFeed['paging']; loadOlder: () => Promise<boolean>;
      toolbar: ReactNode; onSelection: (cell: Cell | null) => void; onReadingChange: (history: boolean) => void;
      loadImage: (attachment: { attachmentId: string }) => Promise<string> } }
  }
}

class TraceFeed {
  readonly events = createSnapshotStore<EventWindow>({ entries: [], hasMore: false, revision: 0, change: { kind: 'replace', entries: [] } })
  readonly paging = createSnapshotStore<Paging>({ openState: 'loading', loadingOlder: false, hasMore: false })
  readonly status = createSnapshotStore({ missing: false, truncated: false, disconnected: false, count: 0 })
  records: AgentRecord[] = []
  private cursor: AgentRecordCursor | undefined
  private pending = false
  private disposed = false
  private readingHistory = false
  constructor(private readonly controller: ExperimentsController, private readonly experimentId: string, private readonly phase: ExperimentPhase) {}
  dispose(): void { this.disposed = true }
  activate(): void { this.disposed = false }
  reading(history: boolean): void { this.readingHistory = history; if (!history) void this.load() }
  async load(older = false): Promise<boolean> {
    if (this.pending || this.disposed || (!older && this.readingHistory)) return false
    this.pending = true
    if (older) this.paging.update(value => { value.loadingOlder = true })
    const scope = { experimentId: this.experimentId, phase: this.phase, operation: 'trajectory' }
    try {
      const page = await this.controller.records({ experimentId: this.experimentId, phase: this.phase,
        ...(older ? { beforeSeq: this.records[0]?.seq ?? 0 } : this.cursor === undefined ? {} : { cursor: this.cursor }) })
      if (this.disposed) return false
      if (!older) this.cursor = page.cursor
      const previous = this.records
      const merged = new Map((page.reset ? [] : previous).map(record => [record.seq, record]))
      for (const record of page.records) merged.set(record.seq, record)
      const records = [...merged.values()].sort((a, b) => a.seq - b.seq)
      const budget = this.controller.displayLimits().traceRetainedChars
      let chars = records.reduce((size, row) => size + row.data.length, 0)
      while (records.length > 1 && chars > budget) chars -= (older ? records.pop()! : records.shift()!).data.length
      this.records = records
      if (older && this.cursor !== undefined) this.cursor = { ...this.cursor, nextSeq: (records.at(-1)?.seq ?? -1) + 1 }
      const entries = records.filter(record => !record.truncated).map((record): Entry => ({ type: 'event', event: {
        seq: record.seq, time: record.time, type: record.type, data: JSON.parse(record.data),
      } }))
      if (page.reset || page.records.some(row => !previous.some(old => old.seq === row.seq))) {
        const snapshot = this.events.getSnapshot()
        const unchangedEdge = !page.reset && previous.length > 0 && records.length === merged.size
        const change = unchangedEdge ? { kind: older ? 'prepend' as const : 'append' as const,
          entries: entries.filter(entry => !previous.some(old => old.seq === entry.event.seq)) } : { kind: 'replace' as const, entries }
        this.events.set({ entries, hasMore: (records[0]?.seq ?? 0) > 0, revision: snapshot.revision + 1, change })
      }
      this.paging.set({ openState: 'ready', loadingOlder: false, hasMore: (records[0]?.seq ?? 0) > 0 })
      this.status.set({ missing: page.missing, truncated: records.some(row => row.truncated), disconnected: false, count: records.length })
      this.controller.sourceRecovered(scope)
      return page.records.length > 0
    } catch (error) {
      if (!this.disposed) { this.status.update(value => { value.disconnected = true }); this.controller.report(error, scope) }
      return false
    } finally { this.pending = false; if (!this.disposed) this.paging.update(value => { value.openState = 'ready'; value.loadingOlder = false }) }
  }
}

const phases = ['preparation', 'planning', 'execution'] as const
const phaseLabels = { preparation: 'phasePreparation', planning: 'phasePlanning', execution: 'phaseExecution' } as const

/** @param props - experiment, official renderer and API. @returns read-only official trajectories without a composer. */
export function AgentRecords({ controller, row, t, onLog, renderFactorySlot }: { controller: ExperimentsController; row: FleetExperiment;
  t: TranslateNS<'experiments'>; onLog: (serverId: string, commandId: string) => void } & PropsRenderFactories) {
  const [phase, setPhase] = useState<ExperimentPhase>('preparation')
  const [feeds] = useState(() => ({ preparation: new TraceFeed(controller, row.request.experimentId, 'preparation'),
    planning: new TraceFeed(controller, row.request.experimentId, 'planning'), execution: new TraceFeed(controller, row.request.experimentId, 'execution') }))
  const progress = experimentProgress(row)
  useEffect(() => { for (const feed of Object.values(feeds)) feed.activate(); return () => { for (const feed of Object.values(feeds)) feed.dispose() } }, [feeds])
  const toolbar = <div className={css.tracePhases}>{phases.map((value, index) => {
    const state = index < progress.phase ? 'completed' : index > progress.phase ? 'idle' : progress.issue ? 'failed' : progress.busy ? 'running' : 'idle'
    return <button key={value} type="button" aria-pressed={phase === value} data-state={state} onClick={() => { setPhase(value) }}>
      <span aria-hidden>{state === 'completed' ? '✓' : state === 'failed' ? '×' : state === 'running' ? '●' : '○'}</span>{t(phaseLabels[value])}</button>
  })}</div>
  return <section className={css.officialRecords} aria-label={t('agentRecords')}>
    {phases.map(value => <PhaseTrace key={value} active={phase === value} phase={value} feed={feeds[value]} row={row} t={t}
      toolbar={toolbar} renderFactorySlot={renderFactorySlot} controller={controller} onLog={onLog} />)}
  </section>
}

function PhaseTrace({ active, phase, feed, row, t, toolbar, renderFactorySlot, controller, onLog }: { active: boolean; phase: ExperimentPhase;
  feed: TraceFeed; row: FleetExperiment; t: TranslateNS<'experiments'>; toolbar: ReactNode; controller: ExperimentsController;
  onLog: (serverId: string, commandId: string) => void } & PropsRenderFactories) {
  const status = useSyncExternalStore(feed.status.subscribe, feed.status.getSnapshot)
  const paging = useSyncExternalStore(feed.paging.subscribe, feed.paging.getSnapshot)
  const [selected, setSelected] = useState<Cell | null>(null)
  const [downloading, setDownloading] = useState<string>()
  const [images] = useState(() => new Map<string, Promise<string>>())
  useEffect(() => () => { for (const image of images.values()) void image.then(url => URL.revokeObjectURL(url), () => {}); images.clear() }, [images])
  const loadImage = (attachment: { attachmentId: string }) => {
    const cached = images.get(attachment.attachmentId)
    if (cached !== undefined) return cached
    const event = feed.records.find(record => !record.truncated && record.data.includes(JSON.stringify(attachment.attachmentId)))
    if (event === undefined) return Promise.reject(new Error(t('eventsMissing')))
    const loading = controller.traceImage(row.request.experimentId, phase, event.seq, attachment.attachmentId)
    images.set(attachment.attachmentId, loading); return loading
  }
  useEffect(() => {
    if (!active) return
    void feed.load()
    const timer = setInterval(() => { void feed.load() }, controller.displayLimits().pollIntervalMs)
    return () => { clearInterval(timer) }
  }, [active, feed, controller])
  const record = feed.records.find(record => record.seq === selected?.sourceSeq)
    ?? feed.records.find(record => selected?.callId !== undefined && record.type === 'tool/call' && record.data.includes(JSON.stringify(selected.callId)))
  const model = row.models?.[phase]; const label = model === undefined ? row.agentModel.model : `${model.provider} · ${model.model}`
  return <div className={css.phaseTrace} data-active={active} aria-hidden={!active}>
    <div className={css.officialTrace}>{renderFactorySlot('trajectory.readonly', { feed: feed.events, paging: feed.paging,
      loadOlder: () => feed.load(true), toolbar, onSelection: setSelected, onReadingChange: value => feed.reading(value), loadImage }, { fallback: <p>{t('trajectoryUnavailable')}</p> })}</div>
    <footer className={css.readerFooter}><span>{paging.openState === 'loading' ? <StateDot state="ongoing" /> : t(status.disconnected ? 'disconnected' : status.missing ? 'eventsMissing' : status.truncated ? 'recordTruncated' : 'traceReadOnly')}
      {' · '}{status.count}</span>
      {record?.log !== undefined && <Button size="sm" variant="ghost" onClick={() => { onLog(record.log!.serverId, record.log!.commandId) }}>{t('viewLogs')}</Button>}
      {fileAttachments(record).map(file => <Tooltip key={file.attachmentId} label={file.name} portal><Button size="sm" variant="ghost" disabled={downloading !== undefined}
        onClick={() => {
          setDownloading(file.attachmentId)
          void controller.traceImage(row.request.experimentId, phase, record!.seq, file.attachmentId).then(url => {
            const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); URL.revokeObjectURL(url)
          }).catch(error => { controller.report(error, { experimentId: row.request.experimentId, phase, operation: 'attachment' }) }).finally(() => { setDownloading(undefined) })
        }}>{downloading === file.attachmentId ? <StateDot state="ongoing" /> : t('download')} · {file.name}</Button></Tooltip>)}
      <Tooltip label={label} portal><span className={css.traceModel} tabIndex={0}>{label}</span></Tooltip></footer>
  </div>
}
