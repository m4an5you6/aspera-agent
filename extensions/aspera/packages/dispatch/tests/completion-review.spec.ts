/** Retrospective reviews preserve the failed task and only accept independently read existing evidence. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import { experimentIdSchema, serverIdSchema, legacyCompletionEvidenceError, planSchema, stageRegistrationInputSchema } from '@aspera/experiments'
import type { CompletionSourceInput, CompletionSupplement, ClusterRecord } from '@aspera/experiments'
import { CompletionReviews } from '../src/completion-review.ts'
import type { CompletionReviewOwner, CompletionReviewTools } from '../src/completion-review.ts'
import type { FleetExperiment } from '../src/types.ts'
import { redactCompletionData } from '../src/completion-data.ts'

const roots: string[] = [], services: CompletionReviews[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts', 'completion-')); roots.push(root)
  const id = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const submission = { protocol: 4, experimentId: id, nodes: [{ server: { id: serverId, name: 'CPU fixture' } }] }
  const original = fromAny<ClusterRecord, object>({ experimentId: id, revision: 3, state: 'failed', resourcesReleased: true,
    submission, sessionId: 'original-execution', updatedAt: 1000, detail: legacyCompletionEvidenceError,
    plan: { revision: 1, steps: ['Train, evaluate, save and reload existing results'] }, approval: { planRevision: 1 }, executions: [], services: [] })
  const record = fromAny<FleetExperiment, object>({ request: { experimentId: id }, submission, latest: original })
  const entry: CompletionSupplement['entry'] = { serverId, framework: 'ms-swift', version: '4.6.0', script: 'train.py', environment: 'pyenv',
    parameters: { steps: '57' }, artifacts: ['adapter.safetensors'], evaluation: { eval_loss: 1.65 } }
  const sources: CompletionSourceInput[] = (['framework', 'environment', 'script', 'parameters', 'training', 'evaluation', 'artifact', 'inference'] as const)
    .map(purpose => ({ serverId, path: purpose === 'script' ? 'train.py' : purpose === 'artifact' ? 'adapter.safetensors' : `${purpose}.json`, purpose }))
  let alive = true, tools: CompletionReviewTools | undefined
  const owner: CompletionReviewOwner = {
    get: requested => { if (!alive || requested !== id) throw new Error('Original experiment was deleted'); return record }, alive: requested => alive && requested === id,
    snapshot: vi.fn<CompletionReviewOwner['snapshot']>(async () => ({ record: structuredClone(original), finished: true,
      commands: [{ experimentId: id, serverId, commandId: 'train', command: 'pyenv/bin/python train.py', state: 'completed', exitCode: 0, released: true, streams: ['stdout', 'stderr'] }],
      progress: { version: 1, experimentId: id, planRevision: 1, sessionId: 'original-execution', revision: 1, updatedAt: 1000,
        steps: [{ step: 1, state: 'completed', updatedAt: 1000 }] } })),
    source: vi.fn<CompletionReviewOwner['source']>(async (_record, input) => ({ ...input, sha256: 'a'.repeat(64), generation: 'generation-1', bytes: 20,
      text: JSON.stringify({ steps: 57, eval_loss: 1.65 }), truncated: false })),
    environment: vi.fn<CompletionReviewOwner['environment']>(async () => ({ version: 1, kind: 'historical', serverId, path: 'pyenv', python: 'pyenv/bin/python', packages: { 'ms-swift': '4.6.0' }, digest: 'b'.repeat(64), checkedAt: 1000 })),
    commit: vi.fn(async () => {}), changed: vi.fn(), redact: (_record, data) => redactCompletionData(data, ['secret-value']), trace: vi.fn(async () => undefined),
    run: vi.fn<CompletionReviewOwner['run']>(async (_record, _review, value) => { tools = value; await value.record(JSON.stringify(entry), JSON.stringify(sources), 'record-1', new AbortController().signal); await value.verify(new AbortController().signal) }),
  }
  const make = (directory = root) => { const service = new CompletionReviews(directory, owner); services.push(service); return service }
  return { root, id, serverId, original, record, entry, sources, owner, make, tools: () => tools!, remove: () => { alive = false } }
}
async function settled(service: CompletionReviews, id: ReturnType<typeof experimentIdSchema.parse>) {
  await vi.waitFor(() => { expect(['passed', 'blocked', 'cancelled']).toContain(service.status(id)?.phase) })
}
function continuedFixture() {
  const f = fixture()
  f.entry.parameters = { max_steps: '230' }
  f.original.state = 'blocked'; f.original.detail = 'Agent reported context budget without completing finalization'; f.original.executions = [f.entry]
  f.original.plan = planSchema.parse({ revision: 1, createdAt: 1, summary: 'Approved continuation', steps: ['Complete existing continuation and finalization'], frameworks: [],
    stages: [{ stageId: 'phase2', title: 'Continue', planStep: 1, framework: 'transformers', startStep: 30, additionalSteps: 200, endStep: 230,
      metricScope: 'stage', loggingSteps: 1, scheduler: { mode: 'continue', type: 'cosine', learningRate: 0.0001, warmupSteps: 12, totalSteps: 230 } }] })
  const files = new Map<string, unknown>([
    ['outputs/checkpoint-230/trainer_state.json', { global_step: 230 }], ['outputs/checkpoint-30/trainer_state.json', { global_step: 30 }],
    ['parameters.json', { max_steps: 230 }],
    ['outputs/checkpoint-30/optimizer.pt', { fixture: 'Opaque original optimizer identity' }], ['outputs/checkpoint-30/scheduler.pt', { fixture: 'Opaque original scheduler identity' }], ['outputs/checkpoint-30/rng_state.pth', { fixture: 'Opaque original RNG identity' }],
    ['stage-args.json', { max_steps: 230, learning_rate: 0.0001, warmup_steps: 12, lr_scheduler_type: 'cosine', resume_from_checkpoint: 'outputs/checkpoint-30' }],
    ['stage-metrics.jsonl', Array.from({ length: 200 }, (_, index) => ({ step: index + 31, loss: 1.2,
      learning_rate: 0.0001 * 0.5 * (1 + Math.cos(Math.PI * (index + 31 - 12) / 218)) }))],
  ])
  const snapshot = f.owner.snapshot, source = f.owner.source
  f.owner.snapshot = vi.fn<CompletionReviewOwner['snapshot']>(async (record, signal) => {
    const result = await snapshot(record, signal)
    return { ...result, finishStatus: 'blocked' as const,
      progress: { ...result.progress!, steps: [{ step: 1, state: 'pending' as const, updatedAt: 1000 }] },
      files: [{ serverId: f.serverId, path: 'outputs/checkpoint-230/trainer_state.json', bytes: 100 },
        { serverId: f.serverId, path: 'outputs/checkpoint-230/adapter_model.safetensors', bytes: 100 }] }
  })
  f.owner.source = vi.fn<CompletionReviewOwner['source']>(async (record, input, signal) => {
    if (!files.has(input.path)) return source(record, input, signal)
    const text = JSON.stringify(files.get(input.path))
    return { ...input, text, sha256: createHash('sha256').update(text).digest('hex'), generation: 'original-generation', bytes: Buffer.byteLength(text), truncated: false }
  })
  const registration = stageRegistrationInputSchema.parse({ stageId: 'phase2', serverId: f.serverId, attemptId: 'original-attempt', commandId: 'train',
    parameters: 'stage-args.json', trainerState: 'outputs/checkpoint-230/trainer_state.json', resumeState: 'outputs/checkpoint-30/trainer_state.json', metrics: 'stage-metrics.jsonl' })
  return { ...f, files, registration }
}
it('supplements a released blocked continuation without rewriting its original step reports or starting training', async () => {
  const f = continuedFixture(), service = f.make(), before = JSON.stringify(f.original)
  f.owner.run = vi.fn<CompletionReviewOwner['run']>(async (_record, _review, tools, signal) => {
    expect((await tools.inspect(signal)).issues.map(value => value.code)).toContain('stages')
    await expect(tools.registerStage({ ...f.registration, previousAttemptId: f.registration.attemptId }, signal)).rejects.toThrow('cannot retry training')
    await tools.registerStage(f.registration, signal)
    expect(await tools.verifyStage(f.serverId, 'phase2', signal)).toMatchObject({ ready: true, startStep: 30, additionalSteps: 200, endStep: 230 })
    await tools.record(JSON.stringify(f.entry), JSON.stringify(f.sources), 'record', signal)
    const progress = await tools.progress(signal), revision = progress.assessment!.revision
    await expect(tools.reportStep({ step: 1, state: 'completed', detail: 'Existing stage and results verified', expectedRevision: revision - 1, sources: [f.sources[4]!] }, 'late', signal)).rejects.toThrow('revision conflict')
    await expect(tools.reportStep({ step: 1, state: 'not-applicable', detail: 'No new work', expectedRevision: revision, sources: [f.sources[4]!] }, 'skip', signal)).rejects.toThrow('conditional trigger')
    await tools.reportStep({ step: 1, state: 'completed', detail: 'Existing stage and results verified', expectedRevision: revision, sources: [f.sources[4]!] }, 'step', signal)
    expect(await tools.verify(signal)).toMatchObject({ phase: 'passed' })
  })
  service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)?.phase).toBe('passed'); expect(JSON.stringify(f.original)).toBe(before)
  expect(service.assessment(f.id)?.steps).toMatchObject([{ step: 1, state: 'completed' }])
  expect(f.owner.commit).toHaveBeenCalledOnce()
})
it('requires actual final checkpoint and blocked finish evidence before opening historical supplementation', async () => {
  const f = continuedFixture(); f.files.set('outputs/checkpoint-230/trainer_state.json', { global_step: 30 })
  const service = f.make(); service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)).toMatchObject({ phase: 'blocked', detail: expect.stringContaining('endpoint') })
  expect(f.owner.run).not.toHaveBeenCalled(); expect(f.owner.commit).not.toHaveBeenCalled()
})
it('lets the Agent correct unverified evidence paths at the current revision while preserving the original training identity', async () => {
  const f = continuedFixture(), service = f.make(), originalSource = f.owner.source
  f.owner.source = vi.fn<CompletionReviewOwner['source']>(async (...args) => {
    if (args[1].path === 'false') throw new Error('No such original evidence file: false')
    return originalSource(...args)
  })
  f.owner.run = vi.fn<CompletionReviewOwner['run']>(async (_record, _review, tools, signal) => {
    await tools.registerStage({ ...f.registration, baseControl: 'false' }, signal)
    expect(await tools.verifyStage(f.serverId, 'phase2', signal)).toMatchObject({ ready: false })
    const revision = (await tools.progress(signal)).assessment!.revision
    await expect(tools.registerStage(f.registration, signal)).rejects.toThrow('revision')
    await expect(tools.registerStage(f.registration, signal, revision - 1)).rejects.toThrow('revision')
    await expect(tools.registerStage(stageRegistrationInputSchema.parse({ ...f.registration, attemptId: 'another-training' }), signal, revision)).rejects.toThrow('identity')
    await tools.registerStage(f.registration, signal, revision)
    expect(service.assessment(f.id)!.verifications).toEqual([])
    const changedRevision = service.assessment(f.id)!.revision
    await tools.registerStage(f.registration, signal, revision)
    expect(service.assessment(f.id)!.revision).toBe(changedRevision)
    expect(await tools.verifyStage(f.serverId, 'phase2', signal)).toMatchObject({ ready: true })
    await expect(tools.registerStage({ ...f.registration, metrics: 'different.jsonl' }, signal,
      service.assessment(f.id)!.revision)).rejects.toThrow('already verified')
    await tools.block('Correction verified; original training and result preserved')
  })
  const before = JSON.stringify(f.original)
  service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)?.detail).toBe('Correction verified; original training and result preserved')
  expect(JSON.stringify(f.original)).toBe(before)
  expect(service.assessment(f.id)?.stages[0]).toMatchObject({ attemptId: f.registration.attemptId, commandId: 'train' })
  expect(service.assessment(f.id)?.stages[0]?.baseControl).toBeUndefined()
  expect(f.owner.commit).not.toHaveBeenCalled()
})
it('refuses a changed stage source during final verification even when both contents pass numeric checks', async () => {
  const f = continuedFixture(), service = f.make(), originalEnvironment = f.owner.environment
  f.owner.environment = vi.fn<CompletionReviewOwner['environment']>(async (...args) => {
    const result = await originalEnvironment(...args)
    if (service.status(f.id)?.phase === 'verifying') f.files.set('stage-args.json', { ...f.files.get('stage-args.json') as object, note: 'changed during commit' })
    return result
  })
  f.owner.run = vi.fn<CompletionReviewOwner['run']>(async (_record, _review, tools, signal) => {
    await tools.registerStage(f.registration, signal)
    await tools.record(JSON.stringify(f.entry), JSON.stringify(f.sources), 'record', signal)
    const progress = await tools.progress(signal)
    await tools.reportStep({ step: 1, state: 'completed', detail: 'Existing results', expectedRevision: progress.assessment!.revision, sources: [f.sources[4]!] }, 'step', signal)
    await tools.verify(signal)
  })
  service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)).toMatchObject({ phase: 'blocked', detail: expect.stringContaining('Stage evidence identity changed') })
  expect(f.owner.commit).not.toHaveBeenCalled()
})
it('records and verifies a separate assessment without changing the original failure or starting commands', async () => {
  const f = fixture(), service = f.make(), before = JSON.stringify(f.original)
  const first = service.request(f.id)
  expect(service.request(f.id).operationId).toBe(first.operationId)
  await settled(service, f.id)
  expect(service.status(f.id)).toMatchObject({ phase: 'passed', remoteCommitted: true, originalDetail: legacyCompletionEvidenceError, originalUpdatedAt: 1000 })
  expect(JSON.stringify(f.original)).toBe(before); expect(f.owner.run).toHaveBeenCalledOnce(); expect(f.owner.commit).toHaveBeenCalledOnce()
  expect(service.request(f.id).operationId).toBe(first.operationId)
  expect(JSON.parse(readFileSync(resolve(f.root, `${f.id}.v1.json`), 'utf8')).entries).toHaveLength(1)
})
it('cannot accept recorded training while independent recovered public generation is still missing', async () => {
  const f = fixture()
  f.owner.serviceIssues = vi.fn<NonNullable<CompletionReviewOwner['serviceIssues']>>(async () => [{ code: 'results', detail: 'Public generation has not passed on the retained checkpoint', remedy: 'Continue inference recovery; never retrain' }])
  f.owner.run = vi.fn<CompletionReviewOwner['run']>(async (_record, _review, tools, signal) => {
    await tools.record(JSON.stringify(f.entry), JSON.stringify(f.sources), 'record', signal)
    expect(await tools.verify(signal)).toMatchObject({ phase: 'collecting', check: { ready: false, issues: [expect.objectContaining({ code: 'results' })] } })
    await tools.block('Waiting for independent recovered serving evidence')
  })
  const service = f.make(); service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)?.phase).toBe('blocked'); expect(f.owner.commit).not.toHaveBeenCalled()
})
it('keeps the operation active when completion is requested before recording', async () => {
  const f = fixture(), service = f.make()
  f.owner.run = vi.fn<CompletionReviewOwner['run']>(async (_record, _review, tools, signal) => {
    expect(await tools.verify(signal)).toMatchObject({ phase: 'collecting', check: { ready: false } })
    expect((await tools.inspect(signal)).issues.map(issue => issue.code)).toContain('execution')
    await tools.record(JSON.stringify(f.entry), JSON.stringify(f.sources), 'supplement', signal)
    await tools.verify(signal)
  })
  service.request(f.id); await settled(service, f.id); expect(service.status(f.id)?.phase).toBe('passed')
})
it.each(['failed', 'blocked', 'cancelled', 'interrupted', 'running'] as const)('rejects unrelated %s outcomes', state => {
  const f = fixture(); f.original.state = state; f.original.detail = 'Actual training failed or was interrupted'
  expect(() => f.make().request(f.id)).toThrow('Only released'); expect(f.owner.run).not.toHaveBeenCalled()
})
it.each(['finish', 'release', 'plan', 'session'] as const)('requires original %s evidence before launching a supplementary Agent', async kind => {
  const f = fixture(), snapshot = await f.owner.snapshot(f.record, new AbortController().signal)
  if (kind === 'finish') snapshot.finished = false
  if (kind === 'release') snapshot.commands[0]!.released = false
  if (kind === 'plan') snapshot.record.plan!.revision++
  if (kind === 'session') snapshot.record.sessionId = 'other'
  f.owner.snapshot = vi.fn(async () => snapshot)
  const service = f.make(); service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)?.phase).toBe('blocked'); expect(f.owner.run).not.toHaveBeenCalled()
})
it.each(['node', 'source-node', 'parameter', 'evaluation', 'empty', 'environment', 'changed-source', 'script-command', 'environment-command'] as const)('rejects %s evidence without changing the old result', async kind => {
  const f = fixture()
  if (kind === 'node') f.entry.serverId = serverIdSchema.parse(randomUUID())
  if (kind === 'source-node') f.sources[0]!.serverId = serverIdSchema.parse(randomUUID())
  if (kind === 'parameter') f.entry.parameters.steps = '999'
  if (kind === 'evaluation') f.entry.evaluation.eval_loss = 0
  if (kind === 'script-command') { f.entry.script = 'unused.py'; f.sources.find(source => source.purpose === 'script')!.path = 'unused.py' }
  if (kind === 'environment-command') f.entry.environment = 'unused-environment'
  if (kind === 'empty') f.owner.source = vi.fn(async (_record, input) => ({ ...input, sha256: 'a'.repeat(64), generation: 'one', bytes: 0, text: '', truncated: false }))
  if (kind === 'environment') f.owner.environment = vi.fn(async () => { throw new Error('Historical environment metadata differs') })
  if (kind === 'changed-source') {
    let reads = 0
    f.owner.source = vi.fn(async (_record, input) => ({ ...input, sha256: ++reads > f.sources.length ? 'c'.repeat(64) : 'a'.repeat(64), generation: 'one', bytes: 20,
      text: JSON.stringify({ steps: 57, eval_loss: 1.65 }), truncated: false }))
  }
  const before = JSON.stringify(f.original), service = f.make(); service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)?.phase).toBe('blocked'); expect(f.owner.commit).not.toHaveBeenCalled(); expect(JSON.stringify(f.original)).toBe(before)
})
it('resumes a retained operation and does not mark remote unavailability as successful verification', async () => {
  const f = fixture(); f.owner.snapshot = vi.fn(async () => { throw new Error('SSH offline') })
  const service = f.make(), first = service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)).toMatchObject({ phase: 'blocked', detail: expect.stringContaining('offline') })
  const resumed = f.make(); expect(resumed.request(f.id).operationId).toBe(first.operationId); await settled(resumed, f.id)
  expect(f.owner.commit).not.toHaveBeenCalled()
})
it('cancels only the supplementary operation and refuses late writes after deletion', async () => {
  const f = fixture(), started = Promise.withResolvers<void>()
  f.owner.run = vi.fn<CompletionReviewOwner['run']>(async (_record, _review, _tools, signal) => { started.resolve(); await new Promise<void>((_resolveDone, reject) => signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })) })
  const service = f.make(); service.request(f.id); await started.promise; await service.stop(f.id)
  expect(service.status(f.id)?.phase).toBe('cancelled'); expect(f.original.state).toBe('failed')
  f.remove(); await service.forget(f.id)
  expect(existsSync(resolve(f.root, `${f.id}.v1.json`))).toBe(false); expect(service.status(f.id)).toBeUndefined()
})
it('rejects invalid durable review identity rather than accepting another experiment journal', () => {
  const f = fixture(); writeFileSync(resolve(f.root, `${f.id}.v1.json`), JSON.stringify({ version: 1, experimentId: randomUUID() }))
  expect(() => f.make()).toThrow()
})
it('does not infer a missing node from one recorded node', async () => {
  const f = fixture(), serverId = serverIdSchema.parse(randomUUID())
  f.original.submission = fromAny<ClusterRecord['submission'], object>({ ...f.original.submission, nodes: [...f.original.submission.nodes, { server: { id: serverId, name: 'Missing B' } }] })
  f.record.submission = f.original.submission
  const service = f.make(); service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)).toMatchObject({ phase: 'blocked', check: { ready: false } })
  expect(service.status(f.id)?.check?.issues.some(issue => issue.serverId === serverId)).toBe(true)
  expect(f.owner.commit).not.toHaveBeenCalled()
})
it('deduplicates repeated recording and serializes concurrent verification', async () => {
  const f = fixture(), service = f.make()
  f.owner.run = vi.fn<CompletionReviewOwner['run']>(async (_record, _review, tools, signal) => {
    await tools.record(JSON.stringify(f.entry), JSON.stringify(f.sources), 'first', signal)
    const revision = service.status(f.id)!.revision
    await tools.record(JSON.stringify(f.entry), JSON.stringify(f.sources), 'repeat', signal)
    expect(service.status(f.id)!.revision).toBe(revision)
    const results = await Promise.allSettled([tools.verify(signal), tools.verify(signal)])
    expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  })
  service.request(f.id); await settled(service, f.id)
  expect(f.owner.commit).toHaveBeenCalledOnce(); expect(service.status(f.id)?.entries).toHaveLength(1)
})
it('reports remote receipt failures without publishing a passing display result', async () => {
  const f = fixture(); f.owner.commit = vi.fn(async () => { throw new Error('Receipt write failed') })
  const service = f.make(); service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)).toMatchObject({ phase: 'blocked', remoteCommitted: false, detail: expect.stringContaining('write failed') })
  expect(f.original.state).toBe('failed')
})
it('restores an unfinished operation and rechecks sources after Host restart', async () => {
  const f = fixture(), first = f.make(); first.request(f.id); await settled(first, f.id)
  const saved = first.status(f.id)!, root = resolve(f.root, 'restarted'); mkdirSync(root)
  writeFileSync(resolve(root, `${f.id}.v1.json`), JSON.stringify({ ...saved, phase: 'verifying', remoteCommitted: false }))
  const restarted = f.make(root); restarted.resume(); await settled(restarted, f.id)
  expect(restarted.status(f.id)).toMatchObject({ operationId: saved.operationId, sessionId: saved.sessionId, phase: 'passed' })
  expect(f.owner.environment).toHaveBeenCalled()
})
it('keeps the review blocked if its local journal cannot commit after remote verification', async () => {
  const f = fixture(), file = resolve(f.root, `${f.id}.v1.json`)
  f.owner.commit = vi.fn(async () => { rmSync(file); mkdirSync(file) })
  const service = f.make(); service.request(f.id); await settled(service, f.id)
  expect(service.status(f.id)).toMatchObject({ phase: 'blocked', remoteCommitted: false, detail: expect.stringContaining('journal could not be saved') })
  expect(f.original.state).toBe('failed')
})
it('rejects a source reply arriving after cancellation without recording it', async () => {
  const f = fixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), read = f.owner.source
  f.owner.source = vi.fn<CompletionReviewOwner['source']>(async (...args) => { started.resolve(); await release.promise; return read(...args) })
  const service = f.make(); service.request(f.id); await started.promise
  const stopping = service.stop(f.id); release.resolve(); await stopping
  expect(service.status(f.id)).toMatchObject({ phase: 'cancelled', entries: [] })
  expect(f.owner.commit).not.toHaveBeenCalled()
})
it('preserves JSON framing when redacting quoted credentials in nested review events', async () => {
  const f = fixture(), service = f.make()
  f.owner.redact = (_record, data) => redactCompletionData(data, ['credential-with-"quotes'])
  f.owner.run = vi.fn(async (_record, review, tools, signal) => {
    tools.event({ experimentId: f.id, phase: 'execution', sessionId: review.sessionId, seq: 0, time: 1000,
      type: 'assistant/message', truncated: false, data: JSON.stringify({ message: { content: [{ type: 'text',
        text: JSON.stringify({ password: 'credential-with-"quotes', headers: { authorization: 'Bearer private-token' } }) },
      { type: 'text', text: 'hf_token: private-value"\nReview diagnostics' }] } }) })
    await tools.block('Review paused after recording a diagnostic event')
    signal.throwIfAborted()
  })
  service.request(f.id); await settled(service, f.id)
  const page = await service.trace({ experimentId: f.id, phase: 'execution' })
  expect(page.records).toHaveLength(1)
  const data = JSON.parse(page.records[0]!.data)
  expect(JSON.parse(data.message.content[0].text)).toEqual({ password: '[redacted]', headers: { redacted: true } })
})
it('reports all mismatched fields with available structured evidence in one recording attempt', async () => {
  const f = fixture(), service = f.make()
  let detail = ''
  f.entry.parameters = { steps: '999', epochs: '2' }; f.entry.evaluation = { eval_loss: 0, missing_metric: 1 }
  f.entry.artifacts = ['missing.safetensors']
  f.owner.run = vi.fn(async (_record, _review, tools, signal) => {
    try { await tools.record(JSON.stringify(f.entry), JSON.stringify(f.sources), 'mismatch', signal) }
    catch (error) { detail = String(error) }
    await tools.block(detail)
  })
  service.request(f.id); await settled(service, f.id)
  for (const field of ['steps', 'epochs', 'eval_loss', 'missing_metric', 'missing.safetensors']) expect(detail).toContain(field)
  expect(detail).toContain('available')
  expect(f.owner.commit).not.toHaveBeenCalled()
})
it('hashes each source path once per recording when it supports multiple evidence purposes', async () => {
  const f = fixture(), service = f.make()
  f.sources.find(source => source.purpose === 'framework')!.path = 'shared-metadata.json'
  f.sources.find(source => source.purpose === 'environment')!.path = 'shared-metadata.json'
  f.owner.run = vi.fn(async (_record, _review, tools, signal) => {
    await tools.record(JSON.stringify(f.entry), JSON.stringify(f.sources), 'shared', signal)
    await tools.block('Source observation complete')
  })
  service.request(f.id); await settled(service, f.id)
  expect(f.owner.source).toHaveBeenCalledTimes(new Set(f.sources.map(source => source.path)).size)
})
it('reads the original supplementary Session when an older redacted JSONL copy is corrupt', async () => {
  const f = fixture(), service = f.make()
  f.owner.run = vi.fn(async (_record, _review, tools) => { await tools.block('Review diagnostic retained') })
  const review = service.request(f.id); await settled(service, f.id)
  writeFileSync(resolve(f.root, `${f.id}.${review.operationId}.events.jsonl`), '{"data":"broken"quote"}\n')
  const event = { experimentId: f.id, phase: 'execution' as const, sessionId: review.sessionId, seq: 0, time: 1000,
    type: 'assistant/message', data: JSON.stringify({ text: 'Original persisted review evidence' }), truncated: false }
  f.owner.trace = vi.fn(async () => ({ records: [event], hasMore: false, missing: false, reset: false }))
  expect((await service.trace({ experimentId: f.id, phase: 'execution' })).records).toEqual([event])
  expect(readFileSync(resolve(f.root, `${f.id}.${review.operationId}.events.jsonl`), 'utf8')).toContain('broken"quote')
})
