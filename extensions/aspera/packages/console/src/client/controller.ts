import type { ExperimentDeletion, ExperimentDeletionPreview } from '@aspera/dispatch/types'
type ManagementMessage = 'experimentsDeleted' | 'deletionIncomplete' | 'serverDeleted' | 'serverDeleteFailed'
import type {} from '@aspera/dispatch/remote'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
/** Independent experiment selection, incremental reads, and browser actions. */
import type { Context } from '@deepseek-ai/cordis'
import type { ClusterFile, ServerSettings, ServerProbe, FleetExperiment, FleetRegistry, FleetServerInput } from '@aspera/dispatch/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { Config } from '../config.ts'
import type { ServiceAccessInfo } from '@aspera/experiments/types'
import type { ExperimentModels, ExperimentModelDirectory, AgentRecordRequest, AgentRecordPage, ExperimentProcess, ProcessLogRequest, ProcessLogPage } from '@aspera/experiments/types'
import { readPreferences, savePreferences } from './preferences.ts'
import type { AsperaPreferences } from './preferences.ts'
import { experimentTodos } from './attention.ts'
import { errorIdentity } from './error-identity.ts'
import type { ObservationSource, ObservationRead, ObservationPage, MetricRead, MetricSample } from '@aspera/experiments/types'
type FailureScope = { experimentId?: string; phase?: 'preparation' | 'planning' | 'execution'; serverId?: string; operation?: string }

function unwrap<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

/** Read-only stream tail belonging to exactly one experiment and source. */
export interface ExperimentStream {
  text: string
  reset: boolean
  generation?: string
  offset: number
}

/** Shared panel state survives switching between conversations and experiments. */
export interface ExperimentsSnapshot {
  view: 'list' | 'servers' | 'new' | 'services'
  preferences: AsperaPreferences
  modelDirectory: ExperimentModelDirectory | null
  modelsLoading: boolean
  modelsError: string | null
  settingsOpen: boolean
  registry: FleetRegistry
  experiments: FleetExperiment[]
  selectedId: string | null
  probes: Record<string, ServerProbe>
  probeErrors: Record<string, string>
  streams: Record<string, ExperimentStream>
  files: ClusterFile[]
  filesTruncated: boolean
  retrying: string[]
  probing: string[]
  removingServers: string[]
  deletedIds: string[]
  deletions: ExperimentDeletion[]
  toast: { key: ManagementMessage; sequence: number; failed: boolean } | null
  error: string | null
  sourceErrors: Record<string, string>
  errorNotice: { message: string; identity: string; sequence: number } | null
}

/** The page's RPC lifecycle and cursor ownership. */
export class ExperimentsController {
  /** Observable page data; execution ownership remains on the Host. */
  readonly store = createSnapshotStore<ExperimentsSnapshot>({ view: 'list', preferences: readPreferences(), modelDirectory: null, modelsLoading: false, modelsError: null, settingsOpen: false,
    registry: { servers: [] }, experiments: [], selectedId: null,
    probes: {}, probeErrors: {}, streams: {}, files: [], filesTruncated: false, retrying: [], probing: [], removingServers: [], deletedIds: [], deletions: [], toast: null, error: null, sourceErrors: {}, errorNotice: null })
  private readonly announcedErrors = new Set<string>()
  private readonly errorQueue: NonNullable<ExperimentsSnapshot['errorNotice']>[] = []
  private errorSequence = 0
  private detailView = 'overview'
  private readonly deleted = new Set<string>()
  private readonly removedServers = new Set<string>()
  private readonly preparationRetries = new Map<string, Promise<void>>()
  private readonly serverChecks = new Map<string, Promise<void>>()
  private readonly serverRemovals = new Map<string, Promise<void>>()
  private readonly serverRevisions = new Map<string, number>()
  private readonly decoders = new Map<string, TextDecoder>()
  private loading: Promise<void> | undefined
  private disposed = false
  private visible = false
  private registryRevision = 0

  private readonly config: Required<Config>
  constructor(private readonly remote: Context['remote']['aspera'], config: Config) {
    this.config = { ...config, metricWindowMs: config.metricWindowMs ?? 900000, observationReadBytes: config.observationReadBytes ?? 65536,
      traceRetainedChars: config.traceRetainedChars ?? 2000000, metricSampleLimit: config.metricSampleLimit ?? 1000 }
  }

  /** @param view - Aspera sidebar destination. */
  navigate(view: ExperimentsSnapshot['view']): void { this.patch({ view, selectedId: null }); void this.refresh() }
  /** Toggle only the Aspera group, retaining the official sidebar's own fold state. */
  toggleGroup(): void { this.preferences({ collapsed: !this.store.getSnapshot().preferences.collapsed }) }
  private preferences(update: Partial<AsperaPreferences>): void {
    const preferences = { ...this.store.getSnapshot().preferences, ...update }
    savePreferences(preferences); this.patch({ preferences })
  }
  /** Dismiss currently visible reminders without answering or changing pending counts. */
  dismissTodos(): void {
    const state = this.store.getSnapshot()
    this.preferences({ dismissed: [...new Set([...state.preferences.dismissed, ...experimentTodos(state.experiments).map(todo => todo.key)])] })
  }
  /** @param open - whether the Aspera model summary dialog is open. */
  modelSettings(open: boolean): void { this.patch({ settingsOpen: open }); if (open) void this.loadModels() }
  /** Load DSH model names and credential presence; the browser never reads keys. */
  async loadModels(): Promise<void> {
    if (this.store.getSnapshot().modelsLoading) return
    this.patch({ modelsLoading: true, modelsError: null })
    try { this.patch({ modelDirectory: unwrap(await this.remote.experimentModels()) }) }
    catch (error) { this.patch({ modelsError: String(error) }) }
    finally { this.patch({ modelsLoading: false }) }
  }
  /** @param request - phase and cursor. @returns a bounded record page. */
  records(request: AgentRecordRequest): Promise<AgentRecordPage> { return this.remote.experimentTrace(request).then(unwrap) }
  /** @param id - experiment. @param phase - saved Session role. @param seq - owning event. @param attachmentId - recorded image or file. @returns a browser-owned blob URL. */
  async traceImage(id: string, phase: 'preparation' | 'planning' | 'execution', seq: number, attachmentId: string): Promise<string> {
    const parts: BlobPart[] = []; let offset = 0; let mediaType = ''
    for (;;) {
      const part = unwrap(await this.remote.experimentTraceAttachment(id, phase, seq, attachmentId, offset))
      const bytes = Uint8Array.from(atob(part.data), char => char.charCodeAt(0))
      if (part.nextOffset !== offset + bytes.length) throw new Error('Attachment did not advance')
      parts.push(bytes); offset = part.nextOffset; mediaType = part.mediaType
      if (offset === part.size) break
      if (bytes.length === 0 || offset > part.size) throw new Error('Attachment is incomplete')
    }
    return URL.createObjectURL(new Blob(parts, { type: mediaType }))
  }
  /** @param view - mounted detail region; expensive reads belong to their consuming view. */
  setDetailView(view: string): void { this.detailView = view; this.tick() }
  /** @param id - experiment. @param serverId - pinned node. @returns real registered log sources. */
  logSources(id: string, serverId: string): Promise<{ sources: ObservationSource[]; legacy: boolean }> { return this.remote.experimentLogSources(id, serverId).then(unwrap) }
  /** @param request - selected source and cursor. @returns bounded output records. */
  logRead(request: ObservationRead): Promise<ObservationPage> { return this.remote.experimentLog(request).then(unwrap) }
  /** @param request - metric history range. @returns actually recorded samples. */
  metrics(request: MetricRead): Promise<MetricSample[]> { return this.remote.experimentMetrics(request).then(unwrap) }
  /** @param request - complete source download. @returns one-use address. */
  logDownload(request: ObservationRead): Promise<string> { return this.remote.downloadExperimentLog(request).then(unwrap) }
  /** @param id - experiment. @param serverId - node. @returns real managed processes. */
  processes(id: string, serverId: string): Promise<ExperimentProcess[]> { return this.remote.experimentProcesses(id, serverId).then(unwrap) }
  /** @param request - process and output stream. @returns resumable bytes. */
  processLog(request: ProcessLogRequest): Promise<ProcessLogPage> { return this.remote.experimentProcessLog(request).then(unwrap) }
  /** @returns polling and memory limits shared by record and log views. */
  displayLimits(): Required<Config> { return this.config }

  /** @returns profile-configured initial node control port; the coordinator uses the following port. */
  initialControlPort(): number { return this.config.defaultControlPort }

  /** @param id - experiment. @param serviceId - public service. @returns a service key only after an operator asks to view calling information. */
  async serviceAccessInfo(id: string, serviceId: string): Promise<ServiceAccessInfo> {
    return unwrap(await this.remote.serviceAccessInfo(id, serviceId))
  }

  /** Apply a validated reconnect snapshot without moving local log cursors. @param snapshot - current durable records. */
  receive(snapshot: import('@aspera/dispatch/types').FleetSnapshot): void {
    for (const id of snapshot.deletedIds) this.deleted.add(id)
    const selectedId = this.store.getSnapshot().selectedId
    for (const key of this.decoders.keys()) if (this.deleted.has(key.split('/')[0]!)) this.decoders.delete(key)
    const streams = Object.fromEntries(Object.entries(this.store.getSnapshot().streams).filter(([key]) => !this.deleted.has(key.split('/')[0]!)))
    this.patch({ registry: { ...snapshot.registry, servers: snapshot.registry.servers.filter(server => !this.removedServers.has(server.id)) },
      experiments: this.store.getSnapshot().experiments.filter(row => !this.deleted.has(row.request.experimentId)),
      streams, deletedIds: [...this.deleted], deletions: snapshot.deletions, ...(selectedId !== null && this.deleted.has(selectedId) ? { selectedId: null, files: [], filesTruncated: false } : {}) })
    for (const record of snapshot.experiments) this.replace(record)
  }

  private isDisposed(): boolean { return this.disposed }

  private patch(patch: Partial<ExperimentsSnapshot>): void {
    if (!this.disposed) this.store.update((value) => { Object.assign(value, patch) })
  }

  /**
   * Show an operation failure without discarding existing records.
   * @param error - operation failure shown without dropping saved rows.
   */
  report(error: unknown, scope: FailureScope = {}): void {
    const message = error instanceof Error ? error.message : String(error)
    const selectedId = this.store.getSnapshot().selectedId
    const owner = { ...(selectedId === null ? {} : { experimentId: selectedId }), ...scope, operation: scope.operation ?? 'operation' }
    const key = JSON.stringify(owner)
    this.patch({ error: message, sourceErrors: { ...this.store.getSnapshot().sourceErrors, [key]: message } })
    const identity = errorIdentity(message); const fingerprint = JSON.stringify([owner, identity])
    if (this.announcedErrors.has(fingerprint)) return
    this.announcedErrors.add(fingerprint)
    const display = () => {
      const notice = { message, identity, sequence: ++this.errorSequence }
      if (this.store.getSnapshot().errorNotice === null) this.patch({ errorNotice: notice })
      else this.errorQueue.push(notice)
    }
    void Promise.resolve().then(() => this.remote.claimErrorNotice({ ...owner, identity })).then(unwrap).then(first => { if (first) display() }).catch(display)
  }
  /** Dismiss transient feedback without clearing the failed operation or experiment state. */
  dismissErrorNotice(): void { this.patch({ errorNotice: this.errorQueue.shift() ?? null }) }
  /** @param scope - independently recovered read source. */
  sourceRecovered(scope: FailureScope): void {
    const key = JSON.stringify({ ...scope, operation: scope.operation ?? 'operation' })
    const sourceErrors = { ...this.store.getSnapshot().sourceErrors }; delete sourceErrors[key]
    this.patch({ sourceErrors })
  }

  /**
   * Enable polling while the experiment page is mounted.
   * @param visible - whether the page is mounted.
   */
  setVisible(visible: boolean): void { this.visible = visible; if (visible) void this.refresh() }

  /**
   * Reconcile saved experiment state and ownership evidence.
   * @returns one refresh pass, coalesced across timer, reconnect, and user clicks.
   */
  refresh(): Promise<void> {
    if (this.isDisposed()) return Promise.resolve()
    if (this.loading !== undefined) return this.loading
    const work = this.load().catch((error: unknown) => { this.report(error) }).finally(() => { this.loading = undefined })
    this.loading = work
    return work
  }

  private async load(): Promise<void> {
    const registryRevision = this.registryRevision
    const snapshot = unwrap(await this.remote.experimentSnapshot())
    const { registry, experiments } = snapshot
    if (this.isDisposed()) return
    this.receive({ ...snapshot, registry: registryRevision === this.registryRevision ? registry : this.store.getSnapshot().registry })
    const selected = this.store.getSnapshot().selectedId
    const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled', 'interrupted'])
    const pending = experiments.filter(row => row.submission !== undefined && (row.request.experimentId === selected
      || row.latest === undefined || !row.latest.resourcesReleased || !terminal.has(row.latest.state)))
    const refreshed = await Promise.allSettled(pending.map(row => this.remote.refreshExperiment(row.request.experimentId).then(unwrap)))
    for (const [index, result] of refreshed.entries()) {
      const scope = { experimentId: pending[index]!.request.experimentId, operation: 'status' }
      if (result.status === 'fulfilled') { this.replace(result.value); this.sourceRecovered(scope) }
      else this.report(result.reason, scope)
    }
    if (this.isDisposed()) return
    const detail = this.store.getSnapshot().experiments.find(row => row.request.experimentId === selected)
    if (!this.visible || detail?.receipt === undefined) return
    if (this.detailView === 'overview' && detail.latest?.questions?.some(question => question.state === 'open')) await this.readStream(detail, 'events')
    if (this.detailView !== 'files') return
    const files = await Promise.all(detail.servers.map(server => this.remote.experimentFiles(detail.request.experimentId,
      server.id).then(unwrap)))
    if (this.store.getSnapshot().selectedId === selected) this.patch({ files: files.flatMap(row => row.files),
      filesTruncated: files.some(row => row.truncated) })
  }

  private replace(row: FleetExperiment): void {
    if (this.deleted.has(row.request.experimentId)) return
    const current = this.store.getSnapshot().experiments
    const previous = current.find(value => value.request.experimentId === row.request.experimentId)
    if ((previous?.latest?.revision ?? 0) > (row.latest?.revision ?? 0)) return
    const experiments = [row, ...current.filter(value => value.request.experimentId !== row.request.experimentId)]
    this.patch({ experiments: experiments.sort((a, b) => b.createdAt - a.createdAt) })
  }

  private async readStream(row: FleetExperiment, kind: 'events' | 'log' | 'agent-log', server?: ServerSettings): Promise<void> {
    if (this.isDisposed()) return
    const key = `${row.request.experimentId}/${server?.id ?? kind}`
    const previous = this.store.getSnapshot().streams[key] ?? { text: '', reset: false, offset: 0 }
    const chunk = unwrap(await this.remote.readExperiment(row.request.experimentId, kind, previous.offset, server?.id,
      undefined, previous.generation === '' ? undefined : previous.generation))
    if (this.isDisposed() || this.deleted.has(row.request.experimentId)) return
    let decoder = this.decoders.get(key)
    if (chunk.reset || decoder === undefined) { decoder = new TextDecoder(); this.decoders.set(key, decoder) }
    const bytes = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0))
    const text = ((chunk.reset ? '' : previous.text) + decoder.decode(bytes, { stream: true })).slice(-this.config.retainedTextChars)
    this.patch({ streams: { ...this.store.getSnapshot().streams, [key]: { text, reset: previous.reset || (chunk.reset && chunk.generation !== ''),
      generation: chunk.generation, offset: chunk.nextOffset } } })
  }

  /**
   * Select an experiment and reset its displayed artifact list.
   * @param id - detail to open, or null for the experiment list.
   */
  select(id: string | null): void {
    this.patch({ selectedId: id, files: [], filesTruncated: false })
    void this.refresh()
  }

  /**
   * Save server preferences without changing submitted experiment snapshots.
   * @param server - complete server settings.
   * @param password - new secret or empty to preserve it.
   */
  async saveServer(server: FleetServerInput, password: string): Promise<void> {
    this.registryRevision++
    this.serverRevisions.set(server.id, (this.serverRevisions.get(server.id) ?? 0) + 1)
    if (password !== '') await this.remote.setPassword({ host: server.host, username: server.username, sshPort: server.sshPort,
      ...(server.passwordRef === undefined ? {} : { passwordRef: server.passwordRef }) }, password).then(unwrap)
    const registry = unwrap(await this.remote.saveServer(server))
    this.registryRevision++
    this.removedServers.delete(server.id)
    const { [server.id]: _oldProbe, ...probes } = this.store.getSnapshot().probes
    const { [server.id]: _oldError, ...probeErrors } = this.store.getSnapshot().probeErrors
    this.patch({ registry, probes, probeErrors, error: null })
  }

  /**
   * Remove an unused server from future selections.
   * @param id - server removed from future selections.
   */
  removeServer(id: string): Promise<void> {
    const existing = this.serverRemovals.get(id)
    if (existing !== undefined) return existing
    this.serverRevisions.set(id, (this.serverRevisions.get(id) ?? 0) + 1)
    const operation = Promise.resolve().then(async () => {
      this.registryRevision++
      const registry = unwrap(await this.remote.removeServer(id))
      this.registryRevision++
      this.removedServers.add(id)
      const { [id]: _oldProbe, ...probes } = this.store.getSnapshot().probes
      const { [id]: _oldError, ...probeErrors } = this.store.getSnapshot().probeErrors
      this.patch({ registry, probes, probeErrors })
      this.notify('serverDeleted')
    }).finally(() => {
      this.serverRemovals.delete(id)
      this.patch({ removingServers: [...this.serverRemovals.keys()] })
    })
    this.serverRemovals.set(id, operation)
    this.patch({ removingServers: [...this.serverRemovals.keys()], error: null })
    return operation
  }

  /**
   * Check SSH connectivity and report GPU and allocation facts.
   * @param id - server whose SSH and GPU inventory are checked.
   */
  probe(id: string): Promise<void> {
    const existing = this.serverChecks.get(id)
    if (existing !== undefined) return existing
    const revision = this.serverRevisions.get(id) ?? 0
    const operation = Promise.resolve().then(async () => {
      try {
        const result = unwrap(await this.remote.probeServer(id))
        if ((this.serverRevisions.get(id) ?? 0) !== revision) return
        const { [id]: _previous, ...probeErrors } = this.store.getSnapshot().probeErrors
        const registry = this.store.getSnapshot().registry
        this.patch({ registry: { ...registry, checks: { ...registry.checks, [id]: result } },
          probes: { ...this.store.getSnapshot().probes, ...(result.result === undefined ? {} : { [id]: result.result }) }, probeErrors })
      } catch (error) {
        if ((this.serverRevisions.get(id) ?? 0) !== revision) return
        const { [id]: _previous, ...probes } = this.store.getSnapshot().probes
        this.patch({ probes, probeErrors: { ...this.store.getSnapshot().probeErrors, [id]: String(error) } })
        throw error
      }
    }).finally(() => {
      this.serverChecks.delete(id)
      this.patch({ probing: [...this.serverChecks.keys()] })
    })
    this.serverChecks.set(id, operation)
    this.patch({ probing: [...this.serverChecks.keys()], error: null })
    return operation
  }

  /**
   * Persist an independent experiment before beginning asynchronous preparation.
   * @param objective - experiment goal.
   * @param serverIds - joint participants.
   * @param files - local data paths.
   * @param uploads - browser attachments.
   * @param id - stable id reused for retries.
   */
  async create(objective: string, serverIds: string[], coordinatorId: string, files: string[], uploads: File[], id: string,
    mode: 'semi' | 'automatic', name?: string, models?: ExperimentModels): Promise<void> {
    if (models === undefined) throw new Error('Select the Agent model for every phase')
    const validated = unwrap(await this.remote.validateExperimentModels(models))
    const row = unwrap(await this.remote.createExperiment({ experimentId: id, objective, serverIds, coordinatorId, files,
      uploads: uploads.map(file => ({ name: file.name, size: file.size })), mode, ...(name === undefined ? {} : { name }), models: validated }))
    this.preferences({ models: validated })
    this.patch({ view: 'list' })
    this.replace(row)
    this.select(id)
    if (uploads.length > 0) void this.stageInputs(id, uploads).catch(error => { this.report(error) })
  }

  private async stageInputs(id: string, uploads: File[]): Promise<void> {
    for (const file of uploads) {
      let offset = 0
      do {
        if (this.disposed) return
        const bytes = new Uint8Array(await file.slice(offset, offset + 65536).arrayBuffer())
        const data = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
        const result = unwrap(await this.remote.uploadExperimentInput(id, file.name, offset, data))
        if (result.nextOffset !== offset + bytes.length) throw new Error('input upload returned a different cursor')
        offset = result.nextOffset
      } while (offset < file.size)
    }
    this.replace(unwrap(await this.remote.commitExperimentInputs(id)))
  }

  /** @param id - owning experiment. @param reply - exact question and decision. */
  async answer(id: string, reply: import('@aspera/experiments/types').AnswerExperimentQuestion): Promise<void> {
    this.replace(unwrap(await this.remote.answerExperimentQuestion(id, reply)))
  }
  /** @param id - experiment. @param revision - displayed plan. */
  async approve(id: string, revision: number): Promise<void> { this.replace(unwrap(await this.remote.approvePlan(id, revision))) }
  /** @param id - experiment. @param serviceId - registered inference process. */
  async stopService(id: string, serviceId: string): Promise<void> { this.replace(unwrap(await this.remote.stopService(id, serviceId))) }
  /** @param id - experiment. @param serviceId - registered process. @returns health response through managed SSH. */
  async accessService(id: string, serviceId: string, path: string, method: 'GET' | 'POST', body?: string): Promise<string> {
    return this.remote.accessService(id, serviceId, path, method, body).then(unwrap)
  }

  /** @param id - saved server. @returns the password only after the editor requests it. */
  revealServerPassword(id: string): Promise<string> { return this.remote.revealServerPassword(id).then(unwrap) }
  /** @param ids - selected records. @returns removal requirements and paths. */
  previewDeletion(ids: string[]): Promise<ExperimentDeletionPreview[]> { return this.remote.previewExperimentDeletion(ids).then(unwrap) }
  /** @param ids - confirmed records. @param cleanupRemote - explicit file cleanup. @param operationId - retained retry identity. @returns individual outcomes. */
  async deleteExperiments(ids: string[], cleanupRemote: boolean, operationId: string): Promise<ExperimentDeletion[]> {
    const results = unwrap(await this.remote.deleteExperiments({ experimentIds: ids, cleanupRemote, operationId }))
    for (const result of results) if (result.state === 'deleted') this.deleted.add(result.experimentId)
    this.receive({ registry: this.store.getSnapshot().registry, experiments: this.store.getSnapshot().experiments,
      deletedIds: [], deletions: results })
    this.notify(results.some(result => result.state !== 'deleted') ? 'deletionIncomplete' : 'experimentsDeleted', results.some(result => result.state !== 'deleted'))
    return results
  }
  /** @param key - localized operation outcome. @param failed - whether to show warning treatment. */
  notify(key: ManagementMessage, failed = false): void { this.patch({ toast: { key, failed, sequence: (this.store.getSnapshot().toast?.sequence ?? 0) + 1 } }) }
  /** Clear only the displayed operation notification. */
  clearToast(): void { this.patch({ toast: null }) }

  /**
   * Cancel the saved experiment while retaining unconfirmed allocations.
   * @param id - experiment whose cancellation is recorded remotely.
   */
  async cancel(id: string): Promise<void> { this.replace(unwrap(await this.remote.cancelExperiment(id))) }
  /** Resume a failed preparation, sharing one pending request per experiment across page navigation.
   * @param id - immutable experiment identity. @returns completion of the accepted retry request.
   */
  retry(id: string): Promise<void> {
    const existing = this.preparationRetries.get(id)
    if (existing !== undefined) return existing
    const operation = Promise.resolve().then(() => this.remote.retryPreparation(id)).then(result => { this.replace(unwrap(result)) }).finally(() => {
      this.preparationRetries.delete(id)
      this.patch({ retrying: [...this.preparationRetries.keys()] })
    })
    this.preparationRetries.set(id, operation)
    this.patch({ retrying: [...this.preparationRetries.keys()], error: null })
    return operation
  }

  /**
   * Request a private streaming download address.
   * @param id - experiment.
   * @param file - selected metadata entry.
   * @returns a private, expiring streaming download URL.
   */
  async download(id: string, file: ClusterFile): Promise<string> { return unwrap(await this.remote.downloadExperimentFile(id,
    file.serverId, file.path)) }

  /**
   * Create a draft identity retained across submission retries.
   * @returns a new id for a draft; callers retain it across uncertain submissions.
   */
  newId(): string { return randomUUID() }

  /** Keep attention receipts current even while another page is open; log reads require visibility. */
  tick(): void { void this.refresh() }

  /** Stop applying late replies after the plugin is unloaded. */
  dispose(): void { this.disposed = true; this.visible = false; this.decoders.clear() }
}
