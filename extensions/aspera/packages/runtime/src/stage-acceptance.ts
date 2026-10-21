/** Program-owned Transformers evidence checks use approved stage arithmetic and scheduler semantics. */
import { z } from 'zod'
import type { ClusterCommandResult, CompletionSource, StageRegistration, StageVerification } from '@aspera/experiments'
import type { FinalizationPolicy } from './finalization-policy.ts'

/** The trusted reader supplies stable hashes and the complete bounded source, never a model summary. */
export interface StageDocument { source: CompletionSource; text: string; truncated: boolean }
const object = z.record(z.string(), z.unknown())
function parseRows(text: string): Record<string, unknown>[] {
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) {
    void error
    return text.split('\n').filter(line => line.trim()).map(line => object.parse(JSON.parse(line)))
  }
  if (Array.isArray(value)) return value.map(row => object.parse(row))
  const row = object.parse(value)
  return Array.isArray(row.log_history) ? row.log_history.map(item => object.parse(item)) : [row]
}
function optimizerStep(row: Record<string, unknown>): number | undefined {
  const step = row.global_step ?? row.step
  if (typeof step === 'number' && Number.isSafeInteger(step) && step >= 0) return step
  const formatted = row['global_step/max_steps']
  if (typeof formatted === 'string' && /^\d+\/\d+$/.test(formatted)) return Number(formatted.split('/')[0])
  return undefined
}
function number(row: Record<string, unknown>, key: string): number {
  const value = row[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Missing finite numeric ${key}`)
  return value
}
function schedulerRate(spec: StageRegistration['requirement'], step: number): number {
  const scheduler = spec.scheduler, position = scheduler.mode === 'continue' ? step : step - spec.startStep
  if (position < scheduler.warmupSteps) return scheduler.learningRate * position / Math.max(1, scheduler.warmupSteps)
  if (scheduler.type === 'constant') return scheduler.learningRate
  const progress = (position - scheduler.warmupSteps) / Math.max(1, scheduler.totalSteps - scheduler.warmupSteps)
  return scheduler.learningRate * (scheduler.type === 'linear' ? Math.max(0, 1 - progress) : Math.max(0, 0.5 * (1 + Math.cos(Math.PI * progress))))
}

/** @param spec - approved requirements. @param text - complete effective parameter JSON.
 * @returns a diagnostic after checking launch parameters; throws when the approved values differ.
 */
export function verifyStageParameters(spec: StageRegistration['requirement'], text: string): string {
  const args = object.parse(JSON.parse(text)), scheduler = spec.scheduler
  if (scheduler.mode === 'restart') {
    if (number(args, 'max_steps') < spec.endStep || number(args, 'scheduler_total_steps') !== scheduler.totalSteps) throw new Error('Restart requires an explicit effective local scheduler horizon and the approved cumulative endpoint')
  } else if (number(args, 'max_steps') !== scheduler.totalSteps) throw new Error('Effective max_steps differs from the approved scheduler horizon')
  if (number(args, 'learning_rate') !== scheduler.learningRate || args.lr_scheduler_type !== scheduler.type) throw new Error('Effective learning rate or scheduler differs from the approved stage')
  const warmup = number(args, 'warmup_steps') || (typeof args.warmup_ratio === 'number' ? Math.ceil(args.warmup_ratio * scheduler.totalSteps) : 0)
  if (warmup !== scheduler.warmupSteps) throw new Error('Effective warmup differs from the approved scheduler')
  if (scheduler.mode === 'continue' && (typeof args.resume_from_checkpoint !== 'string' || !args.resume_from_checkpoint)) throw new Error('Continuation lacks an effective resume checkpoint')
  if (spec.samples !== undefined && (number(args, 'per_device_train_batch_size') !== spec.samples.perDeviceBatchSize
    || number(args, 'gradient_accumulation_steps') !== spec.samples.gradientAccumulationSteps
    || number(args, 'world_size') !== spec.samples.worldSize)) throw new Error('Effective batch, accumulation or world size differs from the sample-count basis')
  return 'Effective training parameters match the approved stage'
}

/** @param registration - immutable approved requirements and program-bound files. @param documents - independently read evidence.
 * @param command - the original command's actual exit and cleanup. @param policy - numeric tolerances.
 * @returns separate step, sample, scheduler and process checks; absent evidence never becomes success.
 */
export function verifyTrainingStage(registration: StageRegistration, documents: StageDocument[], command: ClusterCommandResult | undefined,
  policy: FinalizationPolicy): StageVerification {
  const spec = registration.requirement, checks: StageVerification['checks'] = []
  const check = (code: string, run: () => string) => {
    try { checks.push({ code, passed: true, detail: run() }) }
    catch (error) { checks.push({ code, passed: false, detail: String(error) }) }
  }
  const read = (path: string) => {
    const document = documents.find(value => value.source.path === path)
    if (document === undefined || document.source.serverId !== registration.serverId || document.source.bytes <= 0 || document.truncated) {
      throw new Error('Complete, nonempty, identity-bound evidence is required: ' + path)
    }
    return document
  }
  const json = (path: string) => object.parse(JSON.parse(read(path).text))
  check('identity', () => {
    if (registration.stageId !== spec.stageId || spec.startStep + spec.additionalSteps !== spec.endStep) throw new Error('Approved stage identity or step arithmetic differs')
    return 'Approved cumulative and additional optimizer steps are separate'
  })
  check('command', () => {
    if (command?.commandId !== registration.commandId || command.state !== 'completed' || command.exitCode !== 0 || !command.released) throw new Error('Original training command has not succeeded with confirmed release')
    return 'Original command exit 0 and cleanup confirmed; numerical checks remain independent'
  })
  check('checkpoint', () => {
    if (number(json(registration.trainerState), 'global_step') !== spec.endStep) throw new Error('Final checkpoint does not reach cumulative step ' + spec.endStep)
    if (spec.startStep > 0 && (registration.resumeState === undefined || number(json(registration.resumeState), 'global_step') !== spec.startStep)) throw new Error('Original checkpoint does not confirm resume step ' + spec.startStep)
    return `${spec.startStep} + ${spec.additionalSteps} = ${spec.endStep}`
  })
  check('parameters', () => {
    return verifyStageParameters(spec, read(registration.parameters).text)
  })
  if (spec.scheduler.mode === 'continue') check('resume-state', () => {
    if (registration.resumeState === undefined) throw new Error('Original resume checkpoint is missing')
    const args = json(registration.parameters)
    if (args.resume_only_model === true || args.load_only_model === true) throw new Error('Weights-only recovery cannot establish optimizer and scheduler continuation')
    const files = [registration.optimizerState ?? registration.resumeState.replace(/[^/]+$/, 'optimizer.pt'),
      registration.schedulerState ?? registration.resumeState.replace(/[^/]+$/, 'scheduler.pt'),
      registration.rngState ?? registration.resumeState.replace(/[^/]+$/, 'rng_state.pth')]
    const directory = registration.resumeState.slice(0, registration.resumeState.lastIndexOf('/') + 1)
    if (files.some(path => !path.startsWith(directory))) throw new Error('Recovery state files must belong to the original resume checkpoint directory')
    for (const path of files) if (!documents.some(document => document.source.path === path && document.source.serverId === registration.serverId && document.source.bytes > 0)) throw new Error('Required resume state file is missing: ' + path)
    return 'Original optimizer, scheduler and RNG files have independent identities; effective recovery is not weights-only and numerical continuity is checked separately'
  })
  let metrics: Record<string, unknown>[] = []
  check('metrics', () => {
    const rows = parseRows(read(registration.metrics).text).filter(row => 'loss' in row)
    const byStep = new Map<number, Record<string, unknown>>()
    for (const row of rows) {
      const step = optimizerStep(row)
      if (step === undefined) throw new Error('Training metric has no valid optimizer step')
      if (registration.attemptLabel !== undefined && (row.attempt_id ?? row.phase) !== registration.attemptLabel) throw new Error('Metric attempt identity differs from the registered attempt')
      if (step > spec.endStep || step <= (spec.metricScope === 'stage' ? spec.startStep : 0)) throw new Error('Metric belongs outside the declared stage scope: ' + step)
      number(row, 'loss'); number(row, 'learning_rate')
      const prior = byStep.get(step)
      if (prior !== undefined && (prior.loss !== row.loss || prior.learning_rate !== row.learning_rate)) throw new Error('Conflicting duplicate optimizer step: ' + step)
      byStep.set(step, row)
    }
    const first = spec.metricScope === 'stage' ? spec.startStep + 1 : 1
    for (let step = first; step <= spec.endStep; step++) {
      if ((step % spec.loggingSteps === 0 || step === spec.endStep) && !byStep.has(step)) throw new Error('Missing required optimizer-step metric: ' + step)
    }
    if (byStep.size === 0) throw new Error('Training metrics are empty')
    metrics = [...byStep.values()].filter(row => optimizerStep(row)! > spec.startStep).sort((a, b) => optimizerStep(a)! - optimizerStep(b)!)
    return `Verified ${byStep.size} distinct metric steps at logging interval ${spec.loggingSteps}; stage increment ${spec.additionalSteps}`
  })
  check('scheduler', () => {
    if (metrics.length === 0) throw new Error('No validated stage metrics establish scheduler continuity')
    for (const row of metrics) {
      const step = optimizerStep(row)!, actual = number(row, 'learning_rate'), expected = schedulerRate(spec, step)
      if (Math.abs(actual - expected) > Math.max(policy.learningRateAbsoluteTolerance, Math.abs(expected) * policy.learningRateRelativeTolerance)) throw new Error(`Learning rate differs at cumulative step ${step}: actual ${actual}, expected ${expected}`)
    }
    return `Verified ${spec.scheduler.mode} ${spec.scheduler.type} schedule; continuation does not repeat initial warmup`
  })
  if (spec.samples !== undefined) check('samples', () => {
    if (registration.samples === undefined) throw new Error('Approved sample evidence is missing')
    const args = json(registration.parameters), samples = spec.samples!, rows = parseRows(read(registration.samples).text)
    if (number(args, 'per_device_train_batch_size') !== samples.perDeviceBatchSize
      || number(args, 'gradient_accumulation_steps') !== samples.gradientAccumulationSteps
      || number(args, 'world_size') !== samples.worldSize) throw new Error('Effective batch, accumulation or world size differs from the sample-count basis')
    if (rows.length !== samples.expectedCount) throw new Error(`Expected ${samples.expectedCount} ${samples.meaning} ${samples.unit} records, observed ${rows.length}; basis: ${samples.basis}`)
    const sequences = new Set<number>()
    for (const row of rows) {
      const seq = number(row, 'seq'), step = number(row, samples.meaning === 'fetched' ? 'global_step_at_fetch' : 'global_step')
      if (!Number.isSafeInteger(seq) || sequences.has(seq) || step < spec.startStep || step > spec.endStep) throw new Error('Sample sequence is duplicated or outside the registered stage')
      if (registration.attemptLabel !== undefined && (row.attempt_id ?? row.phase) !== registration.attemptLabel) throw new Error('Sample evidence belongs to another attempt')
      sequences.add(seq)
      if (samples.datasetSize !== undefined && samples.firstIndex !== undefined && number(row, 'index') !== (samples.firstIndex + seq) % samples.datasetSize) throw new Error('Sample order does not continue the approved dataset sequence')
    }
    return `Verified ${rows.length} ${samples.meaning} ${samples.unit} records using the approved batch and tail-batch basis`
  })
  if (spec.results?.evaluationSamples !== undefined) check('evaluation', () => {
    if (registration.evaluation === undefined) throw new Error('Evaluation evidence path is missing')
    const evaluation = json(registration.evaluation), count = evaluation.n ?? evaluation.eval_samples ?? evaluation.num_samples
    if (count !== spec.results!.evaluationSamples) throw new Error('Evaluation sample count does not match the approved stage')
    number(evaluation, 'eval_loss')
    return 'Finite evaluation loss and the approved sample count are recorded'
  })
  const responses = (path: string): Record<string, unknown>[] => {
    const value: unknown = JSON.parse(read(path).text)
    if (Array.isArray(value)) return value.map(row => object.parse(row))
    const body = object.parse(value), values = body.results ?? body.outputs ?? body.generations
    if (!Array.isArray(values)) throw new Error('Inference evidence requires actual structured prompt responses')
    return values.map(row => object.parse(row))
  }
  const nonempty = (row: Record<string, unknown>) => typeof (row.response ?? row.output ?? row.generated_text) === 'string'
    && String(row.response ?? row.output ?? row.generated_text).trim().length > 0
  if (spec.results?.inferencePrompts !== undefined) check('inference', () => {
    if (registration.inference === undefined) throw new Error('Reload inference evidence path is missing')
    const rows = responses(registration.inference)
    if (rows.length !== spec.results!.inferencePrompts || !rows.every(nonempty)) throw new Error('Reload inference lacks the approved number of nonempty responses')
    return 'Actual nonempty reload responses exist for every approved prompt'
  })
  if (spec.results?.baseControl) check('base-control', () => {
    if (registration.baseControl === undefined || !responses(registration.baseControl).some(nonempty)) throw new Error('Separate base-only comparison response is missing')
    return 'Separate nonempty base-only comparison response exists'
  })
  const requiredResults = spec.results
  if (requiredResults !== undefined) check('result-identity', () => {
    const checkpoint = registration.trainerState.replace(/\/[^/]+$/, '')
    const matches = (path: unknown) => typeof path === 'string' && (path.replace(/\/$/, '') === checkpoint
      || path.includes(`/runs/${registration.experimentId}/workspace/`) && path.replace(/\/$/, '').endsWith('/' + checkpoint))
    const confirm = (path: string) => {
      const raw: unknown = JSON.parse(read(path).text), rows = Array.isArray(raw) ? raw.map(row => object.parse(row)) : [object.parse(raw)]
      if (!rows.every(row => matches(row.adapter_path ?? row.checkpoint ?? row.model_checkpoint))) throw new Error('Result does not identify the registered training checkpoint: ' + path)
      if (registration.attemptLabel !== undefined && !rows.every(row => (row.attempt_id ?? row.phase) === registration.attemptLabel)) throw new Error('Result belongs to a different training attempt')
    }
    if (requiredResults.evaluationSamples !== undefined && registration.evaluation !== undefined) confirm(registration.evaluation)
    if (requiredResults.inferencePrompts !== undefined && registration.inference !== undefined) confirm(registration.inference)
    return 'Evaluation and reload results identify the registered training checkpoint and attempt'
  })
  for (const path of spec.requiredFiles) check('artifact:' + path, () => {
    const source = documents.find(value => value.source.path === path)?.source
    if (source?.serverId !== registration.serverId || source.bytes <= 0) throw new Error('Nonempty original artifact identity is missing: ' + path)
    return 'Nonempty original artifact identity confirmed: ' + path
  })
  return { version: 1, experimentId: registration.experimentId, serverId: registration.serverId, stageId: registration.stageId,
    attemptId: registration.attemptId, planRevision: registration.planRevision, sessionId: registration.sessionId,
    ready: checks.every(value => value.passed), checkedAt: Date.now(), checks, sources: documents.map(value => value.source),
    startStep: spec.startStep, additionalSteps: spec.additionalSteps, endStep: spec.endStep }
}
