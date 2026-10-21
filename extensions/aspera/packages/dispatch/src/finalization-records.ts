/** Local copies of finalization observations are independent from remote experiment outcomes. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { experimentFinalizationStatusSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentFinalizationStatus } from '@aspera/experiments'
import type { FleetExperiment } from './types.ts'
import { redactObservation } from '@aspera/runtime'

/** One Host owns source reads and the deletion lifetime; a page only requests observations. */
export class FinalizationRecords {
  private readonly jobs = new Map<ExperimentId, { abort: AbortController; done: Promise<ExperimentFinalizationStatus> }>()
  private closing = false
  /** @param root - local experiment archive root. @param owner - original identity, read provider and tombstones. */
  constructor(private readonly root: string, private readonly owner: {
    get(id: ExperimentId): FleetExperiment; alive(id: ExperimentId): boolean
    read(record: FleetExperiment, signal: AbortSignal): Promise<unknown>
  }) {}
  private path(id: ExperimentId): string { return resolve(this.root, id, 'finalization.v1.json') }
  /** @param id - retained experiment. @returns the last observation with its original measurement time. */
  cached(id: ExperimentId): ExperimentFinalizationStatus | undefined {
    if (!existsSync(this.path(id))) return undefined
    const value = experimentFinalizationStatusSchema.parse(JSON.parse(readFileSync(this.path(id), 'utf8')))
    if (value.experimentId !== id) throw new Error('Local finalization copy belongs to another experiment')
    return value
  }
  /** @param id - retained experiment. @returns a fresh journal observation or an explicitly offline copy. */
  read(id: ExperimentId): Promise<ExperimentFinalizationStatus> {
    if (this.closing || !this.owner.alive(id)) return Promise.reject(new Error('Finalization observation was stopped or deleted'))
    const existing = this.jobs.get(id)
    if (existing !== undefined) return existing.done
    const record = this.owner.get(id), abort = new AbortController()
    const done = (async () => {
      try {
        const observed = experimentFinalizationStatusSchema.parse(await this.owner.read(record, abort.signal))
        abort.signal.throwIfAborted()
        const original = record.latest ?? record.receipt, sessionId = original?.sessionId ?? `aspera-execution-${id}`
        if (!this.owner.alive(id) || observed.experimentId !== id
          || observed.waits.some(wait => !record.submission?.nodes.some(node => node.server.id === wait.serverId))
          || observed.stages.some(stage => !record.submission?.nodes.some(node => node.server.id === stage.serverId)
            || stage.experimentId !== id || stage.sessionId !== sessionId || stage.planRevision !== original?.plan?.revision)
          || observed.waits.some(wait => wait.experimentId !== id)
          || observed.decision !== undefined && (observed.decision.experimentId !== id || observed.decision.sessionId !== sessionId)) throw new Error('Finalization source ownership changed or the experiment was deleted')
        mkdirSync(resolve(this.root, id), { recursive: true, mode: 0o700 })
        const temporary = resolve(this.root, id, randomUUID() + '.incoming'), fd = openSync(temporary, 'wx', 0o600)
        try { writeFileSync(fd, JSON.stringify(observed) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
        if (!this.owner.alive(id)) { rmSync(temporary, { force: true }); throw new Error('Experiment was deleted during finalization observation') }
        renameSync(temporary, this.path(id)); return observed
      } catch (error) {
        abort.signal.throwIfAborted()
        if (!this.owner.alive(id)) throw error
        const cached = this.cached(id)
        if (cached !== undefined) return { ...cached, offline: true, error: redactObservation(String(error)) }
        throw error
      }
    })().finally(() => { this.jobs.delete(id) })
    this.jobs.set(id, { abort, done }); return done
  }
  /** @param id - task being deleted. @returns after reads stop; late replies cannot restore the local copy. */
  async forget(id: ExperimentId): Promise<void> {
    const job = this.jobs.get(id); job?.abort.abort(new Error('Experiment deleted'))
    if (job !== undefined) await job.done.catch(error => { void error })
    rmSync(this.path(id), { force: true })
  }
  /** Abort reads and await their writes before Host shutdown. */
  async close(): Promise<void> {
    this.closing = true
    const jobs = [...this.jobs.values()]
    for (const job of jobs) job.abort.abort(new Error('Host closed'))
    await Promise.allSettled(jobs.map(job => job.done))
  }
}
