/** Durable local copies use immutable blocks and an atomically replaced version-1 index. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { z } from 'zod'
import { agentRecordSchema, agentRecordRequestSchema, observationLineSchema, observationReadSchema, observationSourceSchema,
  observationSourceIdSchema, metricSampleSchema, metricReadSchema, experimentProcessSchema, executionProgressReadSchema,
  experimentIdSchema, serverIdSchema, experimentArchiveStatusSchema, clusterRecordSchema, processLogRequestSchema } from '@aspera/experiments'
import type { AgentRecord, AgentRecordRequest, AgentRecordPage, ObservationSource, ObservationRead, ObservationPage,
  MetricSample, MetricRead, ExperimentProcess, ExecutionProgressRead, ExperimentArchiveStatus, ExperimentId, ExperimentServerId,
  ProcessLogRequest, ProcessLogPage } from '@aspera/experiments'

/** Program-verified physical source returned by the read-only helper. */
export const archiveRemoteSourceSchema = z.object({ id: observationSourceIdSchema, path: z.string(),
  kind: z.enum(['trace', 'log', 'process-log']), format: z.enum(['events', 'observations', 'text']),
  generation: z.string(), size: z.number().int().nonnegative(), modifiedAt: z.number(), label: z.string().optional(),
  phase: z.enum(['planning', 'execution']).optional(), sessionId: z.string().optional(),
  commandId: z.string().optional(), stream: z.enum(['stdout', 'stderr', 'mixed']).optional(), source: observationSourceSchema.optional(),
}).strict()
/** Existing saved facts are parsed before they may enter a local copy. */
export const archiveCatalogSchema = z.object({ sources: z.array(archiveRemoteSourceSchema), processes: z.array(experimentProcessSchema),
  metrics: z.array(metricSampleSchema), record: clusterRecordSchema.optional(),
  progress: executionProgressReadSchema.shape.progress.optional(), stepSupported: z.boolean().optional(), truncated: z.boolean(),
}).strict()
/** One source declaration, including its original physical identity. */
export type ArchiveRemoteSource = z.infer<typeof archiveRemoteSourceSchema>
/** Bounded read-only catalog. */
export type ArchiveCatalog = z.infer<typeof archiveCatalogSchema>

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const frameSchema = z.object({ hash: hashSchema, first: z.number(), last: z.number(), start: z.number().int(), end: z.number().int() }).strict()
const metricFrameSchema = z.object({ hash: hashSchema, serverId: serverIdSchema, firstAt: z.number(), lastAt: z.number() }).strict()
const streamSchema = archiveRemoteSourceSchema.extend({ key: hashSchema, serverId: serverIdSchema,
  physicalGeneration: z.string(),
  publicId: observationSourceIdSchema, remoteOffset: z.number().int().nonnegative(), observedSize: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(), frames: z.array(frameSchema), lastSeq: z.number().optional(),
  lastSyncedAt: z.number().optional(), caughtUp: z.boolean(), complete: z.boolean(), superseded: z.boolean(), gaps: z.array(z.string()),
}).strict()
const manifestSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, submissionHash: hashSchema,
  streams: z.array(streamSchema), metricFrames: z.array(metricFrameSchema),
  processes: z.array(experimentProcessSchema), progress: executionProgressReadSchema.optional(),
  knownNodes: z.array(serverIdSchema),
  lastAttemptAt: z.number().optional(), lastSyncedAt: z.number().optional(), lastRemoteStateAt: z.number().optional(),
  runtimeAvailable: z.boolean(), terminal: z.boolean(), state: experimentArchiveStatusSchema.shape.state,
  error: z.string().optional(), gaps: z.array(z.string()),
}).strict()
type Manifest = z.infer<typeof manifestSchema>
/** Private source index; remote byte positions never become browser pagination positions. */
export type ArchiveStream = z.infer<typeof streamSchema>

/** @param value - JSON-compatible owned data. @returns stable block identity. */
export function archiveHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/** One experiment's immutable data blocks and durable continuation index. */
export class RunArchiveStore {
  private readonly directory: string
  private manifest: Manifest
  private committed: Manifest
  private metricKeys: Set<string> | undefined
  constructor(root: string, id: ExperimentId, submissionHash: string, private readonly minimumFreeBytes: number,
    private readonly capacity: (path: string) => number = path => { const stats = statfsSync(path); return stats.bavail * stats.bsize }) {
    this.directory = resolve(root, id)
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.checkPath(root)
    if (existsSync(this.directory)) this.checkPath(this.directory)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = this.path('manifest.v1.json')
    this.manifest = existsSync(path) ? manifestSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : {
      version: 1, experimentId: id, submissionHash, streams: [], metricFrames: [], processes: [], knownNodes: [],
      runtimeAvailable: false, terminal: false, state: 'idle', gaps: [],
    }
    if (this.manifest.experimentId !== id || this.manifest.submissionHash !== submissionHash) throw new Error('Local archive belongs to another experiment or submission')
    this.verifyIndex()
    this.committed = structuredClone(this.manifest)
    this.manifest.runtimeAvailable = false
  }

  private checkPath(path: string): void {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Local archive cannot contain symbolic links')
    if (path !== this.directory && path.startsWith(this.directory + sep) && !realpathSync(path).startsWith(realpathSync(this.directory) + sep)) throw new Error('Local archive path is outside its experiment')
  }
  private path(name: string): string {
    if (!/^(?:manifest\.v1\.json|[a-f0-9]{64}\.json)$/.test(name)) throw new Error('Invalid local archive filename')
    const path = resolve(this.directory, name)
    if (existsSync(path)) this.checkPath(path)
    return path
  }
  private atomic(name: string, text: string): void {
    if (this.capacity(this.directory) - Buffer.byteLength(text) < this.minimumFreeBytes) throw new Error('Local archive disk reserve is insufficient; synchronization paused')
    const target = this.path(name); const incoming = resolve(this.directory, `.${randomUUID()}.incoming`)
    try {
      const fd = openSync(incoming, 'wx', 0o600)
      try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
      renameSync(incoming, target)
    } catch (error) {
      if (existsSync(incoming)) unlinkSync(incoming)
      throw error
    }
  }
  private save(): void {
    try {
      this.atomic('manifest.v1.json', JSON.stringify(manifestSchema.parse(this.manifest)) + '\n')
      this.committed = structuredClone(this.manifest)
    } catch (error) { this.manifest = structuredClone(this.committed); this.metricKeys = undefined; throw error }
  }
  private block(rows: readonly unknown[]): string {
    const hash = archiveHash(rows); const path = this.path(hash + '.json')
    if (!existsSync(path)) this.atomic(hash + '.json', JSON.stringify(rows) + '\n')
    else this.readBlock(hash)
    return hash
  }
  private readBlock(hash: string): unknown {
    const value: unknown = JSON.parse(readFileSync(this.path(hash + '.json'), 'utf8'))
    if (archiveHash(value) !== hash) throw new Error('Local archive block failed integrity verification')
    return value
  }
  private verifyIndex(): void {
    for (const stream of this.manifest.streams) {
      if (stream.key !== archiveHash([stream.serverId, stream.id, stream.generation, stream.phase, stream.sessionId])) throw new Error('Local archive source identity differs')
      let offset = 0
      for (const frame of stream.frames) {
        if (frame.start !== offset || frame.end < frame.start || !existsSync(this.path(frame.hash + '.json'))) throw new Error('Local archive has a missing committed interval')
        offset = frame.end
      }
      if (offset !== stream.bytes) throw new Error('Local archive index does not match its committed bytes')
    }
  }

  /** @param serverId - owned node. @param source - physical source declaration. @returns durable source generation. */
  source(serverId: ExperimentServerId, source: ArchiveRemoteSource): ArchiveStream {
    let stream = this.manifest.streams.findLast(stream => stream.serverId === serverId && stream.id === source.id
      && stream.physicalGeneration === source.generation && stream.sessionId === source.sessionId && !stream.superseded)
    const truncated = stream !== undefined && source.size < Math.max(stream.remoteOffset, stream.observedSize)
    const rewritten = stream !== undefined && source.size === stream.size && source.modifiedAt !== stream.modifiedAt
    if (truncated || rewritten) stream = undefined
    const generation = truncated || rewritten ? source.generation + `/changed/${source.modifiedAt}/${source.size}` : source.generation
    const key = archiveHash([serverId, source.id, generation, source.phase, source.sessionId])
    if (stream === undefined) {
      const old = this.manifest.streams.filter(stream => stream.serverId === serverId && stream.id === source.id && !stream.superseded)
      for (const prior of old) { prior.superseded = true; prior.gaps.push('Source generation changed; earlier bytes remain in a separate copy') }
      stream = { ...source, generation, physicalGeneration: source.generation, serverId, key, publicId: observationSourceIdSchema.parse(source.id.slice(0, 100) + '-' + key.slice(0, 12)),
        remoteOffset: 0, observedSize: 0, bytes: 0, frames: [], caughtUp: false, complete: false, superseded: false, gaps: [] }
      this.manifest.streams.push(stream)
    }
    stream.size = source.size; stream.modifiedAt = source.modifiedAt; stream.source = source.source
    stream.complete = stream.caughtUp && (source.source === undefined ? this.manifest.terminal : source.source.complete)
    return stream
  }

  /** Commit only complete verified records before advancing their remote continuation.
   * @param stream - owned index entry. @param rows - complete events or text rows. @param remoteOffset - consumed remote bytes.
   * @param caughtUp - complete current source tail was read. @param now - successful read time.
   */
  commit(stream: ArchiveStream, rows: readonly (AgentRecord | ObservationPage['lines'][number])[], remoteOffset: number, caughtUp: boolean, now: number): void {
    if (!this.manifest.streams.includes(stream)) throw new Error('Archive stream is not owned by this writer')
    const unique = new Map<number, AgentRecord | ObservationPage['lines'][number]>()
    for (const row of rows) {
      const previous = unique.get(row.seq)
      if (previous !== undefined && archiveHash(previous) !== archiveHash(row)) throw new Error('Archive repeated sequence has conflicting content')
      unique.set(row.seq, row)
    }
    const accepted = [...unique.values()].filter(row => stream.lastSeq === undefined || row.seq > stream.lastSeq).sort((a, b) => a.seq - b.seq)
    if (accepted.length > 0) {
      const encoded = accepted.map(row => JSON.stringify(row) + '\n'); const size = encoded.reduce((sum, row) => sum + Buffer.byteLength(row), 0)
      const hash = this.block(accepted)
      stream.frames.push({ hash, first: accepted[0]!.seq, last: accepted.at(-1)!.seq, start: stream.bytes, end: stream.bytes + size })
      stream.bytes += size; stream.lastSeq = accepted.at(-1)!.seq
    }
    stream.remoteOffset = remoteOffset; stream.observedSize = stream.size; stream.caughtUp = caughtUp
    stream.lastSyncedAt = now; stream.complete = caughtUp && (stream.source === undefined ? this.manifest.terminal : stream.source.complete)
    this.save()
  }

  /** @param catalog - validated saved facts. @param serverId - owned node. @param runtimeAvailable - authenticated live status was read. */
  facts(catalog: ArchiveCatalog, serverId: ExperimentServerId, runtimeAvailable: boolean): void {
    for (const row of catalog.processes) if (row.experimentId !== this.manifest.experimentId || row.serverId !== serverId) throw new Error('Archived command belongs to another experiment or node')
    for (const row of catalog.metrics) if (row.experimentId !== this.manifest.experimentId || row.serverId !== serverId) throw new Error('Archived metric belongs to another experiment or node')
    if (catalog.record !== undefined && archiveHash(catalog.record.submission) !== this.manifest.submissionHash) throw new Error('Archived status belongs to another submission')
    if (catalog.progress !== undefined && catalog.progress.experimentId !== this.manifest.experimentId) throw new Error('Archived steps belong to another experiment')
    this.manifest.processes = [...this.manifest.processes.filter(row => row.serverId !== serverId), ...catalog.processes]
    if (!this.manifest.knownNodes.includes(serverId)) this.manifest.knownNodes.push(serverId)
    if (catalog.record !== undefined) {
      this.manifest.lastRemoteStateAt = catalog.record.updatedAt
      this.manifest.terminal = ['completed', 'failed', 'cancelled', 'blocked', 'interrupted'].includes(catalog.record.state) && catalog.record.resourcesReleased
      this.manifest.runtimeAvailable = runtimeAvailable
    }
    if (catalog.stepSupported === false) this.manifest.progress = { supported: false }
    else if (catalog.progress !== undefined) this.manifest.progress = { supported: true, progress: catalog.progress }
    else if (catalog.record !== undefined && this.manifest.progress === undefined) this.manifest.progress = { supported: true }
    if (catalog.truncated && !this.manifest.gaps.includes('Source discovery exceeded its configured limit')) this.manifest.gaps.push('Source discovery exceeded its configured limit')
    const keys = new Set(this.metricKeys ?? this.manifest.metricFrames.flatMap(frame =>
      z.array(metricSampleSchema).parse(this.readBlock(frame.hash)).map(sample => archiveHash(sample))))
    const samples = catalog.metrics.filter(sample => {
      if (sample.experimentId !== this.manifest.experimentId || sample.serverId !== serverId) throw new Error('Archived metric belongs to another experiment or node')
      const key = archiveHash(sample); if (keys.has(key)) return false; keys.add(key); return true
    })
    if (samples.length > 0) this.manifest.metricFrames.push({ hash: this.block(samples), serverId,
      firstAt: Math.min(...samples.map(sample => sample.time)), lastAt: Math.max(...samples.map(sample => sample.time)) })
    this.save()
    this.metricKeys = keys
  }

  /** @param now - attempt start time; the previous result remains visible during background reads. */
  attempt(now: number): void { this.manifest.lastAttemptAt = now; this.save() }
  /** @param state - synchronization result. @param now - round completion time. @param error - already redacted diagnostic. */
  health(state: Manifest['state'], now: number, error?: string): void {
    this.manifest.state = state; this.manifest.lastAttemptAt = now
    if (state === 'caught-up' || state === 'syncing') this.manifest.lastSyncedAt = now
    if (error === undefined) delete this.manifest.error; else this.manifest.error = error
    if (state === 'disconnected') this.manifest.runtimeAvailable = false
    this.save()
  }
  /** @param detail - recorded missing interval, never fabricated samples. */
  gap(detail: string): void { if (!this.manifest.gaps.includes(detail)) { this.manifest.gaps.push(detail); this.save() } }
  /** @returns whether every current source reached its observed tail, including event APIs without byte cursors. */
  caughtUp(): boolean { return this.manifest.streams.every(stream => stream.superseded || stream.caughtUp && stream.observedSize === stream.size) }
  /** @param nodes - assigned nodes. @returns whether final reads can stop; historical gaps do not become complete history. */
  settled(nodes: readonly ExperimentServerId[]): boolean {
    return this.manifest.terminal && nodes.every(id => this.hasFacts(id)) && this.caughtUp()
      && this.manifest.processes.every(process => process.released && ['completed', 'failed', 'cancelled', 'interrupted'].includes(process.state))
  }
  /** @returns committed copy health, including physical generations. */
  status(): ExperimentArchiveStatus {
    const { manifest: m } = this
    const sources = m.streams.map(stream => ({ id: stream.publicId, serverId: stream.serverId, label: stream.label ?? stream.id,
      kind: stream.kind, ...(stream.phase === undefined ? {} : { phase: stream.phase }),
      state: m.state === 'disconnected' || m.state === 'paused' ? m.state : stream.gaps.length > 0 ? 'incomplete' as const : stream.caughtUp ? 'caught-up' as const : 'syncing' as const,
      savedBytes: stream.bytes, pendingBytes: stream.caughtUp || stream.superseded ? 0 : Math.max(0, stream.size - stream.remoteOffset),
      lastSyncedAt: stream.lastSyncedAt, sourceUpdatedAt: stream.modifiedAt, complete: stream.complete, gaps: stream.gaps }))
    const incomplete = m.gaps.length > 0 || sources.some(source => source.gaps.length > 0)
    return experimentArchiveStatusSchema.parse({ version: 1, experimentId: m.experimentId,
      state: m.state === 'caught-up' && incomplete ? 'incomplete' : m.state, lastAttemptAt: m.lastAttemptAt,
      lastSyncedAt: m.lastSyncedAt, lastRemoteStateAt: m.lastRemoteStateAt, runtimeAvailable: m.runtimeAvailable,
      savedBytes: sources.reduce((sum, source) => sum + source.savedBytes, 0), complete: m.state === 'caught-up' && m.terminal && !incomplete
        && m.processes.every(process => process.released && ['completed', 'failed', 'cancelled', 'interrupted'].includes(process.state))
        && sources.every(source => source.complete),
      sources, gaps: m.gaps, error: m.error })
  }
  /** @param serverId - node. @returns last saved sample time, preserving equal-time resource and training records. */
  lastMetric(serverId: ExperimentServerId): number | undefined {
    const frames = this.manifest.metricFrames.filter(frame => frame.serverId === serverId)
    return frames.length === 0 ? undefined : Math.max(...frames.map(frame => frame.lastAt))
  }
  /** @param serverId - owned node. @returns saved process metadata. */
  processes(serverId: ExperimentServerId): ExperimentProcess[] { return this.manifest.processes.filter(row => row.serverId === serverId) }
  /** @param serverId - assigned node. @returns whether this node's saved facts have been read successfully. */
  hasFacts(serverId: ExperimentServerId): boolean { return this.manifest.knownNodes.includes(serverId) }
  /** @returns last validated step report, or no synchronized report. */
  progress(): ExecutionProgressRead | undefined { return this.manifest.progress }
  /** @param phase - requested remote Session role. @returns whether its current file tail has been copied completely. */
  traceCaughtUp(phase: 'preparation' | 'planning' | 'execution'): boolean {
    return this.manifest.streams.findLast(stream => stream.kind === 'trace' && stream.phase === phase && !stream.superseded)?.caughtUp ?? false
  }
  /** @param raw - source-bound request. @returns measured retained samples only. */
  metrics(raw: MetricRead): MetricSample[] {
    const input = metricReadSchema.parse(raw)
    return this.manifest.metricFrames.filter(frame => frame.serverId === input.serverId && (input.after === undefined || frame.lastAt > input.after)
      && (input.before === undefined || frame.firstAt < input.before)).slice(-input.limit)
      .flatMap(frame => z.array(metricSampleSchema).parse(this.readBlock(frame.hash)))
      .filter(sample => sample.serverId === input.serverId && (input.after === undefined || sample.time > input.after) && (input.before === undefined || sample.time < input.before))
      .sort((a, b) => a.time - b.time).slice(-input.limit)
  }
  /** @param serverId - owned node. @returns saved logs, including preserved earlier generations. */
  logSources(serverId: ExperimentServerId): ObservationSource[] {
    return this.manifest.streams.filter(stream => stream.serverId === serverId && stream.kind === 'log')
      .sort((a, b) => Number(a.superseded) - Number(b.superseded)).map(stream => observationSourceSchema.parse({
        ...(stream.source ?? { version: 1, experimentId: this.manifest.experimentId, serverId, kind: 'legacy', label: stream.label ?? stream.id,
          createdAt: stream.modifiedAt, streams: [stream.stream ?? 'mixed'], ...(stream.phase === undefined ? {} : { phase: stream.phase }) }),
        id: stream.publicId, complete: stream.complete, label: (stream.label ?? stream.id) + (stream.superseded ? ` [${stream.generation}]` : ''),
      }))
  }
  /** @param raw - phase and pagination. @returns saved complete Session events, or undefined before this phase is discovered. */
  records(raw: AgentRecordRequest): AgentRecordPage | undefined {
    const input = agentRecordRequestSchema.parse(raw)
    const stream = this.manifest.streams.findLast(stream => stream.kind === 'trace' && stream.phase === input.phase && !stream.superseded)
    if (stream === undefined) return undefined
    if (input.cursor !== undefined && (input.cursor.experimentId !== input.experimentId || input.cursor.phase !== input.phase || input.cursor.sessionId !== stream.sessionId)) throw new Error('Archive cursor belongs to another experiment, phase or Session')
    const generation = stream.generation
    const reset = input.cursor?.generation !== undefined && input.cursor.generation !== generation
    const first = reset ? 0 : input.cursor?.nextSeq
    const frames = stream.frames.filter(frame => (first === undefined || frame.last >= first) && (input.beforeSeq === undefined || frame.first < input.beforeSeq))
    const selected = first === undefined ? frames.slice(-input.limit) : frames.slice(0, input.limit)
    const available = selected.flatMap(frame => z.array(agentRecordSchema).parse(this.readBlock(frame.hash)))
      .filter(row => (first === undefined || row.seq >= first) && (input.beforeSeq === undefined || row.seq < input.beforeSeq))
    const rows = first === undefined ? available.slice(-input.limit) : available.slice(0, input.limit)
    return { records: rows, cursor: { experimentId: input.experimentId, phase: input.phase, sessionId: stream.sessionId!, generation,
      nextSeq: (rows.at(-1)?.seq ?? (first ?? 0) - 1) + 1 }, hasMore: first === undefined ? (rows[0]?.seq ?? 0) > 0 : available.length > rows.length || selected.length < frames.length,
      missing: false, reset }
  }
  /** @param raw - selected saved generation. @returns bounded local pagination independent of remote offsets. */
  log(raw: ObservationRead): ObservationPage | undefined {
    const input = observationReadSchema.parse(raw)
    const stream = this.manifest.streams.find(stream => stream.publicId === input.sourceId && stream.serverId === input.serverId && stream.kind === 'log')
    if (stream === undefined) return undefined
    const previous = input.cursor ?? input.before
    if (previous !== undefined && (previous.experimentId !== input.experimentId || previous.serverId !== input.serverId || previous.sourceId !== input.sourceId || previous.stream !== input.stream)) throw new Error('Archive log cursor belongs to another source')
    const generation = 'archive-v1-' + stream.key
    const reset = previous !== undefined && (previous.generation !== generation || previous.offset > stream.bytes)
    const end = input.before !== undefined && !reset ? input.before.offset : stream.bytes
    const start = input.cursor !== undefined && !reset ? input.cursor.offset : input.fromStart ? 0 : Math.max(0, end - input.limit)
    let offset = start; let before = start; const lines: ObservationPage['lines'] = []
    for (const frame of stream.frames.filter(frame => frame.end > start && frame.start < end)) {
      let position = frame.start
      for (const line of z.array(observationLineSchema).parse(this.readBlock(frame.hash))) {
        const next = position + Buffer.byteLength(JSON.stringify(line) + '\n')
        if ((position >= start || (input.cursor === undefined && next > start)) && position < end) {
          if (lines.length === 0) before = position
          if (input.stream === 'all' || line.stream === input.stream) lines.push(line)
          offset = next
          if (offset - start >= input.limit) break
        } else if (position < start && next > start) offset = next
        position = next
      }
      if (offset - start >= input.limit) break
    }
    const cursor = (position: number) => ({ experimentId: input.experimentId, serverId: input.serverId, sourceId: input.sourceId, stream: input.stream, generation, offset: position })
    return { lines, cursor: cursor(offset), before: cursor(before), hasEarlier: before > 0, hasMore: offset < stream.bytes, missing: false, reset }
  }
  /** @param raw - owned command pipe. @param limit - bounded byte page. @returns saved redacted pipe bytes. */
  processLog(raw: ProcessLogRequest, limit: number): ProcessLogPage | undefined {
    const input = processLogRequestSchema.parse(raw)
    const stream = this.manifest.streams.findLast(stream => stream.serverId === input.serverId && stream.commandId === input.commandId && stream.stream === input.stream && stream.kind === 'process-log' && !stream.superseded)
    if (stream === undefined) return undefined
    const cursor = input.cursor
    if (cursor !== undefined && (cursor.experimentId !== input.experimentId || cursor.serverId !== input.serverId || cursor.commandId !== input.commandId || cursor.stream !== input.stream)) throw new Error('Archive process cursor belongs to another command')
    const generation = 'archive-v1-' + stream.key
    const reset = cursor !== undefined && cursor.generation !== generation
    const offset = reset ? 0 : cursor?.offset ?? 0
    let position = 0; const parts: Buffer[] = []; let size = 0
    for (const frame of stream.frames) for (const line of z.array(observationLineSchema).parse(this.readBlock(frame.hash))) {
      const bytes = Buffer.from(line.text); const end = position + bytes.length
      if (end > offset && size < limit) { const part = bytes.subarray(Math.max(0, offset - position), Math.max(0, offset - position) + limit - size); parts.push(part); size += part.length }
      position = end
    }
    const bytes = Buffer.concat(parts)
    return { chunk: { data: bytes.toString('base64'), offset, nextOffset: offset + size, generation, eof: offset + size >= position, reset },
      cursor: { experimentId: input.experimentId, serverId: input.serverId, commandId: input.commandId, stream: input.stream, generation, offset: offset + size }, missing: false }
  }
}
