/** Host-owned interruption work persists before mutation and survives page navigation. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { experimentInterruptionSchema, interruptionIdSchema } from '@aspera/experiments'
import type { ClusterRecord, ExperimentId, ExperimentInterruptionStatus } from '@aspera/experiments'
import { redactObservation } from '@aspera/runtime'
import { SshConnectionError } from '@aspera/runtime/transport'
import type { FleetExperiment } from './types.ts'

/** Original connections and submission identity, available independently of an experiment's visible record. */
export type InterruptionTask = Pick<FleetExperiment, 'coordinator' | 'coordinatorTarget' | 'servers' | 'targets' | 'submission'> & {
  request: Pick<FleetExperiment['request'], 'experimentId' | 'name'>
  submissionHash?: string
}

/** Transport and record updates stay in the fleet, which owns all credentials and fixed destinations. */
export interface InterruptionOwner {
  /** @param id - experiment. @returns its fixed submission and assigned servers. */
  get(id: ExperimentId): InterruptionTask
  /** @param id - experiment. @returns whether writes are still permitted. */
  alive(id: ExperimentId): boolean
  /** @param record - original experiment. @param status - committed operation. @param signal - bounded lifetime.
   * @param update - persist measured node progress. @returns the confirmed terminal record, or undefined for local preparation.
   */
  settle(record: InterruptionTask, status: ExperimentInterruptionStatus, signal: AbortSignal,
    update: (status: ExperimentInterruptionStatus) => void): Promise<ClusterRecord | undefined>
  /** @param id - experiment. @param result - owned terminal result. @returns after record publication. */
  accept(id: ExperimentId, result: ClusterRecord | undefined): Promise<void>
  /** Publish an interruption journal change to snapshot consumers. */
  changed(): void
  /** @param error - failed local persistence or teardown. */
  report(error: unknown): void
}

/** Version-1 journals are retained until the experiment is deleted. */
export class ExperimentInterruptions {
  private readonly journals = new Map<ExperimentId, ExperimentInterruptionStatus>()
  private readonly work = new Map<ExperimentId, { abort: AbortController; done: Promise<void> }>()
  private closing = false

  /** @param root - dedicated local journal directory. @param owner - authenticated fleet operations. @param timeoutMs - resolves one finite attempt deadline from the saved deployment. */
  constructor(private readonly root: string, private readonly owner: InterruptionOwner, private readonly timeoutMs: (record: InterruptionTask) => number) {
    if (!existsSync(root)) return
    if (lstatSync(root).isSymbolicLink()) throw new Error('Interruption directory is a symbolic link')
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.v1.json')) continue
      const path = resolve(root, name)
      if (lstatSync(path).isSymbolicLink()) throw new Error('Interruption receipt is a symbolic link')
      const status = experimentInterruptionSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      if (name !== `${status.experimentId}.v1.json`) throw new Error('Interruption receipt has another experiment identity')
      if (!owner.alive(status.experimentId)) continue
      const record = owner.get(status.experimentId)
      if (status.submissionHash !== this.hash(record) || status.nodes.length !== record.servers.length
        || record.servers.some(server => !status.nodes.some(node => node.serverId === server.id))) throw new Error('Interruption receipt differs from its original submission or nodes')
      this.journals.set(status.experimentId, status)
    }
  }

  private hash(record: InterruptionTask): string {
    return record.submissionHash ?? createHash('sha256').update(JSON.stringify(record.submission ?? record.request)).digest('hex')
  }
  private save(status: ExperimentInterruptionStatus): void {
    if (!this.owner.alive(status.experimentId)) return
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    if (lstatSync(this.root).isSymbolicLink()) throw new Error('Interruption directory is a symbolic link')
    const path = resolve(this.root, `${status.experimentId}.v1.json`)
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Interruption receipt is a symbolic link')
    const incoming = `${path}.${randomUUID()}.incoming`
    const fd = openSync(incoming, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(status) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(incoming, path)
    this.journals.set(status.experimentId, structuredClone(status)); this.owner.changed()
  }

  /** @param id - experiment. @returns a committed copy without remote reads or mutations. */
  status(id: ExperimentId): ExperimentInterruptionStatus | undefined {
    const status = this.owner.alive(id) ? this.journals.get(id) : undefined
    return status === undefined ? undefined : structuredClone(status)
  }
  /** @returns all retained operation progress for the fleet snapshot. */
  list(): ExperimentInterruptionStatus[] { return [...this.journals.keys()].flatMap(id => this.status(id) ?? []) }

  /** @param id - user-selected experiment. @returns durable acknowledgement before background stopping begins. */
  request(id: ExperimentId): ExperimentInterruptionStatus { return this.start(id, true) }

  private initial(record: InterruptionTask, stopRequested: boolean): ExperimentInterruptionStatus {
    const now = Date.now()
    return { version: 1, experimentId: record.request.experimentId, operationId: interruptionIdSchema.parse(randomUUID()),
      submissionHash: this.hash(record), reason: stopRequested ? 'user' : 'controller-recovery', stopRequested, phase: 'requested', startedAt: now, updatedAt: now,
      nodes: record.servers.map(server => ({ serverId: server.id, name: server.name, phase: 'pending', agentsExited: false,
        commandsReleased: false, servicesReleased: false, updatedAt: now })) }
  }

  /** Save a program-observed blocker without contacting or stopping unselected nodes.
   * @param id - known original experiment. @param detail - preparation scope or evidence limitation. @returns its retained manual-recovery entry.
   */
  observeBlocked(id: ExperimentId, detail: string): ExperimentInterruptionStatus {
    const record = this.owner.get(id)
    const previous = this.status(id)
    if (this.work.has(id) || previous?.phase === 'released') return previous!
    if (previous !== undefined && previous.submissionHash !== this.hash(record)) throw new Error('Interruption submission identity changed')
    const status = { ...(previous ?? this.initial(record, false)), phase: 'blocked' as const, updatedAt: Date.now(), detail: redactObservation(detail) }
    this.save(status)
    return this.status(id)!
  }

  /** @param status - program-verified remote recovery receipt. @returns after its terminal result and local journal are saved. */
  async adopt(status: ExperimentInterruptionStatus): Promise<void> {
    const record = this.owner.get(status.experimentId)
    if (status.submissionHash !== this.hash(record) || status.phase !== 'released' || status.result === undefined
      || createHash('sha256').update(JSON.stringify(status.result.submission)).digest('hex') !== status.submissionHash) throw new Error('Recovered interruption has no confirmed matching result')
    if (status.nodes.length !== record.servers.length || record.servers.some(server => !status.nodes.some(node => node.serverId === server.id && node.phase === 'released'
      && node.agentsExited && node.commandsReleased && node.servicesReleased))) throw new Error('Recovered interruption omits confirmed original nodes')
    if (this.work.has(status.experimentId)) throw new Error('Another interruption is still being reconciled')
    await this.owner.accept(status.experimentId, status.result)
    this.save(status)
  }

  /** @param id - program-selected orphan. @param signal - preparation lifetime. @returns confirmed reconciliation or an explicit blocker. */
  async recover(id: ExperimentId, signal: AbortSignal): Promise<ExperimentInterruptionStatus> {
    const existing = this.work.get(id)
    if (existing !== undefined) return this.status(id)!
    this.start(id, false, signal)
    await this.work.get(id)?.done
    return this.status(id)!
  }

  /** @param id - program-known task. @returns a durable acknowledgement for background exit verification without stopping active work. */
  reconcile(id: ExperimentId): ExperimentInterruptionStatus { return this.start(id, false) }

  private start(id: ExperimentId, stopRequested: boolean, parent?: AbortSignal): ExperimentInterruptionStatus {
    if (this.closing) throw new Error('Experiment management is stopping')
    const record = this.owner.get(id)
    const hash = this.hash(record)
    const prior = this.journals.get(id)
    if (prior !== undefined && prior.submissionHash !== hash) throw new Error('Interruption submission identity changed')
    if (this.work.has(id)) {
      if (stopRequested && prior?.stopRequested !== true) throw new Error('Exit verification is already running; wait for its result before requesting interruption')
      return this.status(id)!
    }
    if (prior?.phase === 'released') return this.status(id)!
    const now = Date.now()
    const status: ExperimentInterruptionStatus = prior === undefined ? this.initial(record, stopRequested)
      : { ...prior, phase: 'requested', updatedAt: now, stopRequested: prior.stopRequested || stopRequested }
    delete status.detail
    delete status.resumeVerification
    this.save(status)
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.timeoutMs(record)), ...(parent === undefined ? [] : [parent])])
    const update = (value: ExperimentInterruptionStatus) => {
      if (value.operationId !== status.operationId || value.experimentId !== id || value.submissionHash !== hash) throw new Error('Interruption progress has another owner')
      signal.throwIfAborted(); this.save(value)
    }
    const done = Promise.resolve().then(async () => {
      try {
        const result = await this.owner.settle(record, status, signal, update)
        signal.throwIfAborted()
        await this.owner.accept(id, result)
        if (!this.owner.alive(id)) return
        const current = this.status(id)!
        this.save({ ...current, phase: 'released', updatedAt: Date.now(), ...(result === undefined ? {} : { result }),
          nodes: current.nodes.map(node => ({ ...node, phase: 'released', detail: undefined, agentsExited: true, commandsReleased: true, servicesReleased: true })) })
      } catch (error) {
        if (!this.owner.alive(id)) return
        const current = this.status(id)!
        const blocked: ExperimentInterruptionStatus = { ...current, phase: 'blocked', resumeVerification: signal.aborted || error instanceof SshConnectionError,
          updatedAt: Date.now(), detail: redactObservation(String(error)),
          nodes: current.nodes.map(node => node.phase === 'released' ? node : { ...node, phase: 'blocked' }) }
        try { this.save(blocked) }
        catch (storageError) {
          this.journals.set(id, { ...blocked, detail: redactObservation(`${String(error)}; interruption journal could not be written: ${String(storageError)}`) })
          this.owner.changed(); this.owner.report(storageError)
        }
      }
    }).catch(error => { this.owner.report(error) }).finally(() => { this.work.delete(id) })
    this.work.set(id, { abort, done })
    return this.status(id)!
  }

  /** Recheck unfinished operations after Host restart without creating another operation identity. */
  resume(): void {
    for (const status of this.list()) if (status.phase !== 'released' && (status.phase !== 'blocked' || status.resumeVerification === true)) this.start(status.experimentId, status.stopRequested)
  }
  /** @param id - deleted experiment. @returns after active reads and mutations stop. */
  async stop(id: ExperimentId): Promise<void> {
    const pending = this.work.get(id)
    pending?.abort.abort(new Error('Experiment interruption stopped')); await pending?.done
  }
  /** @param id - deleted experiment. @returns after its journal is removed. */
  async forget(id: ExperimentId): Promise<void> {
    await this.stop(id); this.journals.delete(id)
    rmSync(resolve(this.root, `${id}.v1.json`), { force: true })
  }
  /** @param id - acknowledged operation. @returns after one bounded attempt settles. */
  async wait(id: ExperimentId): Promise<void> { await this.work.get(id)?.done }
  /** Abort bounded transport work, await pending writes and retain unresolved journals. */
  async close(): Promise<void> {
    this.closing = true
    for (const pending of this.work.values()) pending.abort.abort(new Error('Local dispatcher stopped'))
    await Promise.all([...this.work.values()].map(pending => pending.done))
  }
}
