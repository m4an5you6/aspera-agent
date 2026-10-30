/** Authenticated reads use the pinned API; stopped controllers retain a bounded SSH history path. */
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { z } from 'zod'
import { clusterRecordSchema, agentRecordSchema, agentRecordCursorSchema, observationCursorSchema,
  experimentProcessSchema, metricSampleSchema, executionProgressReadSchema, clusterChunkSchema } from '@aspera/experiments'
import type { AgentRecordPage, ObservationPage, ProcessLogPage, ExperimentId, ExperimentServerId } from '@aspera/experiments'
import { archiveCatalogSchema } from './run-archive-store.ts'
import type { ArchiveCatalog, ArchiveRemoteSource, ArchiveStream } from './run-archive-store.ts'
import type { FleetExperiment } from './types.ts'
import type { Target } from './transport.ts'
import { shellQuote } from './transport.ts'
import type { remoteResult } from './transport.ts'

/** Operator-configured limits for background local copies. */
export const runArchivePolicySchema = z.object({
  archiveEnabled: z.boolean().default(true), archiveIntervalMs: z.number().int().min(500).default(15000),
  archiveBacklogIntervalMs: z.number().int().min(500).default(5000),
  archiveWaitingIntervalMs: z.number().int().min(500).default(30000),
  archiveReadBytes: z.number().int().min(1024).max(262144).default(65536), archiveBatchPages: z.number().int().min(1).max(1000).default(16),
  archiveRetryMinMs: z.number().int().min(100).default(10000), archiveRetryMaxMs: z.number().int().min(100).default(60000),
  archiveMinimumFreeBytes: z.number().int().nonnegative().default(1073741824),
  archiveCatalogEntries: z.number().int().min(1).max(100000).default(10000),
  archiveCatalogBytes: z.number().int().min(65536).max(100000000).default(8388608),
  archiveRequestTimeoutMs: z.number().int().min(1000).default(20000),
  archiveMetricGapMs: z.number().int().min(1000).default(900000),
  archiveLogPatterns: z.array(z.string().min(1)).default(['**/*.log', '**/logs/**/*.txt', '**/logs/**/*.jsonl']),
  archiveExcludeDirectories: z.array(z.string().regex(/^[^/\\]+$/)).default(['node_modules', '.git', '.venv', 'venv', 'env',
    'site-packages', '__pycache__', 'cache', '.cache', 'models', 'datasets', 'data']),
}).refine(policy => policy.archiveRetryMaxMs >= policy.archiveRetryMinMs, 'Archive maximum retry delay must not be smaller than its minimum')
/** Fully resolved local copy policy. */
export type RunArchivePolicy = z.infer<typeof runArchivePolicySchema>

/** Program-private credentials and connection settings never enter the archive or a model request. */
export interface ArchiveConnection { target: Target; password?: string }
/** Owned reads supplied by the fleet without invoking refresh's submission recovery. */
export interface ArchiveReadDriver {
  remoteResult: typeof remoteResult
  connection(record: FleetExperiment, serverId: ExperimentServerId): Promise<ArchiveConnection>
  rpc(record: FleetExperiment, operation: string, input: object, signal: AbortSignal): Promise<unknown>
  trace(record: FleetExperiment, input: { experimentId: ExperimentId; phase: 'planning' | 'execution'; cursor: z.infer<typeof agentRecordCursorSchema>; limit: number }, signal: AbortSignal): Promise<AgentRecordPage>
  observation(record: FleetExperiment, input: { experimentId: ExperimentId; serverId: ExperimentServerId; sourceId: ArchiveRemoteSource['id']; stream: 'all'; fromStart: boolean; cursor?: z.infer<typeof observationCursorSchema>; limit: number }, signal: AbortSignal): Promise<ObservationPage>
  pipe(record: FleetExperiment, input: { experimentId: ExperimentId; serverId: ExperimentServerId; commandId: string; stream: 'stdout' | 'stderr'; cursor?: ProcessLogPage['cursor'] }, signal: AbortSignal): Promise<ProcessLogPage>
}

function unavailable(error: unknown): boolean {
  return error instanceof Error && (/SSH|ECONN|timed?\s*out|handshake|Channel open|cluster route not found|HTTP (?:404|502|503|504)/i.test(error.message)
    || ('status' in error && typeof error.status === 'number' && [404, 502, 503, 504].includes(error.status)))
}

/** Read-only source discovery and physical byte access for fixed releases. */
export class RunArchiveReader {
  private readonly helper = readFileSync(new URL('../scripts/read-archive.mjs', import.meta.url), 'utf8')
  constructor(private readonly driver: ArchiveReadDriver, private readonly policy: RunArchivePolicy) {}

  private rpc(record: FleetExperiment, operation: string, input: object, signal: AbortSignal): Promise<unknown> {
    return this.driver.rpc(record, operation, input, AbortSignal.any([signal, AbortSignal.timeout(this.policy.archiveRequestTimeoutMs)]))
  }

  private input(record: FleetExperiment, serverId: ExperimentServerId): object {
    const server = record.servers.find(server => server.id === serverId)
    if (server === undefined || record.submission?.protocol !== 4) throw new Error('Archive server is outside this fixed experiment')
    const remote = record.latest ?? record.receipt
    return { experimentId: record.request.experimentId, serverId,
      runRoot: server.storagePlacement?.runRoot ?? posix.join(server.remoteRoot!, 'runs', record.request.experimentId),
      controlRoot: server.remoteRoot, coordinator: serverId === record.coordinator.id,
      sessions: { planning: remote?.planningSessionId ?? `aspera-plan-${record.request.experimentId}`,
        execution: remote?.sessionId ?? `aspera-execution-${record.request.experimentId}` },
      maxEntries: this.policy.archiveCatalogEntries, logPatterns: this.policy.archiveLogPatterns,
      excludeDirectories: this.policy.archiveExcludeDirectories }
  }
  private async ssh(record: FleetExperiment, serverId: ExperimentServerId, operation: 'archiveCatalog' | 'archiveRead', input: object, signal: AbortSignal): Promise<unknown> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(this.policy.archiveRequestTimeoutMs)])
    const { target, password } = await this.driver.connection(record, serverId)
    const payload = Buffer.from(JSON.stringify({ ...this.input(record, serverId), ...input })).toString('base64')
    const source = `${this.helper}\nconsole.log(JSON.stringify(${operation}(JSON.parse(Buffer.from('${payload}', 'base64').toString('utf8')))))`
    let output = ''
    const result = await this.driver.remoteResult({ ...target, toolTimeoutMs: this.policy.archiveRequestTimeoutMs },
      `node --input-type=module -e ${shellQuote(source)}`, signal, password, (stream, part) => {
        if (stream !== 'stdout') return
        output += part
        if (Buffer.byteLength(output) > this.policy.archiveCatalogBytes) throw new Error('Archive response exceeded its configured read budget')
      })
    if (result.exitCode !== 0 || result.timedOut || result.cancelled || !result.exitConfirmed) throw new Error(`Read-only archive ${operation} failed: exit=${result.exitCode}, timedOut=${result.timedOut}, cancelled=${result.cancelled}, exitConfirmed=${result.exitConfirmed}: ${result.stderr}`)
    // Fixture providers can return a bounded response without a pipe subscription.
    return JSON.parse(output || result.stdout)
  }

  /** @param record - immutable experiment. @param serverId - assigned node. @param after - last retained metric time.
   * @param signal - reader lifetime. @returns validated saved facts and live-control availability.
   */
  async catalog(record: FleetExperiment, serverId: ExperimentServerId, after: number | undefined, signal: AbortSignal): Promise<{ catalog: ArchiveCatalog; runtimeAvailable: boolean }> {
    let live: z.infer<typeof clusterRecordSchema> | undefined
    try {
      const response = z.object({ record: clusterRecordSchema }).parse(await this.rpc(record, 'status', { experimentId: record.request.experimentId }, signal))
      live = response.record
    } catch (error) { if (!unavailable(error)) throw error }
    const catalog = archiveCatalogSchema.parse(await this.ssh(record, serverId, 'archiveCatalog', { metricsAfter: after }, signal))
    if (live !== undefined && serverId === record.coordinator.id) catalog.record = live
    for (const current of [live, catalog.record]) if (current !== undefined && JSON.stringify(current.submission) !== JSON.stringify(record.submission)) throw new Error('Archive receipt does not match this fixed submission')
    const current = catalog.record ?? record.latest ?? record.receipt
    for (const source of catalog.sources) {
      if (posix.isAbsolute(source.path) || source.path.split(/[\\/]/).includes('..')) throw new Error('Archive catalog path is outside its experiment')
      if (source.source !== undefined && (source.source.experimentId !== record.request.experimentId || source.source.serverId !== serverId)) throw new Error('Archive source belongs to another experiment or node')
    }
    const session = (phase: 'planning' | 'execution', saved: string | undefined): string | undefined => {
      if (saved !== undefined) return saved
      if (!catalog.sources.some(source => source.kind === 'trace' && source.phase === phase)) return undefined
      const declared = new Set(catalog.sources.flatMap(source => source.source?.kind === 'agent' && source.source.phase === phase
        && source.source.sessionId !== undefined ? [source.source.sessionId] : []))
      if (declared.size > 1) throw new Error('Archive phase has multiple declared Agent Sessions without a confirmed queue identity: ' + phase)
      return declared.values().next().value
    }
    const sessions = { planning: session('planning', current?.planningSessionId), execution: session('execution', current?.sessionId) }
    catalog.sources = catalog.sources.filter(source => source.kind !== 'trace' || sessions[source.phase === 'planning' ? 'planning' : 'execution'] !== undefined)
    for (const source of catalog.sources) {
      if (source.kind === 'trace') {
        if (serverId !== record.coordinator.id) throw new Error('Archive trace is not on its recorded coordinator')
        source.sessionId = sessions[source.phase === 'planning' ? 'planning' : 'execution']
      }
    }
    if (catalog.progress !== undefined && (catalog.progress.experimentId !== record.request.experimentId || catalog.progress.planRevision !== current?.plan?.revision
      || catalog.progress.sessionId !== (current?.sessionId ?? `aspera-execution-${record.request.experimentId}`))) throw new Error('Archived steps belong to another experiment, plan or Session')
    if (live !== undefined) {
      try { catalog.processes = z.array(experimentProcessSchema).parse(await this.rpc(record, 'processes', { experimentId: record.request.experimentId, serverId }, signal)) }
      catch (error) { if (!unavailable(error)) throw error }
      try { catalog.metrics = z.array(metricSampleSchema).parse(await this.rpc(record, 'observation-metrics', { experimentId: record.request.experimentId, serverId, ...(after === undefined ? {} : { after: after - 1 }), limit: 1000 }, signal)) }
      catch (error) { if (!unavailable(error)) throw error }
      if (serverId === record.coordinator.id) try {
        const progress = executionProgressReadSchema.parse(await this.rpc(record, 'execution-progress', { experimentId: record.request.experimentId }, signal))
        catalog.stepSupported = progress.supported
        if (progress.progress !== undefined) catalog.progress = progress.progress
      } catch (error) { if (!unavailable(error)) throw error; if (error instanceof Error && error.message === 'cluster route not found') catalog.stepSupported = false }
    }
    if (catalog.progress !== undefined && (catalog.progress.experimentId !== record.request.experimentId || catalog.progress.planRevision !== current?.plan?.revision
      || catalog.progress.sessionId !== (current?.sessionId ?? `aspera-execution-${record.request.experimentId}`))) throw new Error('Archived steps belong to another experiment, plan or Session')
    return { catalog, runtimeAvailable: live !== undefined }
  }

  /** @param record - fixed experiment. @param serverId - owned node. @param source - physical source. @param offset - remote bytes.
   * @param signal - reader lifetime. @returns generation-checked raw bytes; partial records remain uncommitted.
   */
  async bytes(record: FleetExperiment, serverId: ExperimentServerId, source: ArchiveRemoteSource, offset: number, signal: AbortSignal): Promise<z.infer<typeof clusterChunkSchema> & { length: number }> {
    const result = z.object({ data: z.string(), offset: z.number().int(), nextOffset: z.number().int(), generation: z.string(), length: z.number().int(), eof: z.boolean() }).strict()
      .parse(await this.ssh(record, serverId, 'archiveRead', { path: source.path, generation: source.generation, offset, limit: this.policy.archiveReadBytes }, signal))
    if (result.offset !== offset || result.generation !== source.generation || result.nextOffset !== offset + Buffer.from(result.data, 'base64').length) throw new Error('Archive byte response did not match its cursor')
    if (result.nextOffset === offset && !result.eof) throw new Error('Archive byte read made no progress')
    return { ...result, reset: false }
  }

  /** @param record - fixed experiment. @param stream - durable continuation. @param signal - reader lifetime.
   * @returns an authenticated event page, or undefined when the pinned controller is unavailable.
   */
  async trace(record: FleetExperiment, stream: ArchiveStream, signal: AbortSignal): Promise<AgentRecordPage | undefined> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(this.policy.archiveRequestTimeoutMs)])
    if (stream.phase !== 'planning' && stream.phase !== 'execution') throw new Error('Archived trace has no phase')
    try {
      const page = await this.driver.trace(record, { experimentId: record.request.experimentId, phase: stream.phase,
        cursor: { experimentId: record.request.experimentId, phase: stream.phase, sessionId: stream.sessionId!, nextSeq: (stream.lastSeq ?? -1) + 1 }, limit: 100 }, signal)
      for (const event of page.records) {
        agentRecordSchema.parse(event)
        if (event.experimentId !== record.request.experimentId || event.phase !== stream.phase || event.sessionId !== stream.sessionId) throw new Error('Archive event belongs to another experiment or Session')
        if (event.truncated) return undefined
        JSON.parse(event.data)
      }
      return page
    } catch (error) { if (unavailable(error)) return undefined; throw error }
  }
  /** @param record - fixed experiment. @param stream - copied registered log. @param signal - reader lifetime. @returns API log page or a stopped-controller indication. */
  async observation(record: FleetExperiment, stream: ArchiveStream, signal: AbortSignal): Promise<ObservationPage | undefined> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(this.policy.archiveRequestTimeoutMs)])
    try { return await this.driver.observation(record, { experimentId: record.request.experimentId, serverId: stream.serverId, sourceId: stream.id,
      stream: 'all', fromStart: stream.remoteOffset === 0, limit: this.policy.archiveReadBytes,
      ...(stream.remoteOffset === 0 ? {} : { cursor: { experimentId: record.request.experimentId, serverId: stream.serverId,
        sourceId: stream.id, stream: 'all', generation: stream.physicalGeneration, offset: stream.remoteOffset } }) }, signal) }
    catch (error) { if (unavailable(error)) return undefined; throw error }
  }
  /** @param record - fixed experiment. @param stream - saved command pipe. @param signal - owned read lifetime.
   * @returns authenticated pipe bytes, or undefined before a legacy or stopped controller can supply them.
   */
  async pipe(record: FleetExperiment, stream: ArchiveStream, signal: AbortSignal): Promise<z.infer<typeof clusterChunkSchema> & { length: number } | undefined> {
    signal = AbortSignal.any([signal, AbortSignal.timeout(this.policy.archiveRequestTimeoutMs)])
    if (stream.commandId === undefined || (stream.stream !== 'stdout' && stream.stream !== 'stderr')) throw new Error('Archived command pipe has no owned identity')
    try {
      const page = await this.driver.pipe(record, { experimentId: record.request.experimentId, serverId: stream.serverId,
        commandId: stream.commandId, stream: stream.stream, cursor: { experimentId: record.request.experimentId, serverId: stream.serverId,
          commandId: stream.commandId, stream: stream.stream, generation: stream.physicalGeneration, offset: stream.remoteOffset } }, signal)
      if (page.missing || page.chunk.reset || page.chunk.generation !== stream.physicalGeneration) return undefined
      if (page.cursor.experimentId !== record.request.experimentId || page.cursor.serverId !== stream.serverId || page.cursor.commandId !== stream.commandId || page.cursor.stream !== stream.stream) throw new Error('Archive pipe belongs to another experiment or command')
      return { ...page.chunk, length: stream.size }
    } catch (error) { if (unavailable(error)) return undefined; throw error }
  }
}
