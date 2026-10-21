/** Continuation acceptance uses cumulative steps, stage-local logs and the restored scheduler. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { stageRegistrationSchema } from '@aspera/experiments'
import type { CompletionSource } from '@aspera/experiments'
import { verifyTrainingStage } from '../src/stage-acceptance.ts'
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
it('rejects a missing recorded optimizer step even when the outer command exits zero', () => {
  const f = fixture(); f.metrics.splice(80, 1); f.documents.find(value => value.source.path === 'metrics.jsonl')!.text = JSON.stringify(f.metrics)
  expect(f.verify()).toMatchObject({ ready: false, checks: expect.arrayContaining([expect.objectContaining({ code: 'metrics', passed: false })]) })
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
