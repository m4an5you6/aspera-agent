/** Effect-owned background synchronization survives page changes and resumes committed cursors. */
import { z } from 'zod'
import { projectAgentRecord, observationLineSchema, experimentArchiveStatusSchema, executionProgressSchema, metricSampleSchema } from '@aspera/experiments'
import type { AgentRecord, ExperimentArchiveStatus, ExperimentId, ExperimentServerId, ObservationPage, ClusterRecord } from '@aspera/experiments'
import { redactObservation } from '@aspera/runtime'
import type { FleetExperiment } from './types.ts'
import { RunArchiveStore, archiveHash } from './run-archive-store.ts'
import type { ArchiveRemoteSource, ArchiveStream } from './run-archive-store.ts'
import type { RunArchiveReader, RunArchivePolicy } from './run-archive-reader.ts'

const envelopeSchema = z.object({ sessionId: z.string(), source: z.enum(['plan', 'execution']),
  event: z.object({ seq: z.number().int().nonnegative(), time: z.number(), type: z.string(), data: z.unknown() }) })
type Pending = { bytes: Buffer; offset: number; secretTail: boolean }

function terminal(record: FleetExperiment): boolean {
  const state = record.latest ?? record.receipt
  return state !== undefined && state.resourcesReleased && ['completed', 'failed', 'cancelled', 'blocked', 'interrupted'].includes(state.state)
}

/** Remove credential values from text while preserving typed event structure and identities.
 * @param value - parsed event or saved fact. @param secrets - account-owned credentials. @returns redacted JSON data.
 */
export function redactArchiveData(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactObservation(value, secrets)
  if (Array.isArray(value)) return value.map(entry => redactArchiveData(entry, secrets))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, /^(?:extra)?headers$/i.test(key) ? { redacted: true } : redactArchiveData(entry, secrets)]))
  return value
}

function utf8End(bytes: Buffer, end: number): number {
  if (end === 0) return 0
  let lead = end - 1
  while (lead > 0 && (bytes[lead]! & 0xc0) === 0x80) lead--
  const first = bytes[lead]!
  const width = first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1
  return lead + width > end ? lead : end
}

/** Archive ownership and credentials are supplied by the management Host. */
export interface RunArchiveOwner {
  list(): FleetExperiment[]
  get(id: ExperimentId): FleetExperiment
  alive(id: ExperimentId): boolean
  secrets(record: FleetExperiment): Promise<string[]>
  observe(id: ExperimentId, record: ClusterRecord): Promise<void>
}

/** One background task per experiment and serialized read operations per assigned server. */
export class RunArchives {
  private readonly stores = new Map<ExperimentId, RunArchiveStore>()
  private readonly jobs = new Map<ExperimentId, { abort: AbortController; done: Promise<void> }>()
  private readonly serverChains = new Map<ExperimentServerId, Promise<void>>()
  private readonly next = new Map<ExperimentId, { time: number; delay: number }>()
  private readonly scheduled = new Map<ExperimentId, ReturnType<typeof setTimeout>>()
  private readonly finalizing = new Set<ExperimentId>()
  private readonly finalRead = new Set<ExperimentId>()
  private readonly pending = new Map<string, Pending>()
  private readonly failures = new Map<ExperimentId, { error: string; state: 'paused' | 'disconnected' }>()
  private timer: ReturnType<typeof setInterval> | undefined
  private closed = false
  constructor(private readonly root: string, private readonly owner: RunArchiveOwner,
    private readonly reader: Pick<RunArchiveReader, 'catalog' | 'bytes' | 'trace' | 'observation' | 'pipe'>,
    private readonly policy: RunArchivePolicy) {}

  /** Start profile-owned synchronization without a browser subscriber. */
  start(): void {
    if (!this.policy.archiveEnabled || this.closed || this.timer !== undefined) return
    this.timer = setInterval(() => this.sweep(), this.policy.archiveIntervalMs); this.timer.unref()
    this.sweep()
  }
  private sweep(): void {
    if (this.closed) return
    for (const record of this.owner.list()) {
      const id = record.request.experimentId
      if (record.submission?.protocol !== 4 || record.receipt === undefined || !this.owner.alive(id)
        || this.jobs.has(id) || (this.next.get(id)?.time ?? 0) > Date.now()) continue
      this.request(id)
    }
  }
  private schedule(id: ExperimentId): void {
    const previous = this.scheduled.get(id)
    if (previous !== undefined) { clearTimeout(previous); this.scheduled.delete(id) }
    const time = this.next.get(id)?.time
    if (this.closed || this.timer === undefined || time === undefined || !Number.isFinite(time)) return
    const timer = setTimeout(() => { this.scheduled.delete(id); if (this.owner.alive(id)) this.request(id) }, Math.max(0, time - Date.now()))
    timer.unref(); this.scheduled.set(id, timer)
  }
  /** Request a final round on the first observed terminal resource release, coalescing an active read.
   * @param id - retained experiment whose remote state was updated.
   */
  changed(id: ExperimentId): void {
    if (!terminal(this.owner.get(id)) || this.finalizing.has(id)) return
    this.finalizing.add(id)
    if (this.jobs.has(id)) this.finalRead.add(id)
    else this.request(id)
  }
  /** @param id - retained experiment. @returns durable copied data without submitting or resuming remote work. */
  store(id: ExperimentId): RunArchiveStore | undefined {
    const record = this.owner.get(id)
    if (record.submission?.protocol !== 4 || record.receipt === undefined) return undefined
    let store = this.stores.get(id)
    if (store === undefined) {
      store = new RunArchiveStore(this.root, id, archiveHash(record.submission), this.policy.archiveMinimumFreeBytes)
      this.stores.set(id, store)
    }
    return store
  }
  /** @param id - owning experiment. @returns saved availability and current synchronization failures. */
  status(id: ExperimentId): ExperimentArchiveStatus {
    let status: ExperimentArchiveStatus
    try { status = this.store(id)?.status() ?? experimentArchiveStatusSchema.parse({ version: 1, experimentId: id, state: 'idle',
      runtimeAvailable: false, savedBytes: 0, complete: false, sources: [], gaps: [] }) }
    catch (error) { status = experimentArchiveStatusSchema.parse({ version: 1, experimentId: id, state: 'paused', runtimeAvailable: false,
      savedBytes: 0, complete: false, sources: [], gaps: [], error: redactObservation(String(error)) }) }
    const failure = this.failures.get(id)
    return failure === undefined ? status : { ...status, state: failure.state,
      runtimeAvailable: failure.state === 'paused' && status.runtimeAvailable, error: failure.error }
  }
  /** @param id - owning experiment. @returns current status after scheduling an immediate read-only retry. */
  request(id: ExperimentId): ExperimentArchiveStatus {
    this.owner.get(id)
    if (this.closed || !this.policy.archiveEnabled || this.jobs.has(id)) return this.status(id)
    const abort = new AbortController()
    const previous = this.scheduled.get(id)
    if (previous !== undefined) { clearTimeout(previous); this.scheduled.delete(id) }
    const done = Promise.resolve().then(() => this.sync(id, abort.signal)).finally(() => {
      this.jobs.delete(id)
      if (this.finalRead.delete(id) && !this.failures.has(id)) this.next.set(id, { time: Date.now(), delay: this.policy.archiveRetryMinMs })
      this.schedule(id)
    })
    this.jobs.set(id, { abort, done })
    return this.status(id)
  }
  private async onServer(serverId: ExperimentServerId, signal: AbortSignal, action: () => Promise<void>): Promise<void> {
    const previous = this.serverChains.get(serverId) ?? Promise.resolve()
    const work = previous.then(async () => { signal.throwIfAborted(); await action() })
    const settled = work.then(() => {}, () => {})
    this.serverChains.set(serverId, settled)
    try { await work } finally { if (this.serverChains.get(serverId) === settled) this.serverChains.delete(serverId) }
  }
  private check(id: ExperimentId, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (this.closed || !this.owner.alive(id)) throw new Error('Archive experiment was removed or its owner stopped')
  }
  private async sync(id: ExperimentId, signal: AbortSignal): Promise<void> {
    let secrets: string[] = []
    try {
      this.check(id, signal)
      const record = this.owner.get(id); const store = this.store(id)
      if (store === undefined) return
      const finalAtStart = terminal(record)
      if (finalAtStart) this.finalizing.add(id)
      secrets = await this.owner.secrets(record)
      this.check(id, signal); store.attempt(Date.now())
      const outcomes = await Promise.allSettled(record.servers.map(server => this.onServer(server.id, signal, async () => {
        const lastMetric = store.lastMetric(server.id)
        const { catalog, runtimeAvailable } = await this.reader.catalog(record, server.id, lastMetric, signal)
        this.check(id, signal)
        if (catalog.record !== undefined) { await this.owner.observe(id, catalog.record); this.check(id, signal) }
        catalog.processes = catalog.processes.map(row => ({ ...row, command: redactObservation(row.command, secrets),
          ...(row.detail === undefined ? {} : { detail: redactObservation(row.detail, secrets) }) }))
        catalog.metrics = catalog.metrics.map(sample => metricSampleSchema.parse(redactArchiveData(sample, secrets)))
        if (catalog.progress !== undefined) catalog.progress = executionProgressSchema.parse(redactArchiveData(catalog.progress, secrets))
        if (lastMetric === undefined && catalog.metrics.length > 0 && (catalog.record?.startedAt ?? record.latest?.startedAt ?? Date.now()) < Math.min(...catalog.metrics.map(sample => sample.time)) - this.policy.archiveMetricGapMs) {
          store.gap('Earlier metric samples are unavailable; only the retained remote window was recovered')
        }
        if (lastMetric !== undefined && catalog.metrics.length > 0 && Math.min(...catalog.metrics.map(sample => sample.time)) - lastMetric > this.policy.archiveMetricGapMs) {
          store.gap('No retained metric samples cover the interval between the saved and recovered windows')
        }
        store.facts(catalog, server.id, runtimeAvailable)
        if (server.id === record.coordinator.id && (catalog.record?.sessionId !== undefined || catalog.record?.planningSessionId !== undefined)
          && !catalog.sources.some(source => source.kind === 'trace')) store.gap('Agent events are missing for a saved Session')
        for (const source of catalog.sources) {
          this.check(id, signal)
          const stream = store.source(server.id, { ...source, path: redactObservation(source.path, secrets),
            ...(source.label === undefined ? {} : { label: redactObservation(source.label, secrets) }),
            ...(source.source === undefined ? {} : { source: { ...source.source, label: redactObservation(source.source.label, secrets) } }) })
          if (stream.caughtUp && stream.observedSize === source.size) continue
          if (runtimeAvailable && source.kind === 'trace') {
            let used = false
            for (let pageNumber = 0; pageNumber < this.policy.archiveBatchPages; pageNumber++) {
              const page = await this.reader.trace(record, stream, signal)
              if (page === undefined) break
              if (page.missing) throw new Error('Remote trace source disappeared')
              this.check(id, signal)
              const rows = page.records.map(row => ({ ...row, data: JSON.stringify(redactArchiveData(JSON.parse(row.data), secrets)) }))
              store.commit(stream, rows, stream.remoteOffset, !page.hasMore, Date.now()); used = true
              if (!page.hasMore) break
              if (page.records.length === 0) throw new Error('Archive trace read made no progress')
            }
            if (used) continue
          }
          if (runtimeAvailable && source.format === 'observations') {
            let used = false
            for (let pageNumber = 0; pageNumber < this.policy.archiveBatchPages; pageNumber++) {
              const page = await this.reader.observation(record, stream, signal)
              if (page === undefined) break
              if (page.reset || page.cursor.generation !== source.generation) throw new Error('Archive source generation changed')
              this.check(id, signal)
              const previousOffset = stream.remoteOffset
              store.commit(stream, page.lines.map(row => ({ ...row, text: redactObservation(row.text, secrets) })), page.cursor.offset, !page.hasMore, Date.now()); used = true
              if (!page.hasMore) break
              if (page.lines.length === 0 && page.cursor.offset === previousOffset) throw new Error('Archive observation read made no progress')
            }
            if (used) continue
          }
          await this.copyBytes(record, server.id, source, stream, store, secrets, signal, runtimeAvailable)
        }
      })))
      const failure = outcomes.find(outcome => outcome.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      this.check(id, signal)
      const caughtUp = store.caughtUp()
      store.health(caughtUp ? 'caught-up' : 'syncing', Date.now())
      this.failures.delete(id)
      const current = this.owner.get(id)
      const waiting = ['awaiting-approval', 'waiting-reply'].includes((current.latest ?? current.receipt)?.state ?? '')
      const interval = !finalAtStart && terminal(current) ? 0 : !caughtUp ? this.policy.archiveBacklogIntervalMs
        : waiting ? this.policy.archiveWaitingIntervalMs : this.policy.archiveIntervalMs
      this.next.set(id, { time: finalAtStart && store.settled(record.servers.map(server => server.id)) ? Infinity : Date.now() + interval,
        delay: this.policy.archiveRetryMinMs })
    } catch (error) {
      if (signal.aborted || !this.owner.alive(id) || this.closed) return
      const diagnostic = redactObservation(String(error), secrets)
      const state = /disk|ENOSPC|EACCES|EPERM|integrity|local archive|ownership|another experiment|another.*Session/i.test(diagnostic) ? 'paused' : 'disconnected'
      this.failures.set(id, { error: diagnostic, state })
      try { this.stores.get(id)?.health(state, Date.now(), diagnostic) }
      catch (saveError) { this.failures.set(id, { error: diagnostic + '; ' + redactObservation(String(saveError), secrets), state: 'paused' }) }
      for (const key of this.pending.keys()) if (key.startsWith(id + '/')) this.pending.delete(key)
      const retry = this.next.get(id)?.delay ?? this.policy.archiveRetryMinMs
      this.next.set(id, { time: Date.now() + retry, delay: Math.min(this.policy.archiveRetryMaxMs, retry * 2) })
    }
  }

  private async copyBytes(record: FleetExperiment, serverId: ExperimentServerId, source: ArchiveRemoteSource, stream: ArchiveStream,
    store: RunArchiveStore, secrets: readonly string[], signal: AbortSignal, runtimeAvailable: boolean): Promise<void> {
    const id = record.request.experimentId; const key = id + '/' + stream.key
    let pending = this.pending.get(key)
    if (pending === undefined) { pending = { bytes: Buffer.alloc(0), offset: stream.remoteOffset, secretTail: false }; this.pending.set(key, pending) }
    for (let pageNumber = 0; pageNumber < this.policy.archiveBatchPages; pageNumber++) {
      const api = runtimeAvailable && source.kind === 'process-log' ? await this.reader.pipe(record, { ...stream, remoteOffset: pending.offset }, signal) : undefined
      const chunk = api ?? await this.reader.bytes(record, serverId, source, pending.offset, signal)
      if (chunk.offset !== pending.offset || chunk.nextOffset !== pending.offset + Buffer.from(chunk.data, 'base64').length) throw new Error('Archive pipe response did not match its cursor')
      this.check(id, signal)
      let incoming = Buffer.from(chunk.data, 'base64')
      if (pending.secretTail) {
        const text = incoming.toString('latin1'); const end = text.search(/[\s,"'};]/)
        incoming.fill(42, 0, end < 0 ? incoming.length : end)
        if (end >= 0) pending.secretTail = false
      }
      pending.bytes = Buffer.concat([pending.bytes, incoming]); pending.offset = chunk.nextOffset
      const rows: (AgentRecord | ObservationPage['lines'][number])[] = []
      let consumed = 0
      if (source.format === 'text') {
        const text = pending.bytes.toString('latin1')
        const tail = Math.max(4096, ...secrets.map(secret => Buffer.byteLength(secret)))
        consumed = utf8End(pending.bytes, chunk.eof ? pending.bytes.length : Math.max(0, pending.bytes.length - tail))
        if (consumed > 0) {
          if (/(?:authorization|api[_-]?key|password|(?:access[_-]?)?token|secret)\s*["']?\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+)?[^\s,"'};]+$/i.test(text) && !chunk.eof) pending.secretTail = true
          pending.bytes = Buffer.from(redactObservation(text, secrets.map(secret => Buffer.from(secret).toString('latin1')), true), 'latin1')
          rows.push({ seq: stream.remoteOffset, stream: source.stream ?? 'mixed', text: pending.bytes.subarray(0, consumed).toString('utf8') })
        }
      } else {
        consumed = pending.bytes.lastIndexOf(10) + 1
        if (consumed > 0) {
          const text = new TextDecoder('utf-8', { fatal: true }).decode(pending.bytes.subarray(0, consumed))
          for (const line of text.split('\n').filter(Boolean)) {
            const value: unknown = JSON.parse(line)
            if (source.format === 'observations') { const row = observationLineSchema.parse(value); rows.push({ ...row, text: redactObservation(row.text, secrets) }) }
            else {
              const envelope = envelopeSchema.parse(value)
              const phase = envelope.source === 'plan' ? 'planning' : 'execution'
              if (phase !== source.phase) continue
              if (envelope.sessionId !== source.sessionId) throw new Error('Archive event belongs to another Session')
              rows.push(projectAgentRecord({ ...envelope.event, data: redactArchiveData(envelope.event.data, secrets) },
                { experimentId: id, phase, sessionId: envelope.sessionId }, Infinity))
            }
          }
        }
      }
      const nextOffset = stream.remoteOffset + consumed
      const caughtUp = chunk.eof && consumed === pending.bytes.length
      store.commit(stream, rows, nextOffset, caughtUp, Date.now())
      pending.bytes = pending.bytes.subarray(consumed)
      if (caughtUp) { this.pending.delete(key); break }
      if (chunk.eof || incoming.length === 0) break
    }
  }
  /** Stop one writer and await all its reads before deleting the experiment-owned directory.
   * @param id - removed experiment.
   */
  async stop(id: ExperimentId): Promise<void> {
    const timer = this.scheduled.get(id)
    if (timer !== undefined) { clearTimeout(timer); this.scheduled.delete(id) }
    const job = this.jobs.get(id); job?.abort.abort(new Error('local archive stopped'))
    await job?.done
    this.stores.delete(id); this.next.delete(id); this.failures.delete(id)
    this.finalizing.delete(id); this.finalRead.delete(id)
    const rescheduled = this.scheduled.get(id)
    if (rescheduled !== undefined) { clearTimeout(rescheduled); this.scheduled.delete(id) }
    for (const key of this.pending.keys()) if (key.startsWith(id + '/')) this.pending.delete(key)
  }
  /** Stop callbacks, await owned reads, and leave remote training independent. */
  async close(): Promise<void> {
    this.closed = true
    if (this.timer !== undefined) clearInterval(this.timer)
    for (const timer of this.scheduled.values()) clearTimeout(timer)
    this.scheduled.clear()
    for (const job of this.jobs.values()) job.abort.abort(new Error('local archive owner closed'))
    await Promise.all([...this.jobs.values()].map(job => job.done))
    this.pending.clear()
  }
  /** @param id - experiment. @returns after its current synchronization attempt ends. */
  async settled(id: ExperimentId): Promise<void> { await this.jobs.get(id)?.done }
}
