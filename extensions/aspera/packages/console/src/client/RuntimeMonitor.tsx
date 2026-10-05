/** Continuous observations with independent receiving and reading positions. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, Tooltip, StateDot, IconDownloadOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { ObservationSource, ObservationPage, ObservationCursor, MetricSample } from '@aspera/experiments/types'
import type { ExperimentsController } from './controller.ts'
import { Choice } from './ModelFields.tsx'
import css from './ExperimentsPage.module.css'

type LogLine = ObservationPage['lines'][number] & { source: string }
function bounded(lines: LogLine[], maximum: number, older = false): LogLine[] {
  const unique = [...new Map(lines.map(line => [`${line.source}/${line.seq}`, line])).values()]
    .sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.source.localeCompare(b.source) || a.seq - b.seq)
  let size = unique.reduce((size, line) => size + line.text.length, 0)
  while (size > maximum && unique.length > 1) size -= (older ? unique.pop()! : unique.shift()!).text.length
  return unique
}

/** @param props - selected experiment and optional tool source. @returns resource curves and a resizable read-only log ledger. */
export function RuntimeMonitor({ row, controller, t, destination }: { row: FleetExperiment; controller: ExperimentsController;
  t: TranslateNS<'experiments'>; destination?: { serverId: string; commandId: string } }) {
  const [node, setNode] = useState(destination?.serverId ?? row.servers[0]?.id ?? '')
  const [sourceId, setSourceId] = useState(destination === undefined ? '' : `process-${destination.commandId}`)
  const [sources, setSources] = useState<ObservationSource[]>([])
  const [stream, setStream] = useState<'all' | 'stdout' | 'stderr'>('all')
  const [samples, setSamples] = useState<MetricSample[]>([])
  const [lines, setLines] = useState<LogLine[]>([])
  const [search, setSearch] = useState('')
  const [health, setHealth] = useState({ directory: true, metrics: true, logs: true })
  const [readingHistory, setReadingHistory] = useState(false)
  const [gpuId, setGpuId] = useState('')
  const [lastResource, setLastResource] = useState<MetricSample>()
  const [lastGpu, setLastGpu] = useState<MetricSample>()
  const [lastTraining, setLastTraining] = useState<MetricSample>()
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<'logMissing' | 'logReset' | null>(null)
  const [unread, setUnread] = useState(0)
  const [logHeight, setLogHeight] = useState(46)
  const output = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLElement>(null)
  const following = useRef(true)
  const scrollPosition = useRef(0)
  const live = useRef<LogLine[]>([])
  const sourcesRef = useRef(sources); sourcesRef.current = sources
  const reader = useRef<(older?: boolean) => Promise<void>>(async () => {})
  const config = controller.displayLimits()
  const id = row.request.experimentId
  useEffect(() => {
    let alive = true; let pending = false; let lastSample: number | undefined
    setSources([]); setSamples([]); setLastResource(undefined); setLastGpu(undefined); setLastTraining(undefined); setLoading(true)
    const scope = { experimentId: id, serverId: node, operation: 'monitor-directory' }
    const load = async () => {
      if (!alive || pending) return
      pending = true
      const results = await Promise.allSettled([controller.logSources(id, node), controller.metrics({ experimentId: id, serverId: node,
        ...(lastSample === undefined ? {} : { after: lastSample - config.pollIntervalMs * 2 }) })])
      if (!alive) return
      const [directory, metrics] = results
      if (directory.status === 'fulfilled') {
        setSources(directory.value.sources); sourcesRef.current = directory.value.sources
        controller.sourceRecovered(scope)
        if (destination !== undefined && destination.serverId === node) {
          const selected = directory.value.sources.find(source => source.commandId === destination.commandId)
          if (selected !== undefined) setSourceId(current => current === `process-${destination.commandId}` ? selected.id : current)
        }
      }
      else controller.report(directory.reason, scope)
      if (metrics.status === 'fulfilled') {
        for (const sample of metrics.value) lastSample = Math.max(lastSample ?? 0, sample.time)
        const resource = metrics.value.findLast(sample => sample.training === undefined)
        const training = metrics.value.findLast(sample => sample.training !== undefined)
        if (resource !== undefined) setLastResource(resource)
        const gpu = metrics.value.findLast(sample => sample.gpus.length > 0)
        if (gpu !== undefined) setLastGpu(gpu)
        if (training !== undefined) setLastTraining(training)
        controller.sourceRecovered({ ...scope, operation: 'metrics' })
        setSamples(previous => [...new Map([...previous, ...metrics.value].map(sample => [`${sample.time}/${sample.training === undefined ? 'resource' : 'training'}`, sample])).values()]
          .filter(sample => sample.time > Date.now() - config.metricWindowMs).sort((a, b) => a.time - b.time).slice(-config.metricSampleLimit))
      } else controller.report(metrics.reason, { ...scope, operation: 'metrics' })
      setHealth(value => ({ ...value, directory: directory.status === 'fulfilled', metrics: metrics.status === 'fulfilled' })); setLoading(false); pending = false
    }
    void load(); const timer = setInterval(() => { void load() }, config.pollIntervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [controller, id, node, config, destination])
  useEffect(() => {
    let alive = true; let pending = false; let initial = true
    let catchup: ReturnType<typeof setTimeout> | undefined
    const cursors = new Map<string, ObservationCursor>(); const before = new Map<string, ObservationCursor>()
    const linked = destination !== undefined && destination.serverId === node && (sourceId === `process-${destination.commandId}` || sourcesRef.current.some(source => source.id === sourceId && source.commandId === destination.commandId))
    following.current = !linked; live.current = []; setLines([]); setUnread(0); setNotice(null); setReadingHistory(linked)
    const scope = { experimentId: id, serverId: node, operation: 'logs' }
    const load = async (older = false) => {
      if (!alive || pending) return
      const selected = sourcesRef.current.filter(source => sourceId === '' || source.id === sourceId)
        .filter(source => stream === 'all' || source.streams.includes(stream))
        .filter(source => !older || (before.get(source.id)?.offset ?? 1) > 0)
      if (selected.length === 0) return
      pending = true
      const anchor = output.current; const height = anchor?.scrollHeight ?? 0; const top = anchor?.scrollTop ?? 0
      try {
        const results = await Promise.allSettled(selected.map(source => controller.logRead({ experimentId: id, serverId: node, sourceId: source.id, stream,
          limit: config.observationReadBytes, ...(older ? before.has(source.id) ? { before: before.get(source.id)! } : {} : cursors.has(source.id) ? { cursor: cursors.get(source.id)! } : linked ? { fromStart: true } : {}) }).then(page => ({ source, page }))))
        if (!alive) return
        setHealth(value => ({ ...value, logs: results.every(result => result.status === 'fulfilled') }))
        const pages = results.flatMap((result, index) => {
          if (result.status === 'fulfilled') return [result.value]
          controller.report(result.reason, { ...scope, phase: selected[index]?.phase }); return []
        })
        const appended: LogLine[] = []; const resetSources = new Set<string>()
        for (const { source, page } of pages) {
          if (!older) cursors.set(source.id, page.cursor)
          if (older || !before.has(source.id) || page.reset) before.set(source.id, page.before)
          if (page.reset) { setNotice('logReset'); resetSources.add(source.id); live.current = live.current.filter(line => line.source !== source.id) }
          if (page.missing) setNotice('logMissing')
          appended.push(...page.lines.map(line => ({ ...line, source: source.id })))
        }
        if (!older) live.current = bounded([...live.current, ...appended], config.retainedTextChars)
        if (older || following.current || initial) setLines(previous => bounded([...previous.filter(line => !resetSources.has(line.source)), ...appended], config.retainedTextChars, older))
        else if (resetSources.size > 0) setLines(previous => previous.filter(line => !resetSources.has(line.source)))
        else if (appended.length > 0) setUnread(count => count + appended.length)
        initial = false
        if (!older && pages.some(({ page }) => page.hasMore)) catchup = setTimeout(() => { void load() }, 0)
        if (older) requestAnimationFrame(() => { if (alive && anchor) anchor.scrollTop = top + anchor.scrollHeight - height })
        if (results.every(result => result.status === 'fulfilled')) controller.sourceRecovered(scope)
      } catch (error) { if (alive) { setHealth(value => ({ ...value, logs: false })); controller.report(error, scope) } }
      finally { pending = false }
    }
    reader.current = load; void load()
    const timer = setInterval(() => { void load() }, config.pollIntervalMs)
    return () => { alive = false; clearInterval(timer); clearTimeout(catchup) }
  }, [controller, id, node, sourceId, stream, config, destination])
  useEffect(() => { if (following.current && output.current) { output.current.scrollTop = output.current.scrollHeight; scrollPosition.current = output.current.scrollTop } }, [lines])
  const latest = lastResource
  const training = lastTraining?.training
  const gpu = lastGpu?.gpus.find(gpu => gpu.id === gpuId) ?? lastGpu?.gpus[0]
  const disconnected = Object.values(health).some(value => !value)
  const legacy = sources.some(source => source.kind === 'legacy' && (sourceId === '' || source.id === sourceId))
  const percent = (value: number | undefined) => value === undefined ? '—' : `${value.toFixed(1)}%`
  const gib = (value: number | undefined) => value === undefined ? '—' : `${(value / 1073741824).toFixed(1)} GiB`
  const value = (name: string) => typeof training?.[name] === 'number' ? training[name] : undefined
  const charts = [
    { label: t('gpuMetric'), data: samples.filter(sample => sample.training === undefined).map(sample => ({ time: sample.time, value: sample.gpus.find(item => item.id === gpu?.id)?.utilization })), unit: '%' },
    { label: t('cpuMetric'), data: samples.filter(sample => sample.training === undefined).map(sample => ({ time: sample.time, value: sample.cpuPercent })), unit: '%' },
    { label: t('lossMetric'), data: samples.filter(sample => sample.training !== undefined).map(sample => ({ time: sample.time, value: typeof sample.training?.loss === 'number' ? sample.training.loss : undefined })), unit: '' },
  ]
  const goLatest = () => { following.current = true; setReadingHistory(false); setUnread(0); setLines([...live.current]); requestAnimationFrame(() => { if (output.current) output.current.scrollTop = output.current.scrollHeight }) }
  const visible = lines.filter(line => search === '' || line.text.toLocaleLowerCase().includes(search.toLocaleLowerCase()))
  return <section ref={surface} className={css.observationMonitor} aria-label={t('monitoring')}>
    <div className={css.metricHeading}><Choice label={t('selectNode')} value={node} options={row.servers.map(server => ({ value: server.id, label: server.name }))}
      onChange={value => { setNode(value); setSourceId(''); setGpuId('') }} />{(lastGpu?.gpus.length ?? 0) > 1
        ? <Choice label={t('gpuMetric')} value={gpu?.id ?? ''} options={lastGpu!.gpus.map(gpu => ({ value: gpu.id, label: gpu.name }))} onChange={setGpuId} />
        : <span>{gpu?.name ?? t('metricMissing')}</span>}<span className={css.metricTime}>{latest === undefined ? t('noMetrics') : t('sampledAt', { time: new Date(latest.time).toLocaleTimeString() })}
        {lastGpu !== undefined && latest?.gpus.length === 0 && ` · ${t('gpuMetric')} ${t('lastSample', { time: new Date(lastGpu.time).toLocaleTimeString() })}`}</span>
      <span data-disconnected={disconnected}>{loading ? <StateDot state="ongoing" /> : t(disconnected ? 'disconnected' : 'liveMonitoring')}</span></div>
    <div className={css.metricRegion}>
      <div className={css.metricTiles}>{[
        [t('gpuMetric'), percent(gpu?.utilization)], [t('gpuMemoryMetric'), gib(gpu?.memoryUsedBytes)], [t('cpuMetric'), percent(latest?.cpuPercent)],
        [t('memoryMetric'), gib(latest?.memoryUsedBytes)], [t('stepMetric'), String(value('step') ?? '—')], [t('lossMetric'), String(value('loss') ?? '—')], [t('throughputMetric'), String(value('tokens_per_second') ?? value('throughput') ?? '—')],
      ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className={css.metricCharts}>{charts.map(chart => <div key={chart.label} className={css.metricChart}><header><span>{chart.label}</span><small>{t('metricWindow', { minutes: config.metricWindowMs / 60000 })}</small></header>
        <MetricChart points={chart.data} label={chart.label} empty={t('metricMissing')} gapMs={config.pollIntervalMs * 3} /></div>)}</div>
    </div>
    <div role="separator" tabIndex={0} aria-label={t('resizeLogs')} aria-orientation="horizontal" aria-valuenow={logHeight} className={css.logResize}
      onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); setLogHeight(height => Math.max(25, Math.min(80, height + (event.key === 'ArrowUp' ? 5 : -5)))) } }}
      onPointerDown={event => { event.currentTarget.setPointerCapture(event.pointerId) }}
      onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = surface.current?.getBoundingClientRect(); if (bounds) setLogHeight(Math.max(25, Math.min(80, (bounds.bottom - event.clientY) / bounds.height * 100))) }}><span /></div>
    <div className={css.logReader} style={{ flexBasis: `${logHeight}%` }}>
      <div className={css.logToolbar}><span>{t('processLogs')}</span><Choice label={t('selectProcess')} value={sourceId} options={[{ value: '', label: t('nodeOverview') }, ...sources.map(source => ({ value: source.id, label: `${t(source.kind === 'preparation' ? 'sourcePreparation' : source.kind === 'agent' ? 'sourceAgent' : source.kind === 'legacy' ? 'sourceLegacy' : 'sourceProcess')} · ${source.label}` }))]} onChange={setSourceId} />
        <Choice label={t('logs')} value={stream} options={[{ value: 'all', label: t('allOutput') }, { value: 'stdout', label: 'stdout' }, { value: 'stderr', label: 'stderr' }]} onChange={setStream} />
        <Input aria-label={t('searchLogs')} placeholder={t('searchLogs')} value={search} onChange={event => { setSearch(event.target.value) }} />
        <Tooltip label={t('downloadLogs')} portal><Button variant="ghost" size="sm" disabled={sourceId === ''} aria-label={t('downloadLogs')} icon={<IconDownloadOutlineRegular />}
          onClick={() => { void controller.logDownload({ experimentId: id, serverId: node, sourceId, stream }).then(url => { const anchor = document.createElement('a'); anchor.href = url; anchor.download = ''; anchor.click() }).catch(error => { controller.report(error, { experimentId: id, serverId: node, operation: 'log-download' }) }) }} /></Tooltip></div>
      <div ref={output} className={css.logLines} role="region" aria-label={t('processLogs')} tabIndex={0} onScroll={event => {
        const pane = event.currentTarget; const upward = pane.scrollTop < scrollPosition.current
        scrollPosition.current = pane.scrollTop
        following.current = pane.scrollHeight - pane.clientHeight - pane.scrollTop < 32
        setReadingHistory(!following.current)
        if (upward && pane.scrollTop < 24 && !following.current && lines.length > 0) void reader.current(true)
      }}>
        {visible.length === 0 && <div className={css.logEmpty}>{t(lines.length === 0 ? 'noOutput' : 'noMatches')}</div>}
        {visible.flatMap(line => line.text.split('\n').filter((text, index, all) => index < all.length - 1 || text !== '').map((text, index) => <div className={css.logLine} key={`${line.source}/${line.seq}/${index}`} data-stream={line.stream}>
          <span>{index === 0 ? line.seq : ''}</span><time>{line.time === undefined ? '—' : new Date(line.time).toLocaleTimeString()}</time><small>{line.stream === 'stdout' ? 'OUT' : line.stream === 'stderr' ? 'ERR' : '—'}</small><code>{text || ' '}</code></div>))}
      </div>
      <footer className={css.readerFooter}><span>{notice !== null ? t(notice) : legacy ? t('legacyLogs') : row.latest?.resourcesReleased && sources.some(source => !source.complete && (sourceId === '' || source.id === sourceId)) ? t('captureIncomplete') : `${sources.length} · ${t('processLogs')}`}</span>
        {(unread > 0 || readingHistory) && <Button variant="ghost" size="sm" onClick={goLatest}>{unread > 0 ? `${t('newOutput')} · ` : ''}{t('latestOutput')}</Button>}
        <Button variant="ghost" size="sm" onClick={() => { following.current = false; setReadingHistory(true); void reader.current(true) }}>{t('logHistory')}</Button></footer>
    </div>
  </section>
}

function MetricChart({ points, label, empty, gapMs }: { points: { time: number; value?: number }[]; label: string; empty: string; gapMs: number }) {
  const values = points.flatMap(point => point.value === undefined ? [] : [point.value])
  if (values.length === 0) return <div className={css.chartEmpty}>{empty}</div>
  const start = points[0]!.time, end = points.at(-1)!.time; const max = Math.max(...values, 0.001), min = Math.min(...values, 0)
  const segments: string[][] = [[]]
  for (const [index, point] of points.entries()) {
    if (point.value === undefined) { if (segments.at(-1)!.length) segments.push([]); continue }
    if (index > 0 && point.time - points[index - 1]!.time > gapMs && segments.at(-1)!.length) segments.push([])
    segments.at(-1)!.push(`${20 + (point.time - start) / Math.max(1, end - start) * 460},${84 - (point.value - min) / Math.max(0.001, max - min) * 68}`)
  }
  return <svg viewBox="0 0 500 110" role="img" aria-label={label} preserveAspectRatio="none"><path d="M20 16H480 M20 50H480 M20 84H480" className={css.chartGrid} />
    {segments.filter(segment => segment.length > 0).map((segment, index) => segment.length === 1
      ? <circle key={index} cx={segment[0]!.split(',')[0]} cy={segment[0]!.split(',')[1]} r="2" className={css.chartCurve} />
      : <polyline key={index} points={segment.join(' ')} className={css.chartCurve} />)}
    <text x="20" y="104">{new Date(start).toLocaleTimeString()}</text><text x="480" y="104" textAnchor="end">{new Date(end).toLocaleTimeString()}</text></svg>
}
