/** Durable FIFO scheduling of whole server groups. Long execution never holds the scheduling lock. */
import { createHash } from 'node:crypto'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { CLUSTER_HANDOVER, clusterSubmissionSchema } from './cluster-protocol.ts'
import type { ClusterRecord, ClusterSubmission, ExperimentId, ExperimentServerId } from './cluster-protocol.ts'

/** Execution outcome; unavailable cleanup retains the complete allocation. */
export interface ClusterOutcome {
  state: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'interrupted'
  resourcesReleased: boolean
  detail?: string | undefined
}

/** Runtime adapter owning remote processes and post-crash reconciliation. */
export interface ClusterExecutor {
  /**
   * @param record - allocated immutable task.
   * @param signal - cancellation intent.
   * @param started - durable Session/Goal callback.
   * @returns settled execution and cleanup facts.
   */
  run(record: ClusterRecord, signal: AbortSignal, started: (sessionId: string, goalId: string) => Promise<void>): Promise<ClusterOutcome>
  /**
   * Confirm all managed resources are released before freeing the allocation.
   * @param record - previously allocated task.
   * @returns whether every node has confirmed cleanup.
   */
  reconcile(record: ClusterRecord): Promise<boolean>
}

/** Atomic scheduling decisions are represented by one durable experiment record. */
export class ClusterQueue {
  private chain: Promise<void> = Promise.resolve()
  private readonly active = new Map<ExperimentId, { abort: AbortController; done: Promise<void> }>()
  private closing = false
  private pumping: Promise<void> | undefined
  private pumpAgain = false

  constructor(private readonly table: KvTable<ExperimentId, ClusterRecord>, private readonly executor: ClusterExecutor,
    private readonly reportError: (error: unknown) => void) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => {}, () => {})
    return result
  }

  private async save(record: ClusterRecord, patch: Partial<ClusterRecord>): Promise<ClusterRecord> {
    const next = { ...record, ...patch, revision: record.revision + 1, updatedAt: Date.now() }
    await this.table.put(record.submission.experimentId, next)
    return next
  }

  /**
   * Read experiments in durable admission order.
   * @returns saved experiments in admission order.
   */
  list(): ClusterRecord[] { return [...this.table.entries()].map(([, record]) => record).sort((a, b) => a.sequence - b.sequence) }

  /**
   * Find a durable scheduling record by experiment identity.
   * @param id - immutable submission identity.
   * @returns saved receipt, when present.
   */
  get(id: ExperimentId): ClusterRecord | undefined { return this.table.get(id) }

  private required(id: ExperimentId): ClusterRecord {
    const record = this.table.get(id)
    if (record === undefined) throw new Error('allocated experiment record is missing')
    return record
  }

  /** Recover queued work while never replaying an ambiguous execution. */
  async recover(): Promise<void> {
    for (const record of this.list()) {
      if (record.resourcesReleased) continue
      let released = false
      try { released = await this.executor.reconcile(record) } catch (error) { this.reportError(error) }
      await this.save(record, { state: 'interrupted', resourcesReleased: released,
        detail: released ? 'Execution was interrupted; submit a new experiment to retry.' : 'Node cleanup is unconfirmed; its allocation remains occupied.' })
    }
    this.kick()
  }

  /**
   * Persist ownership before scheduling the requested server group.
   * @param raw - receiver request.
   * @returns durable ownership receipt, including for identical retries.
   */
  async submit(raw: unknown): Promise<ClusterRecord> {
    const submission = clusterSubmissionSchema.parse(raw)
    const payloadHash = createHash('sha256').update(JSON.stringify(submission)).digest('hex')
    const record = await this.serial(async () => {
      if (this.closing) throw new Error('coordinator is stopping')
      const previous = this.table.get(submission.experimentId)
      if (previous !== undefined) {
        if (previous.payloadHash !== payloadHash) throw new Error('experiment id is already bound to different requirements')
        return previous
      }
      const last = this.list().at(-1)
      const created: ClusterRecord = { submission, payloadHash, sequence: (last?.sequence ?? -1) + 1,
        revision: 1, state: 'queued', resourcesReleased: true, updatedAt: Date.now(), handover: CLUSTER_HANDOVER }
      await this.table.put(submission.experimentId, created)
      return created
    })
    this.kick()
    return record
  }

  /**
   * Report earlier allocations and queued tasks sharing selected servers.
   * @param id - submitted experiment.
   * @returns server ids that precede this task in a node queue.
   */
  waitingFor(id: ExperimentId): ExperimentServerId[] {
    const record = this.table.get(id)
    if (record?.state !== 'queued') return []
    const earlier = this.list().filter(other => !other.resourcesReleased || (other.state === 'queued' && other.sequence < record.sequence))
    return record.submission.nodes.map(node => node.server.id).filter(serverId =>
      earlier.some(other => other.submission.nodes.some(node => node.server.id === serverId)))
  }

  private kick(): void {
    if (this.closing) return
    if (this.pumping !== undefined) { this.pumpAgain = true; return }
    this.pumping = this.serial(async () => {
      const unavailable = new Set<ExperimentServerId>()
      for (const record of this.list()) {
        if (!record.resourcesReleased) for (const node of record.submission.nodes) unavailable.add(node.server.id)
      }
      for (const record of this.list()) {
        if (record.state !== 'queued') continue
        const ids = record.submission.nodes.map(node => node.server.id)
        const available = ids.every(id => !unavailable.has(id))
        for (const id of ids) unavailable.add(id)
        if (!available || this.closing) continue
        const allocated = await this.save(record, { state: 'starting', resourcesReleased: false })
        const abort = new AbortController()
        const done = Promise.resolve().then(() => this.execute(allocated, abort.signal))
        this.active.set(record.submission.experimentId, { abort, done })
      }
    }).catch(this.reportError).finally(() => {
      this.pumping = undefined
      if (this.pumpAgain) { this.pumpAgain = false; this.kick() }
    })
  }

  private async execute(record: ClusterRecord, signal: AbortSignal): Promise<void> {
    const id = record.submission.experimentId
    try {
      let outcome: ClusterOutcome
      try {
        outcome = await this.executor.run(record, signal, (sessionId, goalId) => this.serial(async () => {
          const current = this.required(id)
          await this.save(current, { sessionId, goalId, state: current.state === 'cancelling' ? 'cancelling' : 'running' })
        }))
      } catch (error) {
        let released = false
        try { released = await this.executor.reconcile(record) } catch (cleanupError) { this.reportError(cleanupError) }
        outcome = { state: signal.aborted ? 'cancelled' : 'failed', resourcesReleased: released, detail: String(error) }
      }
      await this.serial(async () => {
        const current = this.required(id)
        await this.save(current, { ...outcome,
          state: current.state === 'cancelling' && outcome.resourcesReleased ? 'cancelled' : outcome.state })
      })
    } catch (error) { this.reportError(error) }
    finally { this.active.delete(id); this.kick() }
  }

  /**
   * Cancel the saved experiment while retaining unconfirmed allocations.
   * @param id - experiment to stop.
   * @param submission - pinned request used to cancel an uncertain admission.
   * @returns durable cancellation state; occupied nodes remain reserved until cleanup settles.
   */
  async cancel(id: ExperimentId, submission?: ClusterSubmission): Promise<ClusterRecord> {
    const result = await this.serial(async () => {
      const record = this.table.get(id)
      if (record === undefined) {
        if (submission === undefined || submission.experimentId !== id) throw new Error('experiment not found')
        const saved: ClusterRecord = { submission, payloadHash: createHash('sha256').update(JSON.stringify(submission)).digest('hex'),
          sequence: (this.list().at(-1)?.sequence ?? -1) + 1, revision: 1, state: 'cancelled', resourcesReleased: true,
          updatedAt: Date.now(), handover: CLUSTER_HANDOVER }
        await this.table.put(id, saved)
        return saved
      }
      if (submission !== undefined && record.payloadHash !== createHash('sha256').update(JSON.stringify(submission)).digest('hex')) throw new Error('cancellation requirements do not match the saved experiment')
      if (record.state === 'queued') return this.save(record, { state: 'cancelled' })
      if (!record.resourcesReleased) {
        const next = await this.save(record, { state: 'cancelling' })
        this.active.get(id)?.abort.abort(new Error('experiment cancelled'))
        return next
      }
      return record
    })
    if (result.state === 'cancelling' && !this.active.has(id)) {
      let released = false
      try { released = await this.executor.reconcile(result) } catch (error) { this.reportError(error) }
      await this.serial(async () => {
        await this.save(this.required(id), { state: released ? 'cancelled' : 'cancelling', resourcesReleased: released })
      })
    }
    this.kick()
    return this.required(id)
  }

  /** Stop admission, then await owned execution cleanup. Queued work remains durable. */
  async close(): Promise<void> {
    this.closing = true
    await this.chain
    for (const active of this.active.values()) active.abort.abort(new Error('coordinator stopped'))
    await Promise.all([...this.active.values()].map(active => active.done))
    await this.chain
  }
}
