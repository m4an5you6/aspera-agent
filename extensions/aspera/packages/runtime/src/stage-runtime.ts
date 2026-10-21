/** Stage registrations and checks are stored outside the Agent-writable workspace. */
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { stageRegistrationSchema, stageVerificationSchema, stageRegistrationInputSchema, completionSourceSchema } from '@aspera/experiments'
import type { ClusterCommandResult, CompletionSource, ExperimentId, ExperimentPlan, ExperimentServerId, StageRegistration, StageRegistrationInput, StageVerification } from '@aspera/experiments'
import { verifyTrainingStage, verifyStageParameters } from './stage-acceptance.ts'
import type { StageDocument } from './stage-acceptance.ts'
import type { FinalizationPolicy } from './finalization-policy.ts'

/** Authentication and original command observations belong to the owning runtime or Host. */
export interface StageReader {
  source(serverId: ExperimentServerId, path: string, purpose: CompletionSource['purpose'], signal: AbortSignal): Promise<StageDocument>
  command(serverId: ExperimentServerId, commandId: string, signal: AbortSignal): Promise<ClusterCommandResult | undefined>
}
/** @param registration - registered filenames. @returns unique evidence paths and purposes for a bounded read. */
export function stageSources(registration: StageRegistration): { path: string; purpose: CompletionSource['purpose'] }[] {
  return [...new Map([{ path: registration.parameters, purpose: 'parameters' as const },
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
    ...(registration.baseControl === undefined ? [] : [{ path: registration.baseControl, purpose: 'inference' as const }]),
    ...registration.requirement.requiredFiles.map(path => ({ path, purpose: 'artifact' as const }))].map(value => [value.path, value])).values()]
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

/** The execution Agent cannot overwrite registrations, requirements or program-owned source identities. */
export class StageRegistry {
  /** @param root - original private run root. @param experimentId - original task. @param sessionId - execution owner. @param reader - scoped observations. @param policy - resolved settings. */
  constructor(private readonly root: string, private readonly experimentId: ExperimentId, private readonly sessionId: string,
    private readonly reader: StageReader, private readonly policy: FinalizationPolicy) {}
  private directory(): string { return resolve(this.root, 'stage-acceptance-v1') }
  private path(registration: Pick<StageRegistration, 'serverId' | 'stageId'>): string { return resolve(this.directory(), registration.serverId + '_' + registration.stageId + '.registration.json') }
  /** @returns checked registrations for this task and execution Session. */
  list(): StageRegistration[] {
    if (!existsSync(this.directory())) return []
    return readdirSync(this.directory()).filter(name => name.endsWith('.registration.json')).map(name => {
      const value = stageRegistrationSchema.parse(JSON.parse(readFileSync(resolve(this.directory(), name), 'utf8')))
      if (value.experimentId !== this.experimentId || value.sessionId !== this.sessionId || this.path(value) !== resolve(this.directory(), name)) throw new Error('Stage journal ownership differs from the execution')
      return value
    })
  }
  /** @param request - selected approved stage and actual evidence. @param plan - immutable approved plan. @param signal - request lifetime.
   * @returns a durable pre-launch registration; a changed request requires a distinct approved stage.
   */
  async register(request: StageRegistrationInput, plan: ExperimentPlan, signal: AbortSignal): Promise<StageRegistration> {
    const input = stageRegistrationInputSchema.parse(request), requirement = plan.stages?.find(stage => stage.stageId === input.stageId)
    if (requirement === undefined || requirement.planStep > plan.steps.length) throw new Error('Stage is absent from the approved plan; requirements cannot be added or lowered after approval')
    const prior = this.list().find(value => value.stageId === input.stageId && value.serverId === input.serverId)
    if (prior !== undefined) {
      const { version: _version, experimentId: _id, planRevision: _revision, sessionId: _session, requirement: _spec,
        registeredAt: _time, historical: _historical, parametersIdentity: _identity, ...original } = prior
      if (JSON.stringify(original) !== JSON.stringify(input) || prior.planRevision !== plan.revision || JSON.stringify(prior.requirement) !== JSON.stringify(requirement)) throw new Error('Stage registration request changed; original requirements and attempt remain fixed')
      return prior
    }
    if (await this.reader.command(input.serverId, input.commandId, signal) !== undefined) throw new Error('Stage must be registered before its training command starts; use retrospective verification for historical work')
    const parameters = await this.reader.source(input.serverId, input.parameters, 'parameters', signal)
    if (parameters.truncated || parameters.source.bytes <= 0) throw new Error('Complete effective parameters are required before launch')
    if (parameters.source.serverId !== input.serverId || parameters.source.path !== input.parameters) throw new Error('Effective parameter source ownership differs from the registered stage')
    verifyStageParameters(requirement, parameters.text)
    const value = stageRegistrationSchema.parse({ ...input, version: 1, experimentId: this.experimentId, sessionId: this.sessionId,
      planRevision: plan.revision, requirement, registeredAt: Date.now(), historical: false, parametersIdentity: completionSourceSchema.parse(parameters.source) })
    mkdirSync(this.directory(), { recursive: true, mode: 0o700 })
    await writeFileAtomic(this.path(value), JSON.stringify(value) + '\n', { mode: 0o600 })
    return value
  }
  /** @param serverId - assigned node. @param commandId - original command. @param signal - launch lifetime.
   * @returns after checking any bound stage's immutable parameters; unrelated diagnostic commands remain available.
   */
  async beforeLaunch(serverId: ExperimentServerId, commandId: string, signal: AbortSignal): Promise<void> {
    for (const stage of this.list().filter(value => value.serverId === serverId && value.commandId === commandId)) {
      const current = await this.reader.source(serverId, stage.parameters, 'parameters', signal)
      if (current.truncated || current.source.serverId !== serverId || current.source.path !== stage.parameters
        || current.source.sha256 !== stage.parametersIdentity?.sha256 || current.source.generation !== stage.parametersIdentity.generation) throw new Error('Effective stage parameters changed before command launch')
      verifyStageParameters(stage.requirement, current.text)
    }
  }
  /** @param registration - immutable stage. @param signal - read lifetime. @returns fresh checks saved independently from raw logs. */
  async verify(registration: StageRegistration, signal: AbortSignal): Promise<StageVerification> {
    const checked = await inspectRegisteredStage(registration, this.reader, this.policy, signal)
    await writeFileAtomic(resolve(this.directory(), registration.serverId + '_' + registration.stageId + '.verification.json'), JSON.stringify(checked) + '\n', { mode: 0o600 })
    return checked
  }
}
