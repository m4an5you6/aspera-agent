/** Host-owned serving recovery leaves the original training, terminal receipt and fixed release unchanged. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { acceptanceRecoverySchema, acceptanceRecoveryIdSchema, checkAcceptanceRecovery } from '@aspera/experiments'
import type { AcceptanceRecovery, AcceptanceSource, AcceptanceRecoveryObservation, CompletionReview, ExperimentId, CompletionIssue } from '@aspera/experiments'
import type { FleetExperiment } from './types.ts'

/** Recovery work and final acceptance remain owned by their existing services. */
export interface AcceptanceRecoveryOwner {
  get(id: ExperimentId): FleetExperiment
  alive(id: ExperimentId): boolean
  candidates(id: ExperimentId): FleetExperiment[]
  source(original: FleetExperiment, recovery: FleetExperiment, signal: AbortSignal): Promise<AcceptanceSource>
  observe(recovery: FleetExperiment, source: AcceptanceSource, signal: AbortSignal): Promise<AcceptanceRecoveryObservation>
  evidence(original: FleetExperiment, operation: AcceptanceRecovery, observation: AcceptanceRecoveryObservation, signal: AbortSignal): Promise<{ path: string; sha256: string }>
  review(id: ExperimentId): CompletionReview
  reviewStatus(id: ExperimentId): CompletionReview | undefined
  createRuntime?(original: FleetExperiment, previous: FleetExperiment, runtimeId: ExperimentId, source: AcceptanceSource, signal: AbortSignal): Promise<void>
  changed(): void
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Independent version-1 recovery records associate existing inference work with its trained original. */
export class AcceptanceRecoveries {
  private readonly records = new Map<ExperimentId, AcceptanceRecovery>()
  private readonly jobs = new Map<ExperimentId, { abort: AbortController; done: Promise<void> }>()
  private readonly requests = new Map<ExperimentId, { recoveryId?: ExperimentId; abort: AbortController; done: Promise<AcceptanceRecovery> }>()
  private chain: Promise<void> = Promise.resolve()
  private closing = false
  /** @param root - private recovery journal. @param owner - scoped reads and existing review service. @param intervalMs - configured Host observation interval. @param reconnectMs - consecutive read-timeout recovery budget. */
  constructor(private readonly root: string, private readonly owner: AcceptanceRecoveryOwner, private readonly intervalMs: number,
    private readonly reconnectMs: number) {
    if (existsSync(root)) for (const name of readdirSync(root).filter(value => value.endsWith('.v1.json'))) {
      const row = acceptanceRecoverySchema.parse(JSON.parse(readFileSync(resolve(root, name), 'utf8')))
      if (name !== row.experimentId + '.v1.json') throw new Error('Acceptance recovery file identity differs')
      this.records.set(row.experimentId, row)
    }
  }
  private save(row: AcceptanceRecovery): Promise<void> {
    const operation = this.chain.then(async () => {
      if (!this.owner.alive(row.experimentId)) throw new Error('Original acceptance recovery was deleted')
      const parsed = acceptanceRecoverySchema.parse(row)
      mkdirSync(this.root, { recursive: true, mode: 0o700 })
      await writeFileAtomic(resolve(this.root, row.experimentId + '.v1.json'), JSON.stringify(parsed) + '\n', { mode: 0o600 })
      if (!this.owner.alive(row.experimentId)) { rmSync(resolve(this.root, row.experimentId + '.v1.json'), { force: true }); throw new Error('Original acceptance recovery was deleted') }
      this.records.set(row.experimentId, parsed); this.owner.changed()
    })
    this.chain = operation.then(() => {}, () => {}); return operation
  }
  /** @param id - original experiment. @returns saved association and its original observation time, without remote reads. */
  status(id: ExperimentId): AcceptanceRecovery | undefined { const row = this.records.get(id); return row === undefined ? undefined : structuredClone(row) }
  /** @param id - execution identity. @returns whether this runtime belongs beneath an original detail page. */
  ownsRuntime(id: ExperimentId): boolean { return [...this.records.values()].some(row => row.managedRuntimes.includes(id)) }
  /** @param id - recovery runtime. @returns its original task while that local association remains present. */
  parentOf(id: ExperimentId): ExperimentId | undefined { return [...this.records.values()].find(row => row.managedRuntimes.includes(id))?.experimentId }
  private async beginRuntime(row: AcceptanceRecovery, signal: AbortSignal): Promise<AcceptanceRecovery> {
    if (this.owner.createRuntime === undefined) { this.start(row.experimentId); return this.status(row.experimentId)! }
    const previous = this.owner.get(row.recoveryExperimentId), outcome = previous.latest ?? previous.receipt
    if (outcome?.state !== 'blocked' || !outcome.resourcesReleased || outcome.services.some(service => !service.released)) throw new Error('Previous inference recovery must be blocked with all resources released before another recovery runtime')
    const runtimeId = row.pendingRuntimeId ?? acceptanceRecoverySchema.shape.experimentId.parse(randomUUID())
    const next = { ...row, pendingRuntimeId: runtimeId, managedRuntimes: row.managedRuntimes.includes(runtimeId) ? row.managedRuntimes : [...row.managedRuntimes, runtimeId],
      phase: 'recovering' as const, detail: 'Preparing an inference-only recovery runtime beneath the original task; retained training is not restarted.',
      services: [], revision: row.revision + 1, updatedAt: Date.now() }
    await this.save(next)
    try { await this.owner.createRuntime(this.original(next), previous, runtimeId, row.source, signal) }
    catch (error) {
      if (!this.closing && this.owner.alive(row.experimentId)) await this.save({ ...next, phase: 'blocked', detail: String(error), revision: next.revision + 1, updatedAt: Date.now() })
      throw error
    }
    signal.throwIfAborted()
    this.start(row.experimentId); return this.status(row.experimentId)!
  }
  private original(row: AcceptanceRecovery): FleetExperiment {
    const original = this.owner.get(row.experimentId), outcome = original.latest ?? original.receipt
    if (hash(original.submission) !== row.source.submissionHash || outcome?.revision !== row.source.resultRevision
      || outcome.plan?.revision !== row.source.planRevision || outcome.sessionId !== row.source.executionSessionId || !outcome.resourcesReleased) throw new Error('Original trained result or release changed')
    const recovery = this.owner.get(row.recoveryExperimentId)
    if (hash(recovery.submission) !== row.recoverySubmissionHash || recovery.submission?.deploymentId !== row.recoveryDeploymentId) throw new Error('Recovery fixed submission changed')
    return original
  }
  private async observation(row: AcceptanceRecovery, signal: AbortSignal): Promise<AcceptanceRecoveryObservation> {
    let deadline: number | undefined
    for (;;) {
      if (deadline !== undefined && Date.now() >= deadline) throw new Error('Recovery observation connection recovery budget exhausted; remote work remains unchanged')
      const attempt = deadline === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))])
      try {
        const value = await this.owner.observe(this.owner.get(row.recoveryExperimentId), row.source, attempt)
        if (value.experimentId !== row.recoveryExperimentId || value.submissionHash !== row.recoverySubmissionHash
          || value.deploymentId !== row.recoveryDeploymentId) throw new Error('Observed inference recovery has another execution or fixed release identity')
        return value
      } catch (error) {
        if (signal.aborted || !(error instanceof Error) || error.name !== 'TimeoutError') throw error
        deadline ??= Date.now() + this.reconnectMs
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('Recovery observation connection recovery budget exhausted; remote work remains unchanged', { cause: error })
        await delay(Math.min(this.intervalMs, remaining), undefined, { signal })
      }
    }
  }
  /** @param id - selected trained original. @param recoveryId - optional existing inference task. @returns its saved association; never starts another experiment or training. */
  request(id: ExperimentId, recoveryId?: ExperimentId): Promise<AcceptanceRecovery> {
    const pending = this.requests.get(id)
    if (pending !== undefined) {
      if (recoveryId !== undefined && pending.recoveryId !== undefined && recoveryId !== pending.recoveryId) return Promise.reject(new Error('Acceptance recovery request already selects another runtime'))
      return pending.done
    }
    const abort = new AbortController(), done = this.beginRequest(id, recoveryId, abort.signal).finally(() => { this.requests.delete(id) })
    this.requests.set(id, { ...(recoveryId === undefined ? {} : { recoveryId }), abort, done }); return done
  }
  private async beginRequest(id: ExperimentId, recoveryId: ExperimentId | undefined, signal: AbortSignal): Promise<AcceptanceRecovery> {
    if (this.closing) throw new Error('Acceptance recovery is closing')
    const before = this.status(id)
    if (before !== undefined) {
      if (recoveryId !== undefined && before.recoveryExperimentId !== recoveryId) throw new Error('Original acceptance already has another recovery execution')
      this.original(before)
      if (this.jobs.has(id) || before.phase === 'passed') return before
      const previous = this.owner.get(before.recoveryExperimentId)
      if (this.owner.createRuntime !== undefined && (before.pendingRuntimeId !== undefined || (previous.latest ?? previous.receipt)?.state === 'blocked')) return this.beginRuntime(before, signal)
      await this.save({ ...before, phase: 'recovering', detail: undefined, updatedAt: Date.now(), revision: before.revision + 1 })
      this.start(id); return this.status(id)!
    }
    const original = this.owner.get(id), result = original.latest ?? original.receipt
    if (result === undefined || !['blocked', 'failed'].includes(result.state) || !result.resourcesReleased) throw new Error('Only a released trained result can recover acceptance')
    const candidates = recoveryId === undefined ? this.owner.candidates(id) : [this.owner.get(recoveryId)]
    const errors: string[] = []
    for (const recovery of candidates) {
      const related = recovery.latest ?? recovery.receipt
      if (recovery.request.experimentId === id || recovery.submission?.protocol !== 4 || related?.plan?.workload !== 'inference'
        || ['cancelled', 'interrupted', 'failed'].includes(related.state)
        || [...recovery.request.serverIds].sort().join() !== [...original.request.serverIds].sort().join()) continue
      try {
        const source = await this.owner.source(original, recovery, signal)
        signal.throwIfAborted()
        if (this.records.has(id)) return this.beginRequest(id, recovery.request.experimentId, signal)
        const now = Date.now(), row = acceptanceRecoverySchema.parse({ version: 1, experimentId: id,
          operationId: acceptanceRecoveryIdSchema.parse(randomUUID()), source, recoveryExperimentId: recovery.request.experimentId,
          recoverySubmissionHash: hash(recovery.submission), recoveryDeploymentId: recovery.submission.deploymentId,
          phase: 'recovering', recoveryState: related.state, services: [], managedRuntimes: [], revision: 0, createdAt: now, updatedAt: now })
        await this.save(row)
        if (this.owner.createRuntime !== undefined && related.state === 'blocked') return this.beginRuntime(row, signal)
        this.start(id); return this.status(id)!
      } catch (error) {
        if (this.records.has(id)) throw error
        errors.push(recovery.request.experimentId + ': ' + String(error))
      }
    }
    throw new Error('No existing inference recovery has a verified snapshot of this original checkpoint. ' + errors.join('\n'))
  }
  private start(id: ExperimentId): void {
    if (this.closing || this.jobs.has(id)) return
    const abort = new AbortController()
    const done = Promise.resolve().then(async () => {
      while (!abort.signal.aborted) {
        try {
          let row = this.status(id)!, original = this.original(row)
          if (row.pendingRuntimeId !== undefined) {
            const runtime = this.owner.get(row.pendingRuntimeId)
            if (runtime.submission === undefined) {
              await this.save({ ...row, phase: runtime.state === 'failed' || runtime.state === 'cancelled' ? 'blocked' : 'recovering',
                recoveryState: runtime.state === 'failed' ? 'failed' : runtime.state === 'cancelled' ? 'cancelled' : 'preparing',
                detail: runtime.detail ?? 'Preparing inference recovery: ' + (runtime.preparation?.stage ?? runtime.state), updatedAt: Date.now(), revision: row.revision + 1 })
              if (runtime.state === 'failed' || runtime.state === 'cancelled') return
              await delay(this.intervalMs, undefined, { signal: abort.signal }); continue
            }
            row = { ...row, recoveryExperimentId: row.pendingRuntimeId, pendingRuntimeId: undefined,
              recoverySubmissionHash: hash(runtime.submission), recoveryDeploymentId: runtime.submission.deploymentId,
              reviewOperationId: undefined, evidencePath: undefined, evidenceHash: undefined, revision: row.revision + 1, updatedAt: Date.now() }
            await this.save(row)
          }
          const runtime = this.owner.get(row.recoveryExperimentId), current = runtime.latest ?? runtime.receipt
          if (current === undefined || ['preparing', 'planning', 'awaiting-approval', 'waiting-reply', 'queued', 'starting'].includes(current.state)) {
            await this.save({ ...row, phase: 'recovering', detail: current?.detail ?? 'Inference recovery: ' + (current?.state ?? runtime.state),
              recoveryState: current?.state ?? 'preparing', updatedAt: Date.now(), revision: row.revision + 1 })
            await delay(this.intervalMs, undefined, { signal: abort.signal }); continue
          }
          const observation = await this.observation(row, abort.signal)
          abort.signal.throwIfAborted(); this.original(row)
          const checked = checkAcceptanceRecovery(row.source, observation)
          row = { ...row, recoveryState: observation.state, services: observation.services, detail: checked.issues.join('\n') || undefined,
            updatedAt: Date.now(), revision: row.revision + 1, phase: checked.blocked ? 'blocked' : checked.ready ? 'verifying' : 'recovering' }
          await this.save(row)
          if (checked.blocked) return
          if (checked.ready) {
            if (row.evidencePath === undefined || this.owner.reviewStatus(id)?.phase === 'passed') {
              const currentSource = await this.owner.source(original, this.owner.get(row.recoveryExperimentId), abort.signal)
              if (hash(currentSource) !== hash(row.source)) throw new Error('Original native checkpoint changed before acceptance recovery')
            }
            if (row.evidencePath === undefined) {
              const evidence = await this.owner.evidence(original, row, observation, abort.signal)
              row = { ...row, evidencePath: evidence.path, evidenceHash: evidence.sha256, revision: row.revision + 1, updatedAt: Date.now() }; await this.save(row)
            }
            abort.signal.throwIfAborted()
            const review = row.reviewOperationId === undefined ? this.owner.review(id) : this.owner.reviewStatus(id)
            if (review === undefined) throw new Error('Original completion review disappeared')
            if (row.reviewOperationId !== undefined && review.operationId !== row.reviewOperationId) throw new Error('Original completion review was replaced')
            if (review.phase === 'passed' && (!review.remoteCommitted || !review.check?.ready || review.submissionHash !== row.source.submissionHash
              || review.originalRevision !== row.source.resultRevision || review.executionSessionId !== row.source.executionSessionId)) throw new Error('Original completion review is not independently committed to this trained result')
            row = { ...row, reviewOperationId: review.operationId, phase: review.phase === 'passed' ? 'passed' : review.phase === 'blocked' || review.phase === 'cancelled' ? 'blocked' : 'reviewing',
              detail: review.detail, revision: row.revision + 1, updatedAt: Date.now() }; await this.save(row)
            if (['passed', 'blocked'].includes(row.phase)) return
          }
        } catch (error) {
          if (abort.signal.aborted || !this.owner.alive(id)) return
          const row = this.status(id)!
          await this.save({ ...row, phase: 'blocked', detail: String(error), updatedAt: Date.now(), revision: row.revision + 1 }); return
        }
        await delay(this.intervalMs, undefined, { signal: abort.signal })
      }
    }).catch((error: unknown) => { if (!abort.signal.aborted) throw error }).finally(() => { this.jobs.delete(id) })
    this.jobs.set(id, { abort, done })
    void done.catch(error => {
      // A failed disk write cannot be acknowledged as durable, but its stopped work must remain visible.
      const row = this.records.get(id)
      if (row !== undefined && this.owner.alive(id)) { this.records.set(id, { ...row, phase: 'blocked', detail: String(error) }); this.owner.changed() }
    })
  }
  /** @param id - original task. @param signal - verification lifetime. @returns program observations required in addition to original training and step evidence. */
  async serviceIssues(id: ExperimentId, signal: AbortSignal): Promise<CompletionIssue[]> {
    const row = this.status(id)
    if (row === undefined) return [{ code: 'results', detail: 'Public-serving recovery is not associated with this original experiment.', remedy: 'Request acceptance recovery for the original trained task.' }]
    this.original(row)
    const observation = await this.observation(row, signal)
    const check = checkAcceptanceRecovery(row.source, observation)
    return check.issues.map(detail => ({ code: 'results' as const, detail, remedy: 'Continue the existing inference recovery; do not retrain or replace original evidence.' }))
  }
  /** Resume observations after Host restart; original execution Goals remain stopped. */
  resume(): void {
    for (const row of this.records.values()) if (['recovering', 'verifying', 'reviewing'].includes(row.phase) && this.owner.alive(row.experimentId)) {
      if (row.pendingRuntimeId !== undefined) void this.request(row.experimentId).catch(error => {
        const current = this.records.get(row.experimentId)
        if (current !== undefined && this.owner.alive(row.experimentId)) { this.records.set(row.experimentId, { ...current, phase: 'blocked', detail: String(error) }); this.owner.changed() }
      })
      else this.start(row.experimentId)
    }
  }
  /** @param id - original task being deleted. @returns after all pending writes stop; related inference remains separately owned. */
  async forget(id: ExperimentId): Promise<void> {
    const request = this.requests.get(id); request?.abort.abort(); await request?.done.catch(error => { /* Deletion waits for cancelled creation and submitted writes. */ void error })
    const job = this.jobs.get(id); job?.abort.abort(); await job?.done; await this.chain
    this.records.delete(id); rmSync(resolve(this.root, id + '.v1.json'), { force: true })
  }
  /** @returns after observations and already submitted journal writes stop; no remote work is cancelled. */
  async close(): Promise<void> {
    this.closing = true
    for (const request of this.requests.values()) request.abort.abort()
    for (const job of this.jobs.values()) job.abort.abort()
    await Promise.allSettled([...this.requests.values()].map(request => request.done))
    await Promise.all([...this.jobs.values()].map(job => job.done)); await this.chain
  }
}
