/** Durable FIFO scheduling of whole server groups. Long execution never holds the scheduling lock. */
import { createHash } from 'node:crypto'
import type { ExperimentTable } from './table.ts'
import { CLUSTER_HANDOVER, clusterSubmissionSchema, experimentQuestionSchema, answerExperimentQuestionSchema, questionBindingSchema } from './cluster-protocol.ts'
import type { ClusterRecord, ClusterSubmission, ExperimentId, ExperimentServerId, ExperimentPlan, ExperimentQuestion } from './cluster-protocol.ts'

/** Execution outcome; unavailable cleanup retains the complete allocation. */
export interface ClusterOutcome {
  state: 'completed' | 'blocked' | 'failed' | 'cancelled' | 'interrupted' | 'serving' | 'awaiting-approval'
  resourcesReleased: boolean
  detail?: string | undefined
  plan?: ExperimentPlan | undefined
}

/** Runtime adapter owning remote processes and post-crash reconciliation. */
export interface ClusterExecutor {
  /**
   * @param record - allocated immutable task.
   * @param signal - cancellation intent.
   * @param started - durable Session/Goal callback.
   * @returns settled execution and cleanup facts.
   */
  run(record: ClusterRecord, signal: AbortSignal, started: (sessionId: string, goalId: string) => Promise<void>,
    update: (patch: Pick<Partial<ClusterRecord>, 'state' | 'services' | 'progress' | 'executions'>) => Promise<void>): Promise<ClusterOutcome>
  /** Prepare a read-only plan without reserving nodes. @param record - submitted task. @param signal - cancellation. @returns recorded plan and its Session. */
  prepare?(record: ClusterRecord, signal: AbortSignal): Promise<{ plan: ExperimentPlan; sessionId: string }>
  /** Observe surviving registered services without restarting commands. @param record - serving task. @param signal - observation lifetime. @param update - durable service facts. @returns cleanup outcome. */
  restore?(record: ClusterRecord, signal: AbortSignal,
    update: (patch: Pick<Partial<ClusterRecord>, 'state' | 'services' | 'progress' | 'executions'>) => Promise<void>): Promise<ClusterOutcome>
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

  constructor(private readonly table: ExperimentTable<ExperimentId, ClusterRecord>, private readonly executor: ClusterExecutor,
    private readonly reportError: (error: unknown) => void) {}

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chain.then(operation)
    this.chain = result.then(() => {}, () => {})
    return result
  }

  private async save(record: ClusterRecord, patch: Partial<ClusterRecord>): Promise<ClusterRecord> {
    const expires = patch.state !== undefined && ['cancelling', 'cancelled', 'interrupted', 'blocked', 'failed', 'completed'].includes(patch.state)
    const next = { ...record, ...patch, ...(expires && record.questions !== undefined ? {
      questions: record.questions.map(question => question.state === 'open' ? { ...question, state: 'expired' as const } : question),
    } : {}), revision: record.revision + 1, updatedAt: Date.now() }
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
      if (record.state === 'waiting-reply' || (record.submission.protocol !== 4 && ['preparing', 'queued', 'awaiting-approval'].includes(record.state))) {
        await this.save(record, { state: 'interrupted', detail: 'Execution was interrupted; questions expired. Copy the experiment to retry.' })
      }
      if (record.state === 'planning') {
        await this.save(record, { state: 'blocked', detail: 'Plan preparation was interrupted; copy the experiment to retry.' })
      }
      if (record.resourcesReleased) continue
      if (record.state === 'serving' && this.executor.restore !== undefined) {
        this.start(record, true)
        continue
      }
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
      if (submission.protocol !== 4) throw new Error('New admission requires protocol 4; legacy experiments retain their original release.')
      const last = this.list().at(-1)
      const created: ClusterRecord = { submission, payloadHash, sequence: (last?.sequence ?? -1) + 1,
        revision: 1, state: this.executor.prepare === undefined ? 'queued' : 'preparing', resourcesReleased: true,
        executions: [], services: [], updatedAt: Date.now(), handover: CLUSTER_HANDOVER }
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
      for (const record of this.list()) {
        if (record.state !== 'preparing') continue
        const planning = await this.save(record, { state: 'planning' })
        const abort = new AbortController()
        const done = Promise.resolve().then(() => this.prepare(planning, abort.signal))
        this.active.set(record.submission.experimentId, { abort, done })
      }
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
        const allocated = await this.save(record, { state: 'starting', resourcesReleased: false, startedAt: Date.now() })
        this.start(allocated)
      }
    }).catch(this.reportError).finally(() => {
      this.pumping = undefined
      if (this.pumpAgain) { this.pumpAgain = false; this.kick() }
    })
  }

  private start(record: ClusterRecord, restoring = false): void {
    const abort = new AbortController()
    const done = Promise.resolve().then(() => this.execute(record, abort.signal, restoring))
    this.active.set(record.submission.experimentId, { abort, done })
  }

  private async prepare(record: ClusterRecord, signal: AbortSignal): Promise<void> {
    const id = record.submission.experimentId
    try {
      const result = await this.executor.prepare?.(record, signal)
      if (result === undefined) throw new Error('plan provider is unavailable')
      await this.serial(async () => {
        const current = this.required(id)
        if (current.state === 'cancelled' || signal.aborted) return
        const automatic = current.submission.strategy.mode === 'automatic'
        await this.save(current, { plan: result.plan, planningSessionId: result.sessionId,
          state: automatic ? 'queued' : 'awaiting-approval',
          approval: automatic ? { planRevision: result.plan.revision, approvedAt: Date.now(), by: 'policy' } : undefined })
      })
    } catch (error) {
      await this.serial(async () => {
        const current = this.required(id)
        await this.save(current, { state: signal.aborted ? 'cancelled' : 'blocked', detail: String(error) })
      })
    } finally { this.active.delete(id); this.kick() }
  }

  /** Confirm exactly the displayed plan. Waiting for confirmation reserves no servers.
   * @param id - experiment. @param revision - displayed plan revision. @returns queued record.
   */
  async approve(id: ExperimentId, revision: number): Promise<ClusterRecord> {
    const result = await this.serial(async () => {
      const record = this.required(id)
      if (record.plan?.revision !== revision) throw new Error('plan changed; refresh before confirming')
      if (record.approval?.planRevision === revision) return record
      if (record.state !== 'awaiting-approval') throw new Error('experiment is not awaiting plan confirmation')
      return this.save(record, { state: 'queued', approval: { planRevision: revision, approvedAt: Date.now(), by: 'user' } })
    })
    this.kick()
    return result
  }

  /** Persist a tool question before the worker waits.
   * @param id - owning experiment. @param raw - bound question. @returns durable question, including identical retries.
   */
  async openQuestion(id: ExperimentId, raw: unknown): Promise<ExperimentQuestion> {
    const question = experimentQuestionSchema.parse(raw)
    return this.serial(async () => {
      const record = this.required(id)
      if (record.submission.protocol !== 4 || record.submission.strategy.mode !== 'semi') throw new Error('Human answers are unavailable for this execution policy')
      if (!this.active.has(id) || !['planning', 'starting', 'running', 'waiting-reply'].includes(record.state)) throw new Error('Experiment cannot accept a question')
      if (question.experimentId !== id || question.state !== 'open' || question.answer !== undefined || question.answeredAt !== undefined) throw new Error('Invalid new question')
      const sessionId = question.stage === 'planning' ? record.planningSessionId ?? `aspera-plan-${id}` : record.sessionId ?? `aspera-execution-${id}`
      if (question.sessionId !== sessionId || (record.state !== 'waiting-reply' && record.state !== question.stage && !(record.state === 'starting' && question.stage === 'running'))) throw new Error('Question Session or stage differs from the active experiment')
      const previous = (record.questions ?? []).find(item => item.questionId === question.questionId || (item.sessionId === question.sessionId && item.callId === question.callId))
      if (previous !== undefined) {
        if (JSON.stringify({ ...previous, state: 'open', answer: undefined, answeredAt: undefined }) !== JSON.stringify(question)) throw new Error('Question identity conflict')
        return previous
      }
      if ((record.questions ?? []).some(item => item.state === 'open')) throw new Error('An operator question is already pending')
      await this.save(record, { state: 'waiting-reply', questions: [...record.questions ?? [], question],
        ...(question.stage === 'planning' ? { planningSessionId: sessionId } : { sessionId }) })
      return question
    })
  }

  /** Persist one answer; identical retries never start another Agent.
   * @param id - owning experiment. @param raw - question revision and structured answer. @returns updated record.
   */
  async answerQuestion(id: ExperimentId, raw: unknown): Promise<ClusterRecord> {
    const input = answerExperimentQuestionSchema.parse(raw)
    return this.serial(async () => {
      const record = this.required(id)
      if (!this.active.has(id) || !['planning', 'running', 'waiting-reply'].includes(record.state)) throw new Error('Experiment is cancelled, interrupted or no longer accepting replies')
      const question = (record.questions ?? []).find(item => item.questionId === input.questionId)
      if (question === undefined || question.state === 'expired' || question.revision !== input.revision || question.sessionId !== input.sessionId || question.callId !== input.callId) throw new Error('Question expired or its binding changed')
      if (question.answer !== undefined) {
        if (JSON.stringify(question.answer) !== JSON.stringify(input.answer)) throw new Error('A different answer is already saved')
        return record
      }
      const ids = new Set(input.answer.answers.map(answer => answer.id))
      if (ids.size !== input.answer.answers.length || question.questions.length !== ids.size || !question.questions.every(item => ids.has(item.id))) throw new Error('Answer must name each question exactly once')
      for (const answer of input.answer.answers) {
        const item = question.questions.find(item => item.id === answer.id)!
        if ((!item.multiSelect && answer.selected.length > 1) || new Set(answer.selected).size !== answer.selected.length || answer.selected.some(label => !item.options?.some(option => option.label === label))) throw new Error('Answer contains unavailable options')
      }
      return this.save(record, { questions: record.questions?.map(item => item.questionId === question.questionId
        ? { ...item, state: 'answered', answer: input.answer, answeredAt: Date.now() } : item) })
    })
  }

  /** Acknowledge delivery to the original live tool invocation.
   * @param id - experiment. @param raw - exact saved question binding. @returns persisted answer.
   */
  async consumeQuestion(id: ExperimentId, raw: unknown): Promise<ExperimentQuestion> {
    const input = questionBindingSchema.parse(raw)
    return this.serial(async () => {
      const record = this.required(id)
      const question = record.questions?.find(item => item.questionId === input.questionId)
      if (!this.active.has(id) || !['planning', 'running', 'waiting-reply'].includes(record.state) || question?.state !== 'answered'
        || question.revision !== input.revision || question.sessionId !== input.sessionId || question.callId !== input.callId) throw new Error('Reply cannot resume this experiment')
      if (record.state === 'waiting-reply') await this.save(record, { state: question.stage })
      return question
    })
  }

  private async execute(record: ClusterRecord, signal: AbortSignal, restoring = false): Promise<void> {
    const id = record.submission.experimentId
    try {
      let outcome: ClusterOutcome
      const update = (patch: Pick<Partial<ClusterRecord>, 'state' | 'services' | 'progress' | 'executions'>) => this.serial(async () => {
        const current = this.required(id)
        await this.save(current, { ...patch, ...(['cancelling', 'waiting-reply'].includes(current.state) ? { state: current.state } : {}) })
      })
      try {
        if (restoring && this.executor.restore !== undefined) outcome = await this.executor.restore(record, signal, update)
        else outcome = await this.executor.run(record, signal, (sessionId, goalId) => this.serial(async () => {
          const current = this.required(id)
          await this.save(current, { sessionId, goalId, state: ['cancelling', 'waiting-reply'].includes(current.state) ? current.state : 'running' })
        }), update)
      } catch (error) {
        let released = false
        try { released = await this.executor.reconcile(record) } catch (cleanupError) { this.reportError(cleanupError) }
        outcome = { state: signal.aborted ? 'cancelled' : 'failed', resourcesReleased: released, detail: String(error) }
      }
      await this.serial(async () => {
        const current = this.required(id)
        await this.save(current, { ...outcome,
          ...(outcome.state === 'awaiting-approval' ? { approval: undefined } : {}),
          state: current.state === 'cancelling' ? outcome.resourcesReleased ? 'cancelled' : 'cancelling' : outcome.state })
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
          updatedAt: Date.now(), handover: CLUSTER_HANDOVER, executions: [], services: [] }
        await this.table.put(id, saved)
        return saved
      }
      if (submission !== undefined && record.payloadHash !== createHash('sha256').update(JSON.stringify(submission)).digest('hex')) throw new Error('cancellation requirements do not match the saved experiment')
      if (record.resourcesReleased && ['preparing', 'planning', 'waiting-reply', 'awaiting-approval', 'queued'].includes(record.state)) {
        this.active.get(id)?.abort.abort(new Error('experiment cancelled'))
        return this.save(record, { state: 'cancelled' })
      }
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
