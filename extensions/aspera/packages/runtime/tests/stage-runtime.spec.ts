/** Stage launch checks retain the approved parameters and original command identity. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, experimentStageIdSchema, planSchema, stageRegistrationInputSchema, stageAttemptTransitionSchema, stageVerificationSchema } from '@aspera/experiments'
import { StageRegistry, stageSources, type StageReader } from '../src/stage-runtime.ts'
import { finalizationPolicySchema } from '../src/finalization-policy.ts'
import { inspectCompletionFile } from '../scripts/completion-files.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts', 'stages-')); roots.push(root)
  const id = experimentIdSchema.parse(randomUUID())
  const request = stageRegistrationInputSchema.parse({ stageId: 'first', serverId: randomUUID(), attemptId: 'attempt1', commandId: 'train', parameters: 'args.json', trainerState: 'state.json', metrics: 'metrics.jsonl' })
  const plan = planSchema.parse({ revision: 1, createdAt: 1, summary: 'Approved two-step smoke', steps: ['Train'], frameworks: [],
    stages: [{ stageId: 'first', title: 'Smoke', planStep: 1, framework: 'transformers', startStep: 0, additionalSteps: 2, endStep: 2,
      metricScope: 'stage', loggingSteps: 1, scheduler: { mode: 'fresh', type: 'linear', learningRate: 0.0001, warmupSteps: 0, totalSteps: 2 } }] })
  const document = { source: { serverId: request.serverId, path: request.parameters, purpose: 'parameters' as const, bytes: 100, generation: 'first', sha256: 'a'.repeat(64) },
    text: JSON.stringify({ max_steps: 2, learning_rate: 0.0001, warmup_steps: 0, lr_scheduler_type: 'linear' }), truncated: false }
  const source = vi.fn<StageReader['source']>(async () => document), command = vi.fn<StageReader['command']>(async () => undefined)
  const retain = vi.fn(async () => {})
  const create = () => new StageRegistry(root, id, 'execution', { source, command }, finalizationPolicySchema.parse({}), retain)
  return { root, id, request, plan, document, source, command, retain, create, signal: new AbortController().signal }
}
async function failedFixture() {
  const f = fixture(), registry = f.create(), original = await registry.register(f.request, f.plan, f.signal)
  f.command.mockImplementation(async (_serverId, commandId) => commandId === f.request.commandId
    ? { commandId, state: 'failed', exitCode: 1, released: true } : undefined)
  const retry = stageRegistrationInputSchema.parse({ ...f.request, previousAttemptId: original.attemptId, attemptId: 'attempt2', commandId: 'train-retry',
    trainerState: 'attempt2/state.json', metrics: 'attempt2/metrics.jsonl' })
  return { ...f, registry, original, retry,
    anchor: resolve(f.root, 'stage-acceptance-v1', f.request.serverId + '_' + f.request.stageId + '.registration.json'),
    successor: resolve(f.root, 'stage-attempts-v1', f.request.serverId + '_' + f.request.stageId, f.request.attemptId + '.json') }
}
it('restores an identical registration and refuses changing the approved attempt', async () => {
  const f = fixture(), first = await f.create().register(f.request, f.plan, f.signal)
  expect(await f.create().register(f.request, f.plan, f.signal)).toEqual(first)
  await expect(f.create().register({ ...f.request, attemptId: f.request.stageId }, f.plan, f.signal)).rejects.toThrow('changed')
  await expect(f.create().register(f.request, { ...f.plan, revision: 2 }, f.signal)).rejects.toThrow('changed')
})
it('explains a successful original command before suggesting separate retry paths', async () => {
  const f = fixture(), registry = f.create()
  await registry.register(f.request, f.plan, f.signal)
  f.command.mockResolvedValue({ commandId: f.request.commandId, state: 'completed', exitCode: 0, released: true })
  const retry = stageRegistrationInputSchema.parse({ ...f.request, previousAttemptId: f.request.attemptId,
    attemptId: 'retry-formatting', commandId: 'retry-formatting' })
  await expect(registry.register(retry, f.plan, f.signal)).rejects.toThrow('Preserve successful checkpoints')
  expect(f.source).toHaveBeenCalledTimes(1)
})
it('checks actual parameter values before launch and rejects a later replacement', async () => {
  const f = fixture(), registry = f.create(); await registry.register(f.request, f.plan, f.signal)
  await registry.beforeLaunch(f.request.serverId, 'train', f.signal)
  f.document.source.generation = 'replacement'
  await expect(registry.beforeLaunch(f.request.serverId, 'train', f.signal)).rejects.toThrow('changed')
  await registry.beforeLaunch(f.request.serverId, 'diagnostic', f.signal)
})
it('rejects an unscheduled approved recovery point before registering or launching the stage', async () => {
  const f = fixture(), registry = f.create(), spec = f.plan.stages![0]!
  spec.requiredFiles = ['checkpoint-1/trainer_state.json']
  const request = stageRegistrationInputSchema.parse({ ...f.request, trainerState: 'checkpoint-2/trainer_state.json' })
  const parameters = { max_steps: 2, learning_rate: 0.0001, warmup_steps: 0, lr_scheduler_type: 'linear', save_strategy: 'steps', save_steps: 2, save_total_limit: 2 }
  f.document.text = JSON.stringify(parameters)
  await expect(registry.register(request, f.plan, f.signal)).rejects.toThrow('checkpoint-1')
  expect(registry.list()).toEqual([])
  expect(f.retain).not.toHaveBeenCalled()
  f.document.text = JSON.stringify({ ...parameters, save_steps: 1 })
  const registered = await registry.register(request, f.plan, f.signal)
  expect(stageSources(registered)).toContainEqual({ path: 'checkpoint-1/trainer_state.json', purpose: 'training' })
  await registry.beforeLaunch(request.serverId, request.commandId, f.signal)
  expect(f.retain).toHaveBeenCalledTimes(1)
})
it('reads structured stage sources in full when the approved artifacts include the same files', async () => {
  const f = fixture(), workspace = resolve(f.root, 'workspace')
  mkdirSync(workspace)
  writeFileSync(resolve(f.root, '.aspera-owner.json'), JSON.stringify({ version: 1, experimentId: f.id, serverId: f.request.serverId }))
  const files = { 'args.json': f.document.text, 'state.json': '{"global_step":2}',
    'metrics.jsonl': [{ step: 1, loss: 1, learning_rate: 0.00005 }, { step: 2, loss: 0.9, learning_rate: 0 }].map(row => JSON.stringify(row)).join('\n'),
    'train.log': 'Original training output\n' }
  for (const [path, text] of Object.entries(files)) writeFileSync(resolve(workspace, path), text)
  f.plan.stages![0]!.requiredFiles = Object.keys(files)
  f.source.mockImplementation(async (serverId, path, purpose) => {
    const value = inspectCompletionFile({ runRoot: f.root, experimentId: f.id, serverId, path, metadataOnly: purpose === 'artifact', maxBytes: 4096 })
    return { source: { serverId, path, purpose, sha256: value.sha256, generation: value.generation, bytes: value.bytes }, text: value.text, truncated: value.truncated }
  })
  const registry = f.create(), registration = await registry.register(f.request, f.plan, f.signal)
  f.command.mockResolvedValue({ commandId: f.request.commandId, state: 'completed', exitCode: 0, released: true })
  const checked = await registry.verify(registration, f.signal)
  expect(checked).toMatchObject({ ready: true })
  expect(checked.sources.find(value => value.path === 'args.json')?.purpose).toBe('parameters')
  expect(checked.sources.find(value => value.path === 'metrics.jsonl')?.purpose).toBe('training')
  expect(checked.sources.find(value => value.path === 'train.log')?.purpose).toBe('artifact')
  expect(checked.sources).toHaveLength(4)
  writeFileSync(resolve(workspace, 'metrics.jsonl'), files['metrics.jsonl'].split('\n')[0]!)
  expect(await registry.verify(registration, f.signal)).toMatchObject({ ready: false,
    checks: expect.arrayContaining([expect.objectContaining({ code: 'metrics', passed: false })]) })
})
it('rejects an initial cadence that cannot produce a required approved continuation checkpoint', async () => {
  const f = fixture(), registry = f.create(), first = f.plan.stages![0]!
  f.plan.steps.push('Continue')
  f.plan.stages!.push({ ...first, stageId: experimentStageIdSchema.parse('second'), planStep: 2, startStep: 2, additionalSteps: 4, endStep: 6,
    scheduler: { ...first.scheduler, mode: 'continue', totalSteps: 6 }, requiredFiles: ['outputs/checkpoint-4/trainer_state.json'] })
  const args = JSON.parse(f.document.text)
  f.document.text = JSON.stringify({ ...args, save_strategy: 'steps', save_steps: 3 })
  await expect(registry.register(f.request, f.plan, f.signal)).rejects.toThrow('approved continuation second')
  expect(registry.list()).toEqual([])
  f.document.text = JSON.stringify({ ...args, save_strategy: 'steps', save_steps: 2 })
  expect(await registry.register(f.request, f.plan, f.signal)).toMatchObject({ stageId: 'first' })
})
it('uses native resumed save_steps instead of a replacement CLI value before registration and launch', async () => {
  const f = fixture(), registry = f.create(), requirement = f.plan.stages![0]!
  requirement.startStep = 30; requirement.additionalSteps = 200; requirement.endStep = 230
  requirement.scheduler.mode = 'continue'; requirement.scheduler.totalSteps = 230
  requirement.requiredFiles = ['outputs/checkpoint-200/trainer_state.json']
  const request = stageRegistrationInputSchema.parse({ ...f.request, resumeState: 'checkpoint-30/trainer_state.json', trainerState: 'outputs/checkpoint-230/trainer_state.json' })
  f.document.text = JSON.stringify({ max_steps: 230, learning_rate: 0.0001, warmup_steps: 0, lr_scheduler_type: 'linear',
    resume_from_checkpoint: 'checkpoint-30', save_strategy: 'steps', save_steps: 200, save_total_limit: 2 })
  const state = { global_step: 30, save_steps: 30 }
  f.source.mockImplementation(async (_serverId, path) => path === f.request.parameters ? f.document
    : { source: { ...f.document.source, path }, text: JSON.stringify(state), truncated: false })
  await expect(registry.register(request, f.plan, f.signal)).rejects.toThrow('original resumed TrainerState.save_steps=30')
  expect(registry.list()).toEqual([])
  state.save_steps = 200
  await registry.register(request, f.plan, f.signal)
  state.save_steps = 30
  await expect(registry.beforeLaunch(request.serverId, request.commandId, f.signal)).rejects.toThrow('original resumed TrainerState.save_steps=30')
  expect(f.retain).not.toHaveBeenCalled()
})
it('rejects an unreadable or wrong-step resume state before committing an immutable attempt', async () => {
  const f = fixture(), requirement = f.plan.stages![0]!
  requirement.startStep = 1; requirement.additionalSteps = 1; requirement.scheduler.mode = 'continue'
  f.document.text = JSON.stringify({ max_steps: 2, learning_rate: 0.0001, warmup_steps: 0, lr_scheduler_type: 'linear', resume_from_checkpoint: 'checkpoint-1' })
  const request = stageRegistrationInputSchema.parse({ ...f.request, resumeState: 'checkpoint-1' })
  f.source.mockImplementation(async (_serverId, path) => {
    if (path === f.request.parameters) return f.document
    if (path === 'checkpoint-1') throw new Error('Evidence source is a directory')
    return { source: { ...f.document.source, path }, text: '{"global_step":0}', truncated: false }
  })
  await expect(f.create().register(request, f.plan, f.signal)).rejects.toThrow('resume')
  expect(f.create().list()).toEqual([])
  request.resumeState = 'checkpoint-1/trainer_state.json'
  await expect(f.create().register(request, f.plan, f.signal)).rejects.toThrow('resume')
  expect(f.create().list()).toEqual([])
  f.source.mockImplementation(async (_serverId, path) => path === f.request.parameters ? f.document
    : { source: { ...f.document.source, path }, text: '{"global_step":1}', truncated: false })
  expect(await f.create().register(request, f.plan, f.signal)).toMatchObject({ resumeState: request.resumeState })
})
it('requires filenames for approved result and sample checks before immutable registration', async () => {
  const f = fixture(), requirement = f.plan.stages![0]!
  requirement.results = { evaluationSamples: 2, inferencePrompts: 2, baseControl: true }
  requirement.samples = { unit: 'example', meaning: 'consumed', expectedCount: 2, basis: 'Two complete single-example optimizer batches',
    perDeviceBatchSize: 1, gradientAccumulationSteps: 1, worldSize: 1 }
  f.document.text = JSON.stringify({ max_steps: 2, learning_rate: 0.0001, warmup_steps: 0, lr_scheduler_type: 'linear',
    per_device_train_batch_size: 1, gradient_accumulation_steps: 1, world_size: 1 })
  const approved = planSchema.parse(f.plan)
  await expect(f.create().register(f.request, approved, f.signal)).rejects.toThrow('evaluation, inference, baseControl, samples')
  expect(f.create().list()).toEqual([])
  const request = stageRegistrationInputSchema.parse({ ...f.request, evaluation: 'eval.json', inference: 'reload.jsonl', baseControl: 'base.jsonl', samples: 'samples.jsonl' })
  expect(await f.create().register(request, approved, f.signal)).toMatchObject({ baseControl: 'base.jsonl', samples: 'samples.jsonl' })
})
it('registers a distinct attempt after the original command failed and released its processes', async () => {
  const f = await failedFixture(), bytes = readFileSync(f.anchor)
  const accepted = await f.registry.register(f.retry, f.plan, f.signal)
  expect(accepted.attemptId).toBe(f.retry.attemptId); expect(accepted.commandId).toBe(f.retry.commandId)
  expect(readFileSync(f.anchor)).toEqual(bytes)
  const transition = stageAttemptTransitionSchema.parse(JSON.parse(readFileSync(f.successor, 'utf8')))
  expect(transition.previousCommand).toMatchObject({ commandId: f.request.commandId, exitCode: 1, released: true })
  expect(f.create().list()).toEqual([accepted])
  expect(await f.create().register(f.retry, f.plan, f.signal)).toEqual(accepted)
  await f.registry.beforeLaunch(f.request.serverId, f.retry.commandId, f.signal)
})
it.each(['running', 'unreleased', 'completed', 'missing', 'unknown-exit', 'zero-exit'] as const)('refuses a retry with an original %s command outcome', async state => {
  const f = await failedFixture()
  f.command.mockImplementation(async (_serverId, commandId) => commandId !== f.request.commandId || state === 'missing' ? undefined
    : { commandId, state: state === 'running' ? 'running' : state === 'completed' ? 'completed' : 'failed',
      released: state !== 'unreleased', exitCode: state === 'unknown-exit' ? null : state === 'completed' || state === 'zero-exit' ? 0 : 1 })
  await expect(f.registry.register(f.retry, f.plan, f.signal)).rejects.toThrow('confirmed failed and released')
  expect(f.registry.list()).toEqual([f.original])
})
it('rejects wrong predecessors, repeated command identities and reused failed output paths', async () => {
  const f = await failedFixture()
  await expect(f.registry.register({ ...f.retry, previousAttemptId: experimentStageIdSchema.parse('other') }, f.plan, f.signal)).rejects.toThrow('previousAttemptId')
  await expect(f.registry.register({ ...f.retry, commandId: f.request.commandId }, f.plan, f.signal)).rejects.toThrow('new commandId')
  await expect(f.registry.register({ ...f.retry, metrics: f.request.metrics }, f.plan, f.signal)).rejects.toThrow('separate')
  await expect(f.registry.register({ ...f.retry, resumeState: 'checkpoint/state.json' }, f.plan, f.signal)).rejects.toThrow('resume')
  expect(f.registry.list()).toEqual([f.original])
})
it('retains parameter and plan checks when selecting a retry', async () => {
  const f = await failedFixture()
  await expect(f.registry.register(f.retry, { ...f.plan, revision: 2 }, f.signal)).rejects.toThrow('approved requirements')
  f.document.source.generation = 'changed'
  await expect(f.registry.register(f.retry, f.plan, f.signal)).rejects.toThrow('original parameter source')
  f.document.source.generation = 'first'
  f.document.text = f.document.text.replace('"max_steps":2', '"max_steps":1')
  await expect(f.registry.register(f.retry, f.plan, f.signal)).rejects.toThrow('horizon')
})
it('commits only one of two concurrent successors without replacing the original registration', async () => {
  const f = await failedFixture(), bytes = readFileSync(f.anchor), gate = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>()
  let reads = 0
  f.source.mockImplementation(async () => { if (++reads === 2) reached.resolve(); await gate.promise; return f.document })
  const requests = [f.retry, { ...f.retry, attemptId: experimentStageIdSchema.parse('attempt3'), commandId: 'train-other' }]
  const pending = requests.map(request => f.create().register(request, f.plan, f.signal))
  await reached.promise; gate.resolve()
  const results = await Promise.allSettled(pending), accepted = results.find(result => result.status === 'fulfilled')
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  if (accepted?.status !== 'fulfilled') throw new Error('The concurrent requests did not publish a successor')
  expect(f.create().list()).toEqual([accepted.value])
  expect(readFileSync(f.anchor)).toEqual(bytes)
  expect(readdirSync(resolve(f.successor, '..'))).toEqual([f.request.attemptId + '.json'])
})
it('does not overwrite a concurrent initial registration', async () => {
  const f = fixture(), gate = Promise.withResolvers<void>(), reached = Promise.withResolvers<void>()
  let reads = 0
  f.source.mockImplementation(async () => { if (++reads === 2) reached.resolve(); await gate.promise; return f.document })
  const requests = [f.request, stageRegistrationInputSchema.parse({ ...f.request, attemptId: 'other', commandId: 'other-command' })]
  const pending = requests.map(request => f.create().register(request, f.plan, f.signal))
  await reached.promise; gate.resolve()
  const results = await Promise.allSettled(pending), accepted = results.find(result => result.status === 'fulfilled')
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
  if (accepted?.status !== 'fulfilled') throw new Error('No initial registration was published')
  expect(f.create().list()).toEqual([accepted.value])
})
it('retains failed verification evidence and refuses retrying a successfully verified stage', async () => {
  const f = await failedFixture(), path = resolve(f.root, 'stage-acceptance-v1', f.request.serverId + '_' + f.request.stageId + '.verification.json')
  const checked = stageVerificationSchema.parse({ version: 1, experimentId: f.original.experimentId, serverId: f.request.serverId,
    stageId: f.request.stageId, attemptId: f.request.attemptId, planRevision: 1, sessionId: 'execution', ready: true, checkedAt: 1,
    checks: [], sources: [], startStep: 0, additionalSteps: 2, endStep: 2 })
  writeFileSync(path, JSON.stringify(checked))
  await expect(f.registry.register(f.retry, f.plan, f.signal)).rejects.toThrow('successfully verified')
  checked.ready = false; checked.checks.push({ code: 'original-failure', passed: false, detail: 'Original failed command retained' })
  writeFileSync(path, JSON.stringify(checked))
  const bytes = readFileSync(path)
  await f.registry.register(f.retry, f.plan, f.signal)
  expect(stageAttemptTransitionSchema.parse(JSON.parse(readFileSync(f.successor, 'utf8'))).previousVerification).toEqual(checked)
  expect(readFileSync(path)).toEqual(bytes)
})
it('restores a chain of failed attempts and rejects reused historical identities and output paths', async () => {
  const f = await failedFixture(), firstBytes = readFileSync(f.anchor)
  await f.registry.register(f.retry, f.plan, f.signal)
  f.command.mockImplementation(async (_serverId, commandId) => [f.request.commandId, f.retry.commandId].includes(commandId)
    ? { commandId, state: 'failed', exitCode: 1, released: true } : undefined)
  const third = stageRegistrationInputSchema.parse({ ...f.retry, previousAttemptId: f.retry.attemptId, attemptId: 'attempt3', commandId: 'train-third',
    trainerState: 'attempt3/state.json', metrics: 'attempt3/metrics.jsonl' })
  await expect(f.registry.register({ ...third, attemptId: f.request.attemptId }, f.plan, f.signal)).rejects.toThrow('earlier attemptId')
  await expect(f.registry.register({ ...third, metrics: f.request.metrics }, f.plan, f.signal)).rejects.toThrow('separate')
  const accepted = await f.registry.register(third, f.plan, f.signal)
  expect(f.create().list()).toEqual([accepted]); expect(readFileSync(f.anchor)).toEqual(firstBytes)
  await expect(f.registry.register(f.request, f.plan, f.signal)).rejects.toThrow('confirmed failed and released original command')
})
it('retains the original attempt when a successor cannot be published and refuses corrupted successors', async () => {
  const f = await failedFixture(), directory = resolve(f.root, 'stage-attempts-v1'), bytes = readFileSync(f.anchor)
  writeFileSync(directory, 'not a directory')
  await expect(f.registry.register(f.retry, f.plan, f.signal)).rejects.toThrow()
  expect(readFileSync(f.anchor)).toEqual(bytes)
  unlinkSync(directory)
  expect(f.create().list()).toEqual([f.original])
  await f.registry.register(f.retry, f.plan, f.signal)
  const transition = stageAttemptTransitionSchema.parse(JSON.parse(readFileSync(f.successor, 'utf8')))
  transition.previousCommand.released = false
  writeFileSync(f.successor, JSON.stringify(transition))
  expect(() => f.create().list()).toThrow('confirmed failed predecessor')
})
it('refuses parameters that lower a target and a source from an unselected path', async () => {
  const f = fixture(); f.document.text = f.document.text.replace('"max_steps":2', '"max_steps":1')
  await expect(f.create().register(f.request, f.plan, f.signal)).rejects.toThrow('horizon')
  f.document.source.path = 'foreign.json'
  await expect(f.create().register(f.request, f.plan, f.signal)).rejects.toThrow('ownership')
})
