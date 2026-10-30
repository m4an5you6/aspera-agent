/** Continuation acceptance uses cumulative steps, stage-local logs and the restored scheduler. */
import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { stageRegistrationSchema } from '@aspera/experiments'
import type { CompletionSource } from '@aspera/experiments'
import { verifyTrainingStage, verifyStageParameters } from '../src/stage-acceptance.ts'
import type { StageDocument } from '../src/stage-acceptance.ts'
import { finalizationPolicySchema } from '../src/finalization-policy.ts'

function fixture() {
  const registration = stageRegistrationSchema.parse({ version: 1, experimentId: randomUUID(), serverId: randomUUID(), stageId: 'phase2',
    attemptId: 'phase2b', commandId: 'train2', planRevision: 1, sessionId: 'execution', registeredAt: 1, historical: false,
    parameters: 'args.json', resumeState: 'checkpoint-30/trainer_state.json', trainerState: 'checkpoint-230/trainer_state.json', metrics: 'metrics.jsonl', samples: 'samples.jsonl',
    requirement: { stageId: 'phase2', planStep: 2, title: 'Continue for 200 steps', framework: 'transformers', startStep: 30, additionalSteps: 200,
      endStep: 230, metricScope: 'stage', loggingSteps: 1, scheduler: { mode: 'continue', type: 'cosine', learningRate: 0.0001, warmupSteps: 12, totalSteps: 230 },
      samples: { unit: 'example', meaning: 'fetched', expectedCount: 1600, basis: '200 complete optimizer batches of 8 examples',
        perDeviceBatchSize: 1, gradientAccumulationSteps: 8, worldSize: 1 } } })
  const documents: StageDocument[] = []
  const add = (path: string, value: unknown, purpose: CompletionSource['purpose']) => {
    documents.push({ source: { serverId: registration.serverId, path, purpose, sha256: 'a'.repeat(64), generation: 'one', bytes: 100 }, text: JSON.stringify(value), truncated: false })
  }
  add('args.json', { max_steps: 230, resume_from_checkpoint: 'checkpoint-30', learning_rate: 0.0001, lr_scheduler_type: 'cosine', warmup_steps: 12,
    per_device_train_batch_size: 1, gradient_accumulation_steps: 8, world_size: 1 }, 'parameters')
  add('checkpoint-30/trainer_state.json', { global_step: 30 }, 'training')
  for (const name of ['optimizer.pt', 'scheduler.pt', 'rng_state.pth']) add('checkpoint-30/' + name, { fixture: 'Opaque state identity; no checkpoint code is executed' }, 'artifact')
  add('checkpoint-230/trainer_state.json', { global_step: 230 }, 'training')
  const metrics = Array.from({ length: 200 }, (_, index) => ({ step: index + 31, loss: 1.2,
    learning_rate: 0.0001 * 0.5 * (1 + Math.cos(Math.PI * (index + 31 - 12) / (230 - 12))) }))
  add('metrics.jsonl', metrics, 'training')
  add('samples.jsonl', Array.from({ length: 1600 }, (_, index) => ({ seq: index, index: index % 450, global_step_at_fetch: 30 + Math.floor(index / 8) })), 'training')
  const command = { commandId: 'train2', state: 'completed' as const, exitCode: 0, released: true }
  const verify = () => verifyTrainingStage(registration, documents, command, finalizationPolicySchema.parse({}))
  return { registration, documents, command, metrics, verify }
}
it('accepts 200 additional steps ending at 230 with a resumed learning rate above the original warmup threshold', () => {
  const f = fixture(); expect(f.metrics[0]!.learning_rate).toBeGreaterThan(0.00002)
  expect(f.verify()).toMatchObject({ ready: true, startStep: 30, additionalSteps: 200, endStep: 230 })
})
it('checks that the effective save interval produces and retains an approved intermediate checkpoint', () => {
  const f = fixture(), parameters = z.record(z.string(), z.unknown()).parse(JSON.parse(f.documents[0]!.text))
  f.registration.requirement.requiredFiles.push('checkpoint-200/trainer_state.json')
  Object.assign(parameters, { save_strategy: 'steps', save_steps: 30, save_total_limit: 2 })
  const original = { save_steps: 30 }
  const verify = () => verifyStageParameters(f.registration.requirement, JSON.stringify(parameters), f.registration.trainerState, original)
  expect(verify).toThrow('checkpoint-200')
  parameters.save_steps = 200
  expect(verify).toThrow('original resumed TrainerState.save_steps=30')
  original.save_steps = 50
  expect(verify).not.toThrow()
  parameters.save_total_limit = 1
  expect(verify).toThrow('retention')
  original.save_steps = 10; parameters.save_total_limit = 2
  expect(verify).toThrow('retention')
})
it('rejects a renamed intermediate checkpoint whose native step differs from the approved filename', () => {
  const f = fixture(), path = 'outputs/checkpoint-200/trainer_state.json'
  f.registration.requirement.requiredFiles.push(path)
  const parameters = z.record(z.string(), z.unknown()).parse(JSON.parse(f.documents[0]!.text))
  f.documents[0]!.text = JSON.stringify({ ...parameters, save_strategy: 'steps', save_steps: 50, save_total_limit: 2 })
  const document = { source: { ...f.documents[0]!.source, path, purpose: 'training' as const }, text: '{"global_step":210}', truncated: false }
  f.documents.push(document)
  const invalid = f.verify()
  expect(invalid.ready).toBe(false)
  expect(invalid.checks).toContainEqual(expect.objectContaining({ code: 'recovery-checkpoint:' + path, passed: false }))
  document.text = '{"global_step":200}'
  expect(f.verify().ready).toBe(true)
  document.truncated = true
  expect(f.verify().ready).toBe(false)
})
it('rejects a missing recorded optimizer step even when the outer command exits zero', () => {
  const f = fixture(); f.metrics.splice(80, 1); f.documents.find(value => value.source.path === 'metrics.jsonl')!.text = JSON.stringify(f.metrics)
  expect(f.verify()).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ code: 'metrics', passed: false })]) })
})
it('does not accept a diagnostic command as a training-stage execution', () => {
  const f = fixture()
  const result = verifyTrainingStage(f.registration, f.documents, { ...f.command, purpose: 'diagnostic' }, finalizationPolicySchema.parse({}))
  expect(result).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ code: 'command', passed: false })]) })
})
it('accepts sparse logging by recorded step coverage instead of requiring 200 lines', () => {
  const f = fixture(); f.registration.requirement.loggingSteps = 10
  f.documents.find(value => value.source.path === 'metrics.jsonl')!.text = JSON.stringify(f.metrics.filter(row => row.step % 10 === 0))
  expect(f.verify().ready).toBe(true)
})
it('ignores identical duplicate metrics but rejects conflicting duplicates and foreign attempts', () => {
  const f = fixture(), document = f.documents.find(value => value.source.path === 'metrics.jsonl')!
  document.text = JSON.stringify([...f.metrics, f.metrics[0]])
  expect(f.verify().ready).toBe(true)
  document.text = JSON.stringify([...f.metrics, { ...f.metrics[0], loss: 99 }]); expect(f.verify().ready).toBe(false)
  f.registration.attemptLabel = 'phase2b'; document.text = JSON.stringify(f.metrics.map(row => ({ ...row, phase: 'old-attempt' })))
  expect(f.verify().ready).toBe(false)
})
it('identifies the immutable evidence label when it differs from the attempt ID', () => {
  const f = fixture(), document = f.documents.find(value => value.source.path === 'metrics.jsonl')!
  f.registration.attemptLabel = 'phase2-continuation'
  document.text = JSON.stringify(f.metrics.map(row => ({ ...row, attempt_id: f.registration.attemptId })))
  const check = f.verify().checks.find(value => value.code === 'metrics')!
  expect(check.passed).toBe(false)
  expect(check.detail).toContain('metrics.jsonl')
  expect(check.detail).toContain('phase2-continuation')
  expect(check.detail).toContain(f.registration.attemptId)
  document.text = JSON.stringify(f.metrics.map(row => ({ ...row, attempt_id: f.registration.attemptLabel })))
  const samples = f.documents.find(value => value.source.path === 'samples.jsonl')!
  samples.text = JSON.stringify(z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(samples.text))
    .map(row => ({ ...row, attempt_id: f.registration.attemptLabel })))
  expect(f.verify().ready).toBe(true)
})
it('summarizes an oversized evidence label without copying it into the diagnostic', () => {
  const f = fixture(), label = 'invalid-label-'.repeat(10000)
  f.registration.attemptLabel = 'expected-label'
  f.documents.find(value => value.source.path === 'metrics.jsonl')!.text = JSON.stringify(f.metrics.map(row => ({ ...row, attempt_id: label })))
  const check = f.verify().checks.find(value => value.code === 'metrics')!
  expect(check.passed).toBe(false)
  expect(check.detail).toContain('expected-label')
  expect(check.detail).toContain('invalid string')
  expect(check.detail.length).toBeLessThan(1024)
})
it('does not accept a newly restarted warmup when continuing the original scheduler', () => {
  const f = fixture(); f.metrics[0]!.learning_rate = 0.000008333333333333334
  f.documents.find(value => value.source.path === 'metrics.jsonl')!.text = JSON.stringify(f.metrics)
  expect(f.verify()).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ code: 'scheduler', passed: false })]) })
})
it('requires original optimizer, scheduler and RNG identities for a non-weights-only continuation', () => {
  const f = fixture()
  f.documents.splice(f.documents.findIndex(value => value.source.path.endsWith('optimizer.pt')), 1)
  expect(f.verify()).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ code: 'resume-state', passed: false })]) })
})
it.each(['truncated', 'resume', 'samples', 'process'] as const)('keeps %s evidence failures independent from the outer exit code', kind => {
  const f = fixture()
  if (kind === 'truncated') f.documents[0]!.truncated = true
  if (kind === 'resume') f.documents.find(value => value.source.path.includes('checkpoint-30'))!.text = '{"global_step":0}'
  if (kind === 'samples') f.documents.find(value => value.source.path === 'samples.jsonl')!.text = '[]'
  if (kind === 'process') f.command.released = false
  expect(f.verify().ready).toBe(false)
})
it('rejects successful-looking evaluation and reload results from another checkpoint', () => {
  const f = fixture(); f.registration.requirement.results = { evaluationSamples: 50, inferencePrompts: 5, baseControl: false }
  f.registration.evaluation = 'eval.json'; f.registration.inference = 'reload.json'
  const add = (path: string, content: unknown) => f.documents.push({ source: { ...f.documents[0]!.source, path }, text: JSON.stringify(content), truncated: false })
  add('eval.json', { n: 50, eval_loss: 1.4, adapter_path: 'checkpoint-30' })
  add('reload.json', { adapter_path: 'checkpoint-30', results: Array.from({ length: 5 }, () => ({ response: 'Nonempty' })) })
  expect(f.verify()).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ code: 'result-identity', passed: false })]) })
  for (const path of ['eval.json', 'reload.json']) {
    const document = f.documents.find(value => value.source.path === path)!
    document.text = document.text.replaceAll('checkpoint-30', 'checkpoint-230')
  }
  expect(f.verify().ready).toBe(true)
})
function copiedCheckpointFixture() {
  const f = fixture(), native = f.documents.find(value => value.source.path === f.registration.trainerState)!
  const nativePath = native.source.path, text = native.text
  native.source = { ...native.source, path: 'logs/train2/trainer_state.json',
    sha256: createHash('sha256').update(text).digest('hex'), bytes: Buffer.byteLength(text) }
  f.registration.trainerState = native.source.path
  f.registration.requirement.requiredFiles.push(nativePath)
  const checkpoint = { ...native, source: { ...native.source, path: nativePath } }
  f.documents.push(checkpoint)
  f.registration.evaluation = 'eval.json'; f.registration.inference = 'reload.json'
  f.registration.requirement.results = { evaluationSamples: 50, inferencePrompts: 2, baseControl: false }
  for (const [path, value] of [['eval.json', { n: 50, eval_loss: 1.4, adapter_path: 'checkpoint-230' }],
    ['reload.json', { adapter_path: 'checkpoint-230', results: [{ response: 'First' }, { response: 'Second' }] }]] as const) {
    f.documents.push({ source: { ...native.source, path }, text: JSON.stringify(value), truncated: false })
  }
  return { ...f, checkpoint, snapshot: native }
}
it('binds results to an approved native checkpoint when its complete state is copied into the logs', () => {
  const f = copiedCheckpointFixture(), original = f.documents.map(document => document.text)
  expect(f.verify()).toMatchObject({ ready: true })
  expect(f.documents.map(document => document.text)).toEqual(original)
})
it.each(['log-directory', 'foreign-experiment', 'traversal'] as const)('rejects result checkpoint substitutions with a verified state copy: %s', change => {
  const f = copiedCheckpointFixture(), evaluation = f.documents.find(document => document.source.path === 'eval.json')!
  const prefix = `/data/runs/${f.registration.experimentId}/workspace/`
  evaluation.text = JSON.stringify({ n: 50, eval_loss: 1.4, adapter_path: prefix + 'checkpoint-230' })
  expect(f.verify().ready).toBe(true)
  const path = change === 'log-directory' ? 'logs/train2' : change === 'foreign-experiment'
    ? `/data/runs/${randomUUID()}/workspace/checkpoint-230` : prefix + '../workspace/checkpoint-230'
  evaluation.text = JSON.stringify({ n: 50, eval_loss: 1.4, adapter_path: path })
  expect(f.verify()).toMatchObject({ ready: false,
    checks: expect.arrayContaining([expect.objectContaining({ code: 'result-identity', passed: false })]) })
})
it.each(['hash', 'content', 'truncated', 'foreign-node', 'unapproved'] as const)('rejects an unconfirmed native checkpoint alias: %s', change => {
  const f = copiedCheckpointFixture()
  if (change === 'hash') f.checkpoint.source.sha256 = 'b'.repeat(64)
  if (change === 'content') f.checkpoint.text = '{"global_step":229}'
  if (change === 'truncated') f.checkpoint.truncated = true
  if (change === 'foreign-node') f.checkpoint.source.serverId = stageRegistrationSchema.shape.serverId.parse(randomUUID())
  if (change === 'unapproved') f.registration.requirement.requiredFiles = []
  expect(f.verify()).toMatchObject({ ready: false,
    checks: expect.arrayContaining([expect.objectContaining({ code: 'result-identity', passed: false })]) })
})
it('validates native intermediate saving when the registered state filename is a log snapshot', () => {
  const f = fixture(), args = z.record(z.string(), z.unknown()).parse(JSON.parse(f.documents[0]!.text))
  f.registration.requirement.requiredFiles.push('checkpoint-200/trainer_state.json', 'checkpoint-230/trainer_state.json')
  Object.assign(args, { save_strategy: 'steps', save_steps: 200, save_total_limit: 2 })
  const state = { save_steps: 30 }
  const verify = () => verifyStageParameters(f.registration.requirement, JSON.stringify(args), 'logs/train2/trainer_state.json', state)
  expect(verify).toThrow('checkpoint-200')
  state.save_steps = 50
  expect(verify).not.toThrow()
})
it.each(['array', 'object', 'jsonl'] as const)('checks every reload response and identity in %s evidence', format => {
  const f = fixture()
  f.registration.requirement.results = { inferencePrompts: 2, baseControl: false }
  f.registration.inference = 'reload.jsonl'; f.registration.attemptLabel = 'phase2b'
  f.documents.find(value => value.source.path === 'metrics.jsonl')!.text = JSON.stringify(f.metrics.map(row => ({ ...row, attempt_id: 'phase2b' })))
  const samples = f.documents.find(value => value.source.path === 'samples.jsonl')!
  samples.text = JSON.stringify(z.array(z.record(z.string(), z.unknown())).parse(JSON.parse(samples.text)).map(row => ({ ...row, attempt_id: 'phase2b' })))
  const rows = [{ adapter_path: 'checkpoint-230', attempt_id: 'phase2b', response: 'First held-out answer' },
    { adapter_path: 'checkpoint-230', attempt_id: 'phase2b', response: 'Second held-out answer' }]
  const encode = () => format === 'jsonl' ? rows.map(row => JSON.stringify(row)).join('\n') + '\n'
    : JSON.stringify(format === 'array' ? rows : { adapter_path: 'checkpoint-230', attempt_id: 'phase2b', results: rows })
  const document = { source: { ...f.documents[0]!.source, path: 'reload.jsonl', purpose: 'inference' as const }, text: encode(), truncated: false }
  f.documents.push(document)
  expect(f.verify()).toMatchObject({ ready: true })
  rows[1]!.adapter_path = 'checkpoint-30'; document.text = encode()
  expect(f.verify()).toMatchObject({ ready: false,
    checks: expect.arrayContaining([expect.objectContaining({ code: 'result-identity', passed: false })]) })
  rows[1]!.adapter_path = 'checkpoint-230'; rows[1]!.attempt_id = 'old-attempt'; document.text = encode()
  expect(f.verify()).toMatchObject({ ready: false,
    checks: expect.arrayContaining([expect.objectContaining({ code: 'result-identity', passed: false })]) })
  const mismatch = f.verify().checks.find(value => value.code === 'result-identity')!.detail
  for (const value of ['reload.jsonl', 'phase2b', 'old-attempt']) expect(mismatch).toContain(value)
})
it('reads original evaluation and generation records without rewriting their fields', () => {
  const f = fixture()
  f.registration.requirement.results = { evaluationSamples: 50, inferencePrompts: 2, baseControl: true }
  f.registration.evaluation = 'original-eval.json'; f.registration.inference = 'original-infer.json'; f.registration.baseControl = 'original-base.json'
  const evaluation = { mode: 'eval', evaluatedSamples: 50, meanLossPerSupervisedToken: 1.4, adapter: 'checkpoint-230' }
  const rows = [{ promptId: 'val-000', output: 'First recorded response', adapterPath: 'checkpoint-230' },
    { promptId: 'val-001', output: 'Second recorded response', adapterPath: 'checkpoint-230' }]
  const add = (path: string, value: unknown) => f.documents.push({ source: { ...f.documents[0]!.source, path }, text: JSON.stringify(value), truncated: false })
  add(f.registration.evaluation, evaluation)
  add(f.registration.inference, { mode: 'infer', adapter: 'checkpoint-230', rows })
  add(f.registration.baseControl, { mode: 'base', adapter: null, adapterApplied: false, rows: [{ promptId: 'val-000', response: 'Original base-only response' }] })
  expect(f.verify()).toMatchObject({ ready: true })
  rows[1]!.adapterPath = 'checkpoint-30'
  f.documents.find(value => value.source.path === f.registration.inference)!.text = JSON.stringify({ mode: 'infer', adapter: 'checkpoint-230', rows })
  expect(f.verify()).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ code: 'result-identity', passed: false })]) })
  rows[1]!.adapterPath = 'checkpoint-230'
  f.documents.find(value => value.source.path === f.registration.inference)!.text = JSON.stringify({ mode: 'infer', adapter: 'checkpoint-230', rows })
  evaluation.evaluatedSamples = 49
  f.documents.find(value => value.source.path === f.registration.evaluation)!.text = JSON.stringify(evaluation)
  expect(f.verify()).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ code: 'evaluation', passed: false })]) })
  evaluation.evaluatedSamples = 50; evaluation.mode = 'unsupported'
  f.documents.find(value => value.source.path === f.registration.evaluation)!.text = JSON.stringify(evaluation)
  expect(f.verify()).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ code: 'evaluation', passed: false })]) })
})
