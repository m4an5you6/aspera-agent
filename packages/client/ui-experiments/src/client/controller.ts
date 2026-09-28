/** Independent experiment selection, incremental reads, and browser actions. */
import type { Context } from '@deepseek-ai/cordis'
import type { ClusterFile, ClusterServer, FleetExperiment, FleetRegistry, FleetServerInput } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { Config } from '../config.ts'

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
  registry: FleetRegistry
  experiments: FleetExperiment[]
  selectedId: string | null
  probes: Record<string, { gpuInfo: string; allocations: string[] }>
  probeErrors: Record<string, string>
  streams: Record<string, ExperimentStream>
  files: ClusterFile[]
  filesTruncated: boolean
  error: string | null
}

/** The page's RPC lifecycle and cursor ownership. */
export class ExperimentsController {
  /** Observable page data; execution ownership remains on the Host. */
  readonly store = createSnapshotStore<ExperimentsSnapshot>({ registry: { servers: [] }, experiments: [], selectedId: null,
    probes: {}, probeErrors: {}, streams: {}, files: [], filesTruncated: false, error: null })
  private readonly decoders = new Map<string, TextDecoder>()
  private loading: Promise<void> | undefined
  private disposed = false
  private visible = false
  private registryRevision = 0

  constructor(private readonly remote: Context['remote']['experimentDispatch'], private readonly config: Config) {}

  private isDisposed(): boolean { return this.disposed }

  private patch(patch: Partial<ExperimentsSnapshot>): void {
    if (!this.disposed) this.store.update((value) => { Object.assign(value, patch) })
  }

  /**
   * Show an operation failure without discarding existing records.
   * @param error - operation failure shown without dropping saved rows.
   */
  report(error: unknown): void { this.patch({ error: error instanceof Error ? error.message : String(error) }) }

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
    const [registry, experiments] = await Promise.all([this.remote.servers().then(unwrap), this.remote.experiments().then(unwrap)])
    if (this.isDisposed()) return
    this.patch({ ...(registryRevision === this.registryRevision ? { registry } : {}), error: null })
    for (const row of experiments) this.replace(row)
    const selected = this.store.getSnapshot().selectedId
    const pending = experiments.filter(row => row.submission !== undefined && (row.request.experimentId === selected
      || row.latest === undefined || !row.latest.resourcesReleased || row.latest.state === 'queued'))
    const refreshed = await Promise.allSettled(pending.map(row => this.remote.refreshExperiment(row.request.experimentId).then(unwrap)))
    for (const result of refreshed) {
      if (result.status === 'fulfilled') this.replace(result.value)
      else this.report(result.reason)
    }
    if (this.isDisposed()) return
    const detail = this.store.getSnapshot().experiments.find(row => row.request.experimentId === selected)
    if (detail?.receipt === undefined) return
    await this.readStream(detail, 'events')
    await this.readStream(detail, 'agent-log')
    for (const server of detail.servers) await this.readStream(detail, 'log', server)
    const files = await Promise.all(detail.servers.map(server => this.remote.experimentFiles(detail.request.experimentId,
      server.id).then(unwrap)))
    if (this.store.getSnapshot().selectedId === selected) this.patch({ files: files.flatMap(row => row.files),
      filesTruncated: files.some(row => row.truncated) })
  }

  private replace(row: FleetExperiment): void {
    const current = this.store.getSnapshot().experiments
    const previous = current.find(value => value.request.experimentId === row.request.experimentId)
    if ((previous?.latest?.revision ?? 0) > (row.latest?.revision ?? 0)) return
    const experiments = [row, ...current.filter(value => value.request.experimentId !== row.request.experimentId)]
    this.patch({ experiments: experiments.sort((a, b) => b.createdAt - a.createdAt) })
  }

  private async readStream(row: FleetExperiment, kind: 'events' | 'log' | 'agent-log', server?: ClusterServer): Promise<void> {
    if (this.isDisposed()) return
    const key = `${row.request.experimentId}/${server?.id ?? kind}`
    const previous = this.store.getSnapshot().streams[key] ?? { text: '', reset: false, offset: 0 }
    const chunk = unwrap(await this.remote.readExperiment(row.request.experimentId, kind, previous.offset, server?.id,
      undefined, previous.generation))
    if (this.isDisposed()) return
    let decoder = this.decoders.get(key)
    if (chunk.reset || decoder === undefined) { decoder = new TextDecoder(); this.decoders.set(key, decoder) }
    const bytes = Uint8Array.from(atob(chunk.data), character => character.charCodeAt(0))
    const text = ((chunk.reset ? '' : previous.text) + decoder.decode(bytes, { stream: true })).slice(-this.config.retainedTextChars)
    this.patch({ streams: { ...this.store.getSnapshot().streams, [key]: { text, reset: previous.reset || chunk.reset,
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
   * Save server settings while retaining the original coordinator.
   * @param server - complete server settings.
   * @param password - new secret or empty to preserve it.
   */
  async saveServer(server: FleetServerInput, password: string): Promise<void> {
    this.registryRevision++
    if (password !== '') await this.remote.setPassword({ host: server.host, username: server.username, sshPort: server.sshPort,
      ...(server.passwordRef === undefined ? {} : { passwordRef: server.passwordRef }) }, password).then(unwrap)
    const registry = unwrap(await this.remote.saveServer(server))
    this.registryRevision++
    this.patch({ registry })
  }

  /**
   * Remove an unused server from future selections.
   * @param id - server removed from future selections.
   */
  async removeServer(id: string): Promise<void> {
    this.registryRevision++
    const registry = unwrap(await this.remote.removeServer(id))
    this.registryRevision++
    this.patch({ registry })
  }

  /**
   * Check SSH connectivity and report GPU and allocation facts.
   * @param id - server whose SSH and GPU inventory are checked.
   */
  async probe(id: string): Promise<void> {
    try {
      const result = unwrap(await this.remote.probeServer(id))
      const { [id]: _previous, ...probeErrors } = this.store.getSnapshot().probeErrors
      this.patch({ probes: { ...this.store.getSnapshot().probes, [id]: result }, probeErrors })
    } catch (error) {
      const { [id]: _previous, ...probes } = this.store.getSnapshot().probes
      this.patch({ probes, probeErrors: { ...this.store.getSnapshot().probeErrors, [id]: String(error) } })
      throw error
    }
  }

  /**
   * Persist an independent experiment before beginning asynchronous preparation.
   * @param objective - experiment goal.
   * @param serverIds - joint participants.
   * @param files - local data paths.
   * @param uploads - browser attachments.
   * @param id - stable id reused for retries.
   */
  async create(objective: string, serverIds: string[], files: string[], uploads: File[], id: string): Promise<void> {
    for (const file of uploads) {
      let offset = 0
      do {
        const bytes = new Uint8Array(await file.slice(offset, offset + 65536).arrayBuffer())
        const data = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''))
        const result = unwrap(await this.remote.uploadExperimentInput(id, file.name, offset, data))
        offset = result.nextOffset
      } while (offset < file.size)
    }
    const row = unwrap(await this.remote.createExperiment({ experimentId: id, objective, serverIds, files,
      uploads: uploads.map(file => file.name) }))
    this.replace(row)
    this.select(id)
  }

  /**
   * Cancel the saved experiment while retaining unconfirmed allocations.
   * @param id - experiment whose cancellation is recorded remotely.
   */
  async cancel(id: string): Promise<void> { this.replace(unwrap(await this.remote.cancelExperiment(id))) }

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

  /** Poll only while the experiment page is visible. */
  tick(): void { if (this.visible) void this.refresh() }

  /** Stop applying late replies after the plugin is unloaded. */
  dispose(): void { this.disposed = true; this.visible = false; this.decoders.clear() }
}
