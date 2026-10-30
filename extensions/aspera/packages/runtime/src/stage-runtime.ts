/** Stage registrations and checks are stored outside the Agent-writable workspace. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { stageRegistrationSchema, stageVerificationSchema, stageRegistrationInputSchema, stageAttemptTransitionSchema, completionSourceSchema } from '@aspera/experiments'
import type { ClusterCommandResult, CompletionSource, ExperimentId, ExperimentPlan, ExperimentServerId, StageRegistration, StageRegistrationInput, StageVerification, StageAttemptTransition } from '@aspera/experiments'
import { verifyTrainingStage, verifyStageParameters } from './stage-acceptance.ts'
import type { StageDocument } from './stage-acceptance.ts'
import type { FinalizationPolicy } from './finalization-policy.ts'
import { stageSuccessorPath, readStageSuccessor, publishStageRecord, checkStageRetrySources } from './stage-attempts.ts'
import { stageCheckpointFiles, verifyContinuationSaving } from './stage-checkpoints.ts'

function registrationInput(value: StageRegistration): Omit<StageRegistrationInput, 'previousAttemptId'> {
  const { version: _version, experimentId: _id, planRevision: _revision, sessionId: _session, requirement: _spec,
    registeredAt: _time, historical: _historical, parametersIdentity: _identity, ...input } = value
  return input
}

/** Authentication and original command observations belong to the owning runtime or Host. */
export interface StageReader {
  source(serverId: ExperimentServerId, path: string, purpose: CompletionSource['purpose'], signal: AbortSignal): Promise<StageDocument>
  command(serverId: ExperimentServerId, commandId: string, signal: AbortSignal): Promise<ClusterCommandResult | undefined>
}
/** @param registration - registered filenames. @returns unique evidence paths and purposes for a bounded read. */
export function stageSources(registration: StageRegistration): { path: string; purpose: CompletionSource['purpose'] }[] {
  return [...new Map([...registration.requirement.requiredFiles.map(path => ({ path, purpose: 'artifact' as const })),
    ...stageCheckpointFiles(registration.requirement).map(value => ({ path: value.path, purpose: 'training' as const })),
    { path: registration.parameters, purpose: 'parameters' as const },
    { path: registration.trainerState, purpose: 'training' as const }, { path: registration.metrics, purpose: 'training' as const },
    ...(registration.resumeState === undefined ? [] : [{ path: registration.resumeState, purpose: 'training' as const }]),
    ...(registration.requirement.scheduler.mode !== 'continue' || registration.resumeState === undefined ? [] : [
      { path: registration.optimizerState ?? registration.resumeState.replace(/[^/]+$/, 'optimizer.pt'), purpose: 'artifact' as const },
      { path: registration.schedulerState ?? registration.resumeState.replace(/[^/]+$/, 'scheduler.pt'), purpose: 'artifact' as const },
      { path: registration.rngState ?? registration.resumeState.replace(/[^/]+$/, 'rng_state.pth'), purpose: 'artifact' as const },
    ]),
    ...(registration.samples === undefined ? [] : [{ path: registration.samples, purpose: 'training' as const }]),
    ...(registration.evaluation === undefined ? [] : [{ path: registration.evaluation, purpose: 'evaluation' as const }]),
    ...(registration.inference === undefined ? [] : [{ path: registration.inference, purpose: 'inference' as const }]),
    ...(registration.baseControl === undefined ? [] : [{ path: registration.baseControl, purpose: 'inference' as const }])].map(value => [value.path, value])).values()]
}
/** @param registration - exact stage identity. @param reader - scoped source and command provider. @param policy - resolved checks. @param signal - operation lifetime.
 * @returns independent checks, retaining missing-file diagnostics rather than trusting a report.
 */
export async function inspectRegisteredStage(registration: StageRegistration, reader: StageReader, policy: FinalizationPolicy,
  signal: AbortSignal): Promise<StageVerification> {
  const documents: StageDocument[] = [], failures: string[] = []
  for (const input of stageSources(registration)) {
    signal.throwIfAborted()
    try {
      const document = await reader.source(registration.serverId, input.path, input.purpose, signal)
      if (document.source.serverId !== registration.serverId || document.source.path !== input.path) throw new Error('Stage source belongs to another node or path')
      documents.push(document)
    } catch (error) { signal.throwIfAborted(); failures.push(input.path + ': ' + String(error)) }
  }
  const checked = verifyTrainingStage(registration, documents, await reader.command(registration.serverId, registration.commandId, signal), policy)
  for (const detail of failures) checked.checks.push({ code: 'source', passed: false, detail })
  if (registration.parametersIdentity !== undefined) {
    const current = documents.find(value => value.source.path === registration.parameters)?.source
    if (current?.sha256 !== registration.parametersIdentity.sha256 || current.generation !== registration.parametersIdentity.generation) checked.checks.push({ code: 'parameters-identity', passed: false, detail: 'Effective parameter source changed after stage registration' })
  }
  checked.ready = checked.checks.every(value => value.passed)
  return stageVerificationSchema.parse(checked)
}

/** Failed attempts acquire immutable successors; original registrations and approved requirements remain unchanged. */
export class StageRegistry {
  /** @param root - original private run root. @param experimentId - original task. @param sessionId - execution owner. @param reader - scoped observations. @param policy - resolved settings. @param retain - node-owned recovery checkpoint registration. */
  constructor(private readonly root: string, private readonly experimentId: ExperimentId, private readonly sessionId: string,
    private readonly reader: StageReader, private readonly policy: FinalizationPolicy,
    private readonly retain: (stage: StageRegistration, signal: AbortSignal) => Promise<void>) {}
  private directory(): string { return resolve(this.root, 'stage-acceptance-v1') }
  private async resumeState(requirement: StageRegistration['requirement'], input: StageRegistrationInput, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    if (requirement.scheduler.mode !== 'continue') return undefined
    if (input.resumeState === undefined) throw new Error('Original resume state JSON filename is required before registering continuation')
    let state: Record<string, unknown>
    try {
      const original = await this.reader.source(input.serverId, input.resumeState, 'training', signal)
      if (original.truncated || original.source.bytes <= 0 || original.source.serverId !== input.serverId || original.source.path !== input.resumeState) throw new Error('Complete owned resume state is required')
      state = z.record(z.string(), z.unknown()).parse(JSON.parse(original.text))
    } catch (error) {
      signal.throwIfAborted()
      throw new Error('Original resume state must be a readable JSON file at the approved startStep, not a checkpoint directory: ' + input.resumeState + ': ' + String(error))
    }
    if (state.global_step !== requirement.startStep) throw new Error('Original resume checkpoint step differs from the approved startStep')
    return state
  }
  private path(registration: Pick<StageRegistration, 'serverId' | 'stageId'>): string { return resolve(this.directory(), registration.serverId + '_' + registration.stageId + '.registration.json') }
  private attempts(path: string): StageRegistration[] {
    let value = stageRegistrationSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (value.experimentId !== this.experimentId || value.sessionId !== this.sessionId || this.path(value) !== path) throw new Error('Stage journal ownership differs from the execution')
    const history: StageRegistration[] = [], visited = new Set<string>()
    for (;;) {
      if (visited.has(value.attemptId)) throw new Error('Stage attempt history contains a cycle')
      visited.add(value.attemptId); history.push(value)
      const successor = readStageSuccessor(this.root, value)
      if (successor === undefined) return history
      value = successor
    }
  }
  /** @returns current registrations followed through validated immutable attempt successors. */
  list(): StageRegistration[] {
    if (!existsSync(this.directory())) return []
    return readdirSync(this.directory()).filter(name => name.endsWith('.registration.json'))
      .map(name => this.attempts(resolve(this.directory(), name)).at(-1)!)
  }
  /** @param request - selected approved stage and actual evidence. @param plan - immutable approved plan. @param signal - request lifetime.
   * @returns an immutable pre-launch attempt; a failed released predecessor permits an explicitly selected successor.
   */
  async register(request: StageRegistrationInput, plan: ExperimentPlan, signal: AbortSignal): Promise<StageRegistration> {
    const { previousAttemptId, ...input } = stageRegistrationInputSchema.parse(request)
    const requirement = plan.stages?.find(stage => stage.stageId === input.stageId)
    if (requirement === undefined || requirement.planStep > plan.steps.length) throw new Error('Stage is absent from the approved plan; requirements cannot be added or lowered after approval')
    const prior = this.list().find(value => value.stageId === input.stageId && value.serverId === input.serverId)
    const history = prior === undefined ? [] : this.attempts(this.path(prior))
    if (prior !== undefined) {
      if (prior.planRevision !== plan.revision || JSON.stringify(prior.requirement) !== JSON.stringify(requirement)) throw new Error('Stage registration request changed; approved requirements remain fixed')
      if (JSON.stringify(registrationInput(prior)) === JSON.stringify(input)) return prior
      const command = await this.reader.command(prior.serverId, prior.commandId, signal)
      if (command?.commandId !== prior.commandId || command.state !== 'failed' || !command.released
        || typeof command.exitCode !== 'number' || command.exitCode === 0) throw new Error('Stage registration request changed; retry requires a confirmed failed and released original command. Running, successful and unknown outcomes cannot be replaced. Preserve successful checkpoints and raw logs; correct the originally registered evidence files from those sources and call verify_experiment_stage. Formatting or missing records do not authorize another training attempt.')
      if (previousAttemptId !== prior.attemptId || prior.attemptId === input.attemptId || prior.commandId === input.commandId) {
        throw new Error(`Stage registration request changed; retry requires previousAttemptId=${prior.attemptId}, a new attemptId and a new commandId`)
      }
      if (history.some(attempt => attempt.attemptId === input.attemptId || attempt.commandId === input.commandId)) throw new Error('A new attempt cannot reuse an earlier attemptId or commandId')
      for (const attempt of history) checkStageRetrySources(attempt, input)
    } else if (previousAttemptId !== undefined) throw new Error('Stage has no previous attempt to replace')
    const missing = [
      ...(requirement.results?.evaluationSamples !== undefined && input.evaluation === undefined ? ['evaluation'] : []),
      ...(requirement.results?.inferencePrompts !== undefined && input.inference === undefined ? ['inference'] : []),
      ...(requirement.results?.baseControl && input.baseControl === undefined ? ['baseControl'] : []),
      ...(requirement.samples !== undefined && input.samples === undefined ? ['samples'] : []),
    ]
    if (missing.length > 0) throw new Error('Stage registration is missing approved evidence filenames: ' + missing.join(', ') + '; supply the paths before training starts')
    if (await this.reader.command(input.serverId, input.commandId, signal) !== undefined) throw new Error('Stage must be registered before its training command starts; use retrospective verification for historical work')
    const parameters = await this.reader.source(input.serverId, input.parameters, 'parameters', signal)
    if (parameters.truncated || parameters.source.bytes <= 0) throw new Error('Complete effective parameters are required before launch')
    if (parameters.source.serverId !== input.serverId || parameters.source.path !== input.parameters) throw new Error('Effective parameter source ownership differs from the registered stage')
    for (const attempt of history) {
      if (input.parameters === attempt.parameters && (parameters.source.sha256 !== attempt.parametersIdentity?.sha256
        || parameters.source.generation !== attempt.parametersIdentity.generation)) throw new Error('Preserve the original parameter source; select a new parameters filename for changed retry configuration')
    }
    const resume = await this.resumeState(requirement, input, signal)
    verifyStageParameters(requirement, parameters.text, input.trainerState, resume)
    verifyContinuationSaving(requirement, z.record(z.string(), z.unknown()).parse(JSON.parse(parameters.text)), resume, plan.stages ?? [])
    const value = stageRegistrationSchema.parse({ ...input, version: 1, experimentId: this.experimentId, sessionId: this.sessionId,
      planRevision: plan.revision, requirement, registeredAt: Date.now(), historical: false, parametersIdentity: completionSourceSchema.parse(parameters.source) })
    let path = this.path(value), record: StageRegistration | StageAttemptTransition = value
    if (prior !== undefined) {
      const command = await this.reader.command(prior.serverId, prior.commandId, signal)
      if (command?.commandId !== prior.commandId || command.state !== 'failed' || !command.released
        || typeof command.exitCode !== 'number' || command.exitCode === 0) throw new Error('Original command outcome changed during retry registration; inspect its identity before retrying')
      const verificationPath = resolve(this.directory(), prior.serverId + '_' + prior.stageId + '.verification.json')
      const verification = existsSync(verificationPath) ? stageVerificationSchema.parse(JSON.parse(readFileSync(verificationPath, 'utf8'))) : undefined
      if (verification !== undefined && (verification.experimentId !== prior.experimentId || verification.serverId !== prior.serverId
        || verification.stageId !== prior.stageId || verification.sessionId !== prior.sessionId || verification.planRevision !== prior.planRevision)) throw new Error('Original stage verification belongs to another execution')
      if (verification?.attemptId === prior.attemptId && verification.ready) throw new Error('A successfully verified stage cannot be retrained to fill missing records')
      path = stageSuccessorPath(this.root, prior)
      record = stageAttemptTransitionSchema.parse({ version: 1, previousAttemptId: prior.attemptId, previousCommand: command,
        ...(verification?.attemptId === prior.attemptId ? { previousVerification: verification } : {}), registration: value, checkedAt: Date.now() })
    }
    if (await this.reader.command(input.serverId, input.commandId, signal) !== undefined) throw new Error('Stage command started while its registration was being checked')
    signal.throwIfAborted()
    await publishStageRecord(path, record)
    const committed = this.list().find(stage => stage.stageId === input.stageId && stage.serverId === input.serverId)
    if (committed === undefined || JSON.stringify(registrationInput(committed)) !== JSON.stringify(input)
      || committed.planRevision !== plan.revision || JSON.stringify(committed.requirement) !== JSON.stringify(requirement)) throw new Error('Stage attempt changed concurrently; read the current registration before retrying')
    return committed
  }
  /** @param serverId - assigned node. @param commandId - original command. @param signal - launch lifetime.
   * @returns after checking any bound stage's immutable parameters; unrelated diagnostic commands remain available.
   */
  async beforeLaunch(serverId: ExperimentServerId, commandId: string, signal: AbortSignal): Promise<void> {
    for (const stage of this.list().filter(value => value.serverId === serverId && value.commandId === commandId)) {
      const current = await this.reader.source(serverId, stage.parameters, 'parameters', signal)
      if (current.truncated || current.source.serverId !== serverId || current.source.path !== stage.parameters
        || current.source.sha256 !== stage.parametersIdentity?.sha256 || current.source.generation !== stage.parametersIdentity.generation) throw new Error('Effective stage parameters changed before command launch')
      verifyStageParameters(stage.requirement, current.text, stage.trainerState, await this.resumeState(stage.requirement, stage, signal))
      await this.retain(stage, signal)
    }
  }
  /** @param registration - immutable stage. @param signal - read lifetime. @returns fresh checks saved independently from raw logs. */
  async verify(registration: StageRegistration, signal: AbortSignal): Promise<StageVerification> {
    const checked = await inspectRegisteredStage(registration, this.reader, this.policy, signal)
    await writeFileAtomic(resolve(this.directory(), registration.serverId + '_' + registration.stageId + '.verification.json'), JSON.stringify(checked) + '\n', { mode: 0o600 })
    return checked
  }
}
