/** Host-owned supplementary evidence never changes an original execution or schedules training. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, existsSync, readdirSync, readFileSync, openSync, writeFileSync, closeSync, fsyncSync, renameSync, rmSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { completionReviewSchema, completionSourceInputSchema, completionSourceSchema, executionEntrySchema,
  legacyCompletionEvidenceError, agentRecordRequestSchema, agentRecordSchema, completionReviewIdSchema } from '@aspera/experiments'
import type { CompletionReview, CompletionCheck, CompletionIssue, CompletionSourceInput, CompletionSource, CompletionSupplement, HistoricalEnvironment,
  ClusterRecord, ExecutionProgress, ExperimentProcess, ExperimentId, ExperimentServerId, AgentRecord, AgentRecordRequest, AgentRecordPage } from '@aspera/experiments'
import { checkExperimentCompletion, redactObservation } from '@aspera/runtime'
import { legacyTrainingStages, inspectRegisteredStage, finalizationPolicySchema } from '@aspera/runtime'
import type { FinalizationPolicy } from '@aspera/runtime'
import { completionAssessmentSchema, stageRegistrationInputSchema, stageRegistrationSchema, reviewStepSchema } from '@aspera/experiments'
import type { CompletionAssessment, StageRegistrationInput, StageRegistration, StageVerification, ReviewStep, StageRequirement } from '@aspera/experiments'
import type { FleetExperiment } from './types.ts'

/** Fresh facts are read from original nodes, independently from cached successful file reads. */
export interface CompletionReviewSnapshot { record: ClusterRecord; progress?: ExecutionProgress; commands: ExperimentProcess[]; finished: boolean; finishStatus?: 'completed' | 'blocked';
  files?: { serverId: ExperimentServerId; path: string; bytes: number }[] }
/** Program-only file reading, registration and receipt persistence. */
export interface CompletionReviewOwner {
  get(id: ExperimentId): FleetExperiment
  alive(id: ExperimentId): boolean
  snapshot(record: FleetExperiment, signal: AbortSignal): Promise<CompletionReviewSnapshot>
  source(record: FleetExperiment, input: CompletionSourceInput, signal: AbortSignal): Promise<CompletionSource & { text: string; truncated: boolean }>
  environment(record: FleetExperiment, entry: CompletionSupplement['entry'], signal: AbortSignal): Promise<HistoricalEnvironment>
  commit(record: FleetExperiment, review: CompletionReview, signal: AbortSignal, assessment?: CompletionAssessment): Promise<void>
  run(record: FleetExperiment, review: CompletionReview, tools: CompletionReviewTools, signal: AbortSignal): Promise<void>
  changed(): void
  redact(record: FleetExperiment, data: unknown): unknown
  trace(review: CompletionReview, request: AgentRecordRequest): Promise<AgentRecordPage | undefined>
  serviceIssues?(record: FleetExperiment, signal: AbortSignal): Promise<CompletionIssue[]>
  finished?(id: ExperimentId): void
  report?(error: unknown): void
}
/** Restricted tools pass no PID, executable, installation request or mutable ledger to the Agent. */
export interface CompletionReviewTools {
  inspect(signal: AbortSignal): Promise<CompletionCheck>
  record(json: string, sources: string, callId: string, signal: AbortSignal): Promise<CompletionSupplement>
  verify(signal: AbortSignal): Promise<CompletionReview>
  block(detail: string): Promise<void>
  event(event: AgentRecord): void
  requirements(): StageRequirement[]
  progress(signal: AbortSignal): Promise<{ original?: ExecutionProgress; assessment?: CompletionAssessment }>
  /** @param input - original training identity and existing evidence paths. @param signal - review lifetime.
   * @param expectedRevision - current assessment revision required for corrections. @returns registered evidence; passed bindings stay fixed.
   */
  registerStage(input: StageRegistrationInput, signal: AbortSignal, expectedRevision?: number): Promise<StageRegistration>
  verifyStage(serverId: ExperimentServerId, stageId: string, signal: AbortSignal): Promise<StageVerification>
  reportStep(input: { step: number; state: ReviewStep['state']; detail: string; sources: CompletionSourceInput[]; expectedRevision: number }, callId: string, signal: AbortSignal): Promise<CompletionAssessment>
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex')

function sourceValues(text: string): Record<string, unknown>[] {
  const values: unknown[] = []
  try { values.push(JSON.parse(text)) } catch (error) { /* JSONL evidence is parsed one complete line at a time. */ void error }
  if (values.length === 0) for (const line of text.split('\n').filter(Boolean)) {
    try { values.push(JSON.parse(line)) } catch (error) { /* Non-JSON log lines do not establish structured parameter values. */ void error }
  }
  const objects: Record<string, unknown>[] = []
  while (values.length > 0) {
    const value = values.pop()
    if (value === null || typeof value !== 'object') continue
    if (Array.isArray(value)) values.push(...value)
    else { const object = z.record(z.string(), z.unknown()).parse(value); objects.push(object); values.push(...Object.values(object)) }
  }
  return objects
}

/** Durable review operations are separate from the fleet generation and original terminal outcomes. */
export class CompletionReviews {
  private readonly records = new Map<ExperimentId, CompletionReview>()
  private readonly jobs = new Map<ExperimentId, { abort: AbortController; done: Promise<void> }>()
  private readonly assessments = new Map<ExperimentId, CompletionAssessment>()
  private chain: Promise<void> = Promise.resolve()
  private closing = false
  /** @param root - private local archive. @param owner - original task and read-only provider. @param policy - resolved stage verification settings. */
  constructor(private readonly root: string, private readonly owner: CompletionReviewOwner,
    private readonly policy: FinalizationPolicy = finalizationPolicySchema.parse({})) {
    if (existsSync(root)) for (const file of readdirSync(root)) {
      if (!file.endsWith('.v1.json')) continue
      const row = completionReviewSchema.parse(JSON.parse(readFileSync(resolve(root, file), 'utf8')))
      if (file !== row.experimentId + '.v1.json') throw new Error('Completion review file identity mismatch')
      this.records.set(row.experimentId, row)
    }
    if (existsSync(root)) for (const file of readdirSync(root).filter(name => name.endsWith('.assessment-v1.json'))) {
      const row = completionAssessmentSchema.parse(JSON.parse(readFileSync(resolve(root, file), 'utf8')))
      if (file !== row.experimentId + '.assessment-v1.json') throw new Error('Assessment file identity mismatch')
      this.assessments.set(row.experimentId, row)
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.chain.then(operation); this.chain = next.then(() => {}, () => {}); return next
  }
  private save(row: CompletionReview): void {
    if (!this.owner.alive(row.experimentId)) throw new Error('Completion review experiment was deleted')
    const record = this.owner.get(row.experimentId)
    const parsed = completionReviewSchema.parse(this.owner.redact(record, row))
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const temporary = resolve(this.root, randomUUID() + '.incoming'), fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(parsed) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, resolve(this.root, row.experimentId + '.v1.json'))
    this.records.set(row.experimentId, parsed); this.owner.changed()
  }
  /** @param id - original experiment. @returns independently saved assessment, without contacting a server. */
  status(id: ExperimentId): CompletionReview | undefined { const row = this.records.get(id); return row === undefined ? undefined : structuredClone(row) }
  /** @param id - original task. @returns separate stage/step supplements with their original-result identity. */
  assessment(id: ExperimentId): CompletionAssessment | undefined { const value = this.assessments.get(id); return value === undefined ? undefined : structuredClone(value) }
  private saveAssessment(row: CompletionAssessment): void {
    const original = this.status(row.experimentId)
    if (!this.owner.alive(row.experimentId) || original?.operationId !== row.operationId || original.originalRevision !== row.originalRevision) throw new Error('Assessment operation was deleted or replaced')
    const value = completionAssessmentSchema.parse(this.owner.redact(this.owner.get(row.experimentId), row))
    const temporary = resolve(this.root, randomUUID() + '.incoming'), fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify(value) + '\n'); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, resolve(this.root, row.experimentId + '.assessment-v1.json')); this.assessments.set(row.experimentId, value); this.owner.changed()
  }
  /** @returns retained supplementary operations for current experiments. */
  list(): CompletionReview[] { return [...this.records.values()].filter(row => this.owner.alive(row.experimentId)).map(row => structuredClone(row)) }
  /** @param record - original receipt. @returns whether this known completion-evidence failure can request retrospective verification. */
  eligible(record: FleetExperiment): boolean {
    const original = record.latest ?? record.receipt
    const evidenceFailure = original?.state === 'failed' && (original.detail === legacyCompletionEvidenceError || original.detail?.startsWith('Completion verification failed:') === true)
    const legacyBlocked = original?.state === 'blocked' && original.plan !== undefined && record.submission !== undefined
      && original.executions.length > 0 && legacyTrainingStages(record.submission.objective, original.plan).length > 0
    return record.submission?.protocol === 4 && (evidenceFailure || legacyBlocked) && original !== undefined && original.resourcesReleased
      && original.services.every(service => service.released) && original.sessionId !== undefined && original.plan !== undefined
      && original.approval?.planRevision === original.plan.revision
  }
  /** @param id - explicitly selected failed task. @returns durable acknowledgement, never a training retry. */
  request(id: ExperimentId): CompletionReview {
    if (this.closing) throw new Error('Completion review service is stopping')
    const record = this.owner.get(id), original = record.latest ?? record.receipt
    if (!this.eligible(record) || original === undefined) throw new Error('Only released experiments with a completion-evidence failure can be reviewed')
    const prior = this.records.get(id)
    if (prior !== undefined && (prior.submissionHash !== hash(record.submission) || prior.originalRevision !== original.revision)) throw new Error('Original experiment result changed; review identity conflict')
    if (this.jobs.has(id) || prior?.phase === 'passed') return this.status(id)!
    const now = Date.now(), operationId = prior?.operationId ?? completionReviewIdSchema.parse(randomUUID())
    const row: CompletionReview = prior === undefined ? { version: 1, experimentId: id, operationId,
      submissionHash: hash(record.submission), planRevision: original.plan!.revision, executionSessionId: original.sessionId!,
      sessionId: `aspera-review-${operationId}`, originalRevision: original.revision, originalUpdatedAt: original.updatedAt,
      originalDetail: original.detail!, revision: 0, phase: 'collecting', createdAt: now, updatedAt: now, entries: [], remoteCommitted: false }
      : { ...prior, phase: 'collecting', updatedAt: now, revision: prior.revision + 1, detail: undefined }
    this.save(row)
    const previous = this.assessment(id)
    if (previous === undefined) this.saveAssessment({ version: 1, experimentId: id, operationId, originalState: original.state === 'blocked' ? 'blocked' : 'failed',
      originalRevision: original.revision, submissionHash: row.submissionHash, planRevision: row.planRevision, executionSessionId: row.executionSessionId,
      revision: 0, steps: [], stages: [], verifications: [], eligibilityVerified: false, updatedAt: now })
    else if (previous.operationId !== operationId || previous.originalRevision !== row.originalRevision || previous.submissionHash !== row.submissionHash) throw new Error('Assessment original-result identity conflict')
    const abort = new AbortController()
    const done = Promise.resolve().then(async () => {
      try {
        const fresh = await this.owner.snapshot(record, abort.signal)
        this.assertOriginal(row, fresh)
        if (original.state === 'blocked') await this.verifyBlockedEligibility(record, fresh, abort.signal)
        const assessment = this.assessment(id)!
        this.saveAssessment({ ...assessment, eligibilityVerified: true, revision: assessment.revision + 1, updatedAt: Date.now() })
        await this.owner.run(record, row, this.tools(id), abort.signal)
        if (['collecting', 'verifying'].includes(this.status(id)?.phase ?? '')) throw new Error('Review Agent stopped without program-verified completion; existing training was not restarted')
      } catch (error) {
        if (!this.owner.alive(id)) return
        const current = this.status(id)!
        if (current.phase === 'passed') return
        this.save({ ...current, phase: this.closing ? current.phase : abort.signal.aborted ? 'cancelled' : 'blocked',
          updatedAt: Date.now(), revision: current.revision + 1, detail: redactObservation(String(error)) })
      }
    }).finally(() => { this.jobs.delete(id); this.owner.finished?.(id) })
    this.jobs.set(id, { abort, done })
    void done.catch(error => {
      const current = this.records.get(id)
      if (current !== undefined && this.owner.alive(id)) {
        this.records.set(id, { ...current, phase: 'blocked', detail: 'Local review journal could not be saved: ' + redactObservation(String(error)) })
        this.owner.changed()
      }
      this.owner.report?.(error)
    })
    return this.status(id)!
  }
  private assertOriginal(row: CompletionReview, fresh: CompletionReviewSnapshot): void {
    if (hash(fresh.record.submission) !== row.submissionHash || fresh.record.revision !== row.originalRevision
      || fresh.record.state !== (this.assessment(row.experimentId)?.originalState ?? 'failed') || !fresh.record.resourcesReleased || fresh.record.services.some(service => !service.released)
      || fresh.record.sessionId !== row.executionSessionId || fresh.record.plan?.revision !== row.planRevision
      || fresh.record.approval?.planRevision !== row.planRevision || fresh.record.updatedAt !== row.originalUpdatedAt || fresh.record.detail !== row.originalDetail
      || !fresh.finished || fresh.commands.length === 0 || fresh.commands.some(command => !command.released)) {
      throw new Error('Original submission, terminal result, finished Session or command release cannot be confirmed')
    }
    if (fresh.record.state === 'blocked' && fresh.finishStatus !== 'blocked') throw new Error('Original blocked finish call and Goal transition are unconfirmed')
  }
  private requirements(id: ExperimentId): StageRequirement[] {
    const record = this.owner.get(id), original = record.latest ?? record.receipt
    if (original?.plan === undefined) throw new Error('Original approved plan is unavailable')
    return original.plan.stages ?? (original.state === 'blocked' ? legacyTrainingStages(record.submission!.objective, original.plan) : [])
  }
  private async verifyBlockedEligibility(record: FleetExperiment, fresh: CompletionReviewSnapshot, signal: AbortSignal): Promise<void> {
    const requirements = this.requirements(record.request.experimentId)
    if (requirements.length === 0) throw new Error('Original blocked task has no unambiguous approved stage requirements')
    const end = Math.max(...requirements.map(stage => stage.endStep))
    for (const node of fresh.record.submission.nodes) {
      const state = fresh.files?.find(file => file.serverId === node.server.id && file.path.endsWith(`/checkpoint-${end}/trainer_state.json`) && file.bytes > 0)
      if (state === undefined || !fresh.files?.some(file => file.serverId === node.server.id && file.bytes > 0 && file.path.startsWith(state.path.replace(/trainer_state\.json$/, '')) && /adapter.*\.safetensors$/.test(file.path))) throw new Error('Final checkpoint and saved adapter cannot be independently confirmed on node ' + node.server.name)
      const observed = await this.owner.source(record, { serverId: node.server.id, path: state.path, purpose: 'training' }, signal)
      if (observed.truncated || z.object({ global_step: z.number().int() }).parse(JSON.parse(observed.text)).global_step !== end) throw new Error('Final checkpoint does not establish the approved cumulative training endpoint')
      if (!fresh.commands.some(command => command.serverId === node.server.id && command.released && command.state === 'completed' && command.exitCode === 0)) throw new Error('Original node has no confirmed successful command')
    }
    signal.throwIfAborted()
  }
  private async verifyStage(id: ExperimentId, registration: StageRegistration, signal: AbortSignal): Promise<StageVerification> {
    const record = this.owner.get(id), fresh = await this.owner.snapshot(record, signal)
    this.assertOriginal(this.status(id)!, fresh)
    const checked = await inspectRegisteredStage(registration, {
      source: async (serverId, path, purpose, lifetime) => {
        const observed = await this.owner.source(record, { serverId, path, purpose }, lifetime)
        return { source: completionSourceSchema.parse({ serverId, path, purpose, sha256: observed.sha256, generation: observed.generation, bytes: observed.bytes }), text: observed.text, truncated: observed.truncated }
      }, command: async (serverId, commandId) => fresh.commands.find(command => command.serverId === serverId && command.commandId === commandId),
    }, this.policy, signal)
    signal.throwIfAborted()
    const current = this.assessment(id)!
    if (this.status(id)?.operationId !== current.operationId || !this.owner.alive(id)) throw new Error('Stage review was deleted or replaced')
    this.saveAssessment({ ...current, revision: current.revision + 1, updatedAt: Date.now(),
      verifications: [...current.verifications.filter(value => value.stageId !== registration.stageId || value.serverId !== registration.serverId), checked] })
    return checked
  }
  private async inspect(id: ExperimentId, signal: AbortSignal): Promise<CompletionCheck> {
    const row = this.status(id)!, record = this.owner.get(id), fresh = await this.owner.snapshot(record, signal)
    this.assertOriginal(row, fresh)
    const assessment = this.assessment(id), requirements = this.requirements(id), issues: CompletionCheck['issues'] = []
    if (this.owner.serviceIssues !== undefined) issues.push(...await this.owner.serviceIssues(record, signal))
    else if (fresh.record.services.some(service => service.external !== undefined)) issues.push({ code: 'results',
      detail: 'Historical public inference has no independent recovery verification.', remedy: 'Recover and verify the existing public service before completion review.' })
    for (const node of fresh.record.submission.nodes) for (const requirement of requirements) {
      const registration = assessment?.stages.find(stage => stage.serverId === node.server.id && stage.stageId === requirement.stageId)
      if (registration === undefined) issues.push({ code: 'stages', serverId: node.server.id, detail: 'Missing historical stage registration: ' + requirement.stageId, remedy: 'Use register_experiment_stage with existing files and the program-returned approved requirements; never retrain.' })
      else {
        const checked = await this.verifyStage(id, registration, signal)
        for (const failure of checked.checks.filter(value => !value.passed)) issues.push({ code: 'stages', serverId: node.server.id, detail: requirement.stageId + ': ' + failure.detail, remedy: 'Read original evidence and correct its interpretation; missing real results remain unverified.' })
      }
    }
    const progress = fresh.progress === undefined ? undefined : structuredClone(fresh.progress)
    for (const step of assessment?.steps ?? []) if (progress !== undefined && step.state !== 'blocked') {
      const original = progress.steps.find(value => value.step === step.step)
      if (original !== undefined) Object.assign(original, { state: 'completed', detail: step.detail, updatedAt: step.recordedAt })
    }
    return checkExperimentCompletion({ submission: fresh.record.submission, planRevision: row.planRevision,
      sessionId: row.executionSessionId, planSteps: fresh.record.plan!.steps.length, stages: requirements, ...(progress === undefined ? {} : { progress }),
      entries: [...fresh.record.executions, ...row.entries.map(value => value.entry)],
      nodes: fresh.record.submission.nodes.map(node => ({ serverId: node.server.id, commands: fresh.commands.filter(command => command.serverId === node.server.id) })),
      environments: fresh.record.submission.nodes.map(node => ({ serverId: node.server.id,
        verified: row.entries.some(value => value.entry.serverId === node.server.id && value.environment !== undefined),
        detail: 'Historical environment metadata has not been independently verified for this node.' })), services: [], issues })
  }
  private tools(id: ExperimentId): CompletionReviewTools {
    const lifetime = (signal: AbortSignal) => {
      const job = this.jobs.get(id)
      return job === undefined ? signal : AbortSignal.any([signal, job.abort.signal])
    }
    const active = () => {
      this.jobs.get(id)?.abort.signal.throwIfAborted()
      const row = this.status(id)
      if (row === undefined || !this.owner.alive(id) || !['collecting', 'verifying'].includes(row.phase)) throw new Error('Completion review is no longer accepting evidence')
      return row
    }
    return {
      requirements: () => this.requirements(id),
      progress: async inputSignal => { const signal = lifetime(inputSignal); active(); const fresh = await this.owner.snapshot(this.owner.get(id), signal); active(); this.assertOriginal(this.status(id)!, fresh); return { original: fresh.progress, assessment: this.assessment(id) } },
      registerStage: (request, inputSignal, expectedRevision) => this.serial(async () => {
        const signal = lifetime(inputSignal), row = active(), record = this.owner.get(id)
        if (request.previousAttemptId !== undefined) throw new Error('Historical completion review cannot retry training or replace original attempts')
        const { previousAttemptId: _previous, ...input } = stageRegistrationInputSchema.parse(request)
        if (!record.submission!.nodes.some(node => node.server.id === input.serverId)) throw new Error('Historical stage node is outside the original experiment')
        const requirement = this.requirements(id).find(stage => stage.stageId === input.stageId)
        if (requirement === undefined) throw new Error('Stage is absent from the program-confirmed original requirements')
        const fresh = await this.owner.snapshot(record, signal); active(); this.assertOriginal(row, fresh)
        if (!fresh.commands.some(command => command.serverId === input.serverId && command.commandId === input.commandId && command.released)) throw new Error('Original stage command and exit cannot be confirmed')
        const current = this.assessment(id)!, registration = stageRegistrationSchema.parse({ ...input, version: 1, experimentId: id,
          planRevision: row.planRevision, sessionId: row.executionSessionId, requirement, registeredAt: Date.now(), historical: true })
        const prior = current.stages.find(stage => stage.stageId === input.stageId && stage.serverId === input.serverId)
        if (prior !== undefined) {
          if (hash({ ...prior, registeredAt: 0 }) === hash({ ...registration, registeredAt: 0 })) return prior
          if (prior.attemptId !== registration.attemptId || prior.commandId !== registration.commandId || hash(prior.requirement) !== hash(registration.requirement)) {
            throw new Error('Historical training identity and approved requirements cannot change during evidence correction')
          }
          if (current.verifications.some(value => value.stageId === input.stageId && value.serverId === input.serverId && value.ready)) {
            throw new Error('Historical stage evidence is already verified; its binding cannot be replaced')
          }
          if (expectedRevision !== current.revision) throw new Error('Stage evidence correction requires the current assessment.revision as expected_revision; read get_experiment_execution_progress before retrying')
        }
        signal.throwIfAborted(); active()
        this.saveAssessment({ ...current,
          stages: [...current.stages.filter(value => value.stageId !== input.stageId || value.serverId !== input.serverId), registration],
          verifications: current.verifications.filter(value => value.stageId !== input.stageId || value.serverId !== input.serverId),
          revision: current.revision + 1, updatedAt: Date.now() }); return registration
      }),
      verifyStage: (serverId, stageId, inputSignal) => this.serial(async () => {
        const signal = lifetime(inputSignal); active()
        const registration = this.assessment(id)?.stages.find(stage => stage.serverId === serverId && stage.stageId === stageId)
        if (registration === undefined) throw new Error('Historical stage has not been registered')
        return this.verifyStage(id, registration, signal)
      }),
      reportStep: (request, callId, inputSignal) => this.serial(async () => {
        const signal = lifetime(inputSignal), row = active(), record = this.owner.get(id), current = this.assessment(id)!
        if (request.expectedRevision !== current.revision) throw new Error('Supplement revision conflict; read get_experiment_execution_progress before retrying the report')
        const fresh = await this.owner.snapshot(record, signal); active(); this.assertOriginal(row, fresh)
        if (!Number.isSafeInteger(request.step) || request.step < 1 || request.step > fresh.record.plan!.steps.length) throw new Error('Supplement step is outside the original approved plan')
        if (request.state === 'not-applicable') {
          const condition = fresh.record.plan!.conditionalSteps?.find(value => value.step === request.step)
          if (condition === undefined || !condition.commandIds.every(commandId => fresh.commands.some(command => command.commandId === commandId && command.released && command.state === 'completed' && command.exitCode === 0))) throw new Error('The approved conditional trigger has not been independently ruled out')
        }
        if (request.sources.length === 0) throw new Error('Step supplements must reference actual original evidence')
        const sources: CompletionSource[] = []
        for (const input of request.sources) {
          if (!record.submission!.nodes.some(node => node.server.id === input.serverId)) throw new Error('Step evidence belongs to an unselected node')
          const source = await this.owner.source(record, completionSourceInputSchema.parse(input), signal)
          if (source.bytes <= 0 || source.serverId !== input.serverId || source.path !== input.path) throw new Error('Step evidence is empty or belongs to another source')
          sources.push(completionSourceSchema.parse({ serverId: source.serverId, path: source.path, purpose: input.purpose, sha256: source.sha256, generation: source.generation, bytes: source.bytes }))
        }
        signal.throwIfAborted(); active()
        const step = reviewStepSchema.parse({ step: request.step, state: request.state, detail: request.detail, sources, recordedAt: Date.now(), callId })
        const prior = current.steps.find(value => value.step === step.step)
        if (prior?.state === 'completed' && step.state !== 'completed') throw new Error('Completed supplementary steps cannot be reopened by late reports')
        if (prior !== undefined && hash({ ...prior, recordedAt: 0, callId: '' }) === hash({ ...step, recordedAt: 0, callId: '' })) return current
        const next = { ...current, steps: [...current.steps.filter(value => value.step !== step.step), step], revision: current.revision + 1, updatedAt: Date.now() }
        this.saveAssessment(next); return next
      }),
      inspect: signal => this.serial(() => this.inspect(id, lifetime(signal))),
      record: (json, sources, callId, inputSignal) => this.serial(async () => {
        const signal = lifetime(inputSignal)
        active(); const record = this.owner.get(id), entry = executionEntrySchema.parse(JSON.parse(json))
        if (!record.submission!.nodes.some(node => node.server.id === entry.serverId)) throw new Error('Supplementary node is outside this experiment')
        const before = active()
        if (before.currentServerId !== entry.serverId) this.save({ ...before, currentServerId: entry.serverId, updatedAt: Date.now(), revision: before.revision + 1 })
        const inputs = z.array(completionSourceInputSchema).min(1).parse(JSON.parse(sources))
        if (inputs.some(source => source.serverId !== entry.serverId)) throw new Error('Supplementary evidence source belongs to another node')
        for (const purpose of ['framework', 'script', 'environment', 'parameters'] as const) if (!inputs.some(source => source.purpose === purpose)) throw new Error('Missing source for execution field: ' + purpose)
        const observed: CompletionSource[] = [], contents: { purpose: CompletionSourceInput['purpose']; path: string; text: string; truncated: boolean }[] = []
        const read = new Map<string, Awaited<ReturnType<CompletionReviewOwner['source']>>>()
        const selected = new Map<string, CompletionSourceInput>()
        for (const input of inputs) if (!selected.has(input.path) || ['parameters', 'evaluation'].includes(input.purpose)) selected.set(input.path, input)
        for (const input of inputs) {
          signal.throwIfAborted()
          let source = read.get(input.path)
          if (source === undefined) { source = await this.owner.source(record, selected.get(input.path)!, signal); read.set(input.path, source) }
          observed.push(completionSourceSchema.parse({ ...input, sha256: source.sha256, generation: source.generation, bytes: source.bytes }))
          if (source.bytes === 0) throw new Error('Supplementary evidence source is empty: ' + input.path)
          contents.push({ purpose: input.purpose, path: input.path, text: source.text, truncated: source.truncated })
        }
        const issues: { field: string; detail: string; provided?: string | number; available?: { path: string; value: string | number }[] }[] = []
        if (!inputs.some(source => source.purpose === 'script' && source.path === entry.script)) issues.push({ field: 'script', detail: 'Script must reference its actual experiment-relative source', provided: entry.script })
        const structured = contents.filter(source => ['parameters', 'evaluation'].includes(source.purpose)).map(source => ({ ...source, values: sourceValues(source.text) }))
        if (Object.keys(entry.parameters).length === 0) issues.push({ field: 'parameters', detail: 'Supplementary execution requires effective parameters from original saved JSON' })
        for (const [key, value] of Object.entries(entry.parameters)) {
          const available = structured.filter(source => source.purpose === 'parameters').flatMap(source => source.values.filter(object => object[key] !== undefined)
            .map(object => ({ path: source.path, value: String(object[key]) })))
          if (!available.some(saved => saved.value === value)) issues.push({ field: `parameters.${key}`, detail: 'Parameter does not match original structured evidence', provided: value, available })
        }
        for (const [key, value] of Object.entries(entry.evaluation)) {
          const available = structured.filter(source => source.purpose === 'evaluation').flatMap(source => source.values.filter(object => typeof object[key] === 'number' && Number.isFinite(object[key]))
            .map(object => ({ path: source.path, value: Number(object[key]) })))
          if (!available.some(saved => saved.value === value)) issues.push({ field: `evaluation.${key}`, detail: 'Evaluation does not match original structured evidence', provided: value, available })
        }
        if (!inputs.some(source => ['training', 'artifact', 'inference'].includes(source.purpose))) issues.push({ field: 'sources', detail: 'Supplementary execution lacks original result evidence' })
        for (const artifact of entry.artifacts) if (!inputs.some(source => source.purpose === 'artifact' && source.path === artifact)) issues.push({ field: 'artifacts', detail: 'Artifact lacks an independently read source', provided: artifact })
        if (Object.keys(entry.evaluation).length > 0 && !inputs.some(source => source.purpose === 'evaluation')) issues.push({ field: 'evaluation', detail: 'Evaluation values lack a recorded source' })
        if (issues.length > 0) throw new Error(JSON.stringify({ code: 'completion-evidence-mismatch', serverId: entry.serverId, issues,
          structuredSources: structured.map(source => ({ path: source.path, purpose: source.purpose, truncated: source.truncated,
            availableKeys: [...new Set(source.values.flatMap(object => Object.keys(object)))].sort(), parseable: source.values.length > 0 })),
          remedy: 'Correct all listed fields from the cited saved JSON/JSONL. Parameters use exact saved keys and String(value); evaluation requires finite numbers. Unparseable or truncated evidence cannot establish missing values. Do not rerun training.' }))
        const fresh = await this.owner.snapshot(record, signal)
        this.assertOriginal(active(), fresh)
        const scriptName = entry.script.split('/').at(-1)!
        const commands = fresh.commands.filter(command => command.serverId === entry.serverId && command.state === 'completed' && command.exitCode === 0 && command.released)
        if (!commands.some(command => command.command.includes(entry.script) || command.command.includes(scriptName))) {
          throw new Error('Recorded script is not associated with a successful original command; cite the actual executed wrapper or script, without rerunning it')
        }
        const environmentName = entry.environment.replace(/\/$/, '').split('/').at(-1)!
        if (![...commands.map(command => command.command), ...contents.filter(source => source.purpose === 'script').map(source => source.text)]
          .some(text => text.includes(entry.environment) || text.includes(environmentName))) throw new Error('Historical environment is not referenced by the original commands or executed script')
        const environment = await this.owner.environment(record, entry, signal)
        signal.throwIfAborted()
        const supplement: CompletionSupplement = { entry, sources: observed, environment, recordedAt: Date.now(), callId }
        const current = active()
        const entries = current.entries.filter(value => value.entry.serverId !== entry.serverId)
        entries.push(supplement)
        if (hash(current.entries.find(value => value.entry.serverId === entry.serverId)?.entry) !== hash(entry)
          || hash(current.entries.find(value => value.entry.serverId === entry.serverId)?.sources) !== hash(observed)) {
          this.save({ ...current, entries, updatedAt: Date.now(), revision: current.revision + 1 })
        }
        return supplement
      }),
      verify: inputSignal => this.serial(async () => {
        const signal = lifetime(inputSignal)
        active(); const check = await this.inspect(id, signal)
        if (!check.ready) { const row = active(); this.save({ ...row, check, phase: 'collecting', updatedAt: Date.now(), revision: row.revision + 1 }); return this.status(id)! }
        let row = active(); this.save({ ...row, phase: 'verifying', check, updatedAt: Date.now(), revision: row.revision + 1 })
        const record = this.owner.get(id)
        for (const entry of row.entries) {
          const environment = await this.owner.environment(record, entry.entry, signal)
          if (environment.digest !== entry.environment?.digest) throw new Error('Historical environment changed during review')
          const observed = new Map<string, Awaited<ReturnType<CompletionReviewOwner['source']>>>()
          for (const source of entry.sources) {
            let current = observed.get(source.path)
            if (current === undefined) { current = await this.owner.source(record, source, signal); observed.set(source.path, current) }
            if (current.sha256 !== source.sha256 || current.generation !== source.generation) throw new Error('Evidence source changed during review: ' + source.path)
          }
        }
        const fresh = await this.owner.snapshot(record, signal); this.assertOriginal(row, fresh)
        signal.throwIfAborted(); row = active()
        const passed: CompletionReview = { ...row, phase: 'passed', check, verifiedAt: Date.now(), updatedAt: Date.now(), revision: row.revision + 1, remoteCommitted: true }
        const assessment = this.assessment(id)!
        const stageSources = hash(assessment.verifications.map(value => ({ stageId: value.stageId, serverId: value.serverId, sources: value.sources })))
        for (const step of assessment.steps) for (const source of step.sources) {
          const current = await this.owner.source(record, source, signal)
          if (source.sha256 !== current.sha256 || source.generation !== current.generation) throw new Error('Step evidence changed during review: ' + source.path)
        }
        const finalCheck = await this.inspect(id, signal)
        if (!finalCheck.ready) throw new Error('Final supplementary verification changed before commit')
        if (stageSources !== hash(this.assessment(id)!.verifications.map(value => ({ stageId: value.stageId, serverId: value.serverId, sources: value.sources })))) throw new Error('Stage evidence identity changed during final verification')
        signal.throwIfAborted(); active()
        await this.owner.commit(record, passed, signal, this.assessment(id))
        signal.throwIfAborted(); active(); this.save(passed)
        return this.status(id)!
      }),
      block: detail => this.serial(async () => { const row = active(); this.save({ ...row, phase: 'blocked', detail, updatedAt: Date.now(), revision: row.revision + 1 }) }),
      event: event => {
        const row = this.status(id)
        if (row === undefined || event.experimentId !== id || event.sessionId !== row.sessionId || !this.owner.alive(id)) return
        mkdirSync(this.root, { recursive: true, mode: 0o700 })
        const redacted = agentRecordSchema.parse(this.owner.redact(this.owner.get(id), event))
        appendFileSync(resolve(this.root, `${id}.${row.operationId}.events.jsonl`), JSON.stringify(redacted) + '\n', { mode: 0o600 })
      },
    }
  }
  /** @param raw - original experiment and review-bound cursor. @returns offline supplementary Session events. */
  async trace(raw: AgentRecordRequest): Promise<AgentRecordPage> {
    const input = agentRecordRequestSchema.parse(raw), row = this.status(input.experimentId)
    if (row === undefined) return { records: [], hasMore: false, missing: true, reset: false }
    if (input.phase !== 'execution' || input.cursor !== undefined && (input.cursor.phase !== 'execution' || input.cursor.sessionId !== row.sessionId || input.cursor.experimentId !== row.experimentId)) throw new Error('Review trace cursor belongs to another operation')
    const original = await this.owner.trace(row, raw)
    if (!this.owner.alive(row.experimentId) || this.status(row.experimentId)?.operationId !== row.operationId) throw new Error('Completion review experiment was deleted or replaced')
    if (original !== undefined) {
      if (original.records.some(event => event.experimentId !== row.experimentId || event.sessionId !== row.sessionId || event.phase !== 'execution')
        || original.cursor !== undefined && (original.cursor.experimentId !== row.experimentId || original.cursor.sessionId !== row.sessionId || original.cursor.phase !== 'execution')) throw new Error('Saved supplementary trace belongs to another Session')
      return original
    }
    const path = resolve(this.root, `${row.experimentId}.${row.operationId}.events.jsonl`)
    const records: AgentRecord[] = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => agentRecordSchema.parse(JSON.parse(line))) : []
    if (records.some(event => event.experimentId !== row.experimentId || event.sessionId !== row.sessionId || event.phase !== 'execution')) throw new Error('Saved supplementary trace belongs to another Session')
    const unique = [...new Map(records.map(event => [event.seq, event])).values()].sort((a, b) => a.seq - b.seq)
    const found = unique.filter(event => (input.beforeSeq === undefined || event.seq < input.beforeSeq) && (input.cursor === undefined || event.seq >= input.cursor.nextSeq))
    const page = input.cursor === undefined ? found.slice(-input.limit) : found.slice(0, input.limit)
    return { records: page, cursor: { experimentId: row.experimentId, phase: 'execution', sessionId: row.sessionId, nextSeq: (page.at(-1)?.seq ?? -1) + 1 },
      hasMore: found.length > page.length, missing: false, reset: false }
  }
  /** Resume only incomplete evidence operations after Host startup. */
  resume(): void { for (const row of this.list()) if (['collecting', 'verifying'].includes(row.phase)) this.request(row.experimentId) }
  /** @param id - user-selected operation. @returns after reading and Agent writes stop. */
  async stop(id: ExperimentId): Promise<void> { const job = this.jobs.get(id); job?.abort.abort(new Error('Completion review cancelled')); await job?.done }
  /** @param id - deleted original experiment. @returns after the independent local journal is removed. */
  async forget(id: ExperimentId): Promise<void> {
    await this.stop(id); this.records.delete(id); this.assessments.delete(id)
    if (existsSync(this.root)) for (const file of readdirSync(this.root)) if (file.startsWith(id + '.')) rmSync(resolve(this.root, file), { force: true })
  }
  /** Stop local readers and await committed writes; original tasks remain stopped. */
  async close(): Promise<void> { this.closing = true; await Promise.all([...this.jobs.keys()].map(id => this.stop(id))); await this.chain }
}
