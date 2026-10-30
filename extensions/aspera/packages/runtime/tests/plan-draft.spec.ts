/** Planning repairs preserve the original draft and approval requirements. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { experimentIdSchema, planRequirementsSchema, planDraftEditSchema } from '@aspera/experiments'
import { SessionId } from '@deepseek-ai/dsh-session'
import { PlanDraft } from '../src/plan-draft.ts'
import { planToolParameters, planningToolParameters } from '../src/plan-tools.ts'
import { PLAN_REQUIREMENTS_INPUT } from '../src/plan-requirements.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const base = resolve('.artifacts'); mkdirSync(base, { recursive: true })
  const root = mkdtempSync(resolve(base, 'plan-draft-')); roots.push(root)
  const owner = { experimentId: experimentIdSchema.parse(randomUUID()), sessionId: SessionId('planning-fixture'), deploymentId: 'a'.repeat(64) }
  return { root, owner, draft: new PlanDraft(root, owner, 8192) }
}
const plan = () => ({ summary: 'Fixed plan', steps: ['Keep this long original requirement ' + '原文😀'.repeat(100), 'Continue training'],
  frameworks: [{ name: 'ms-swift', version: '4.5.3', documentation: 'https://swift.readthedocs.io/v4.5/' }],
  stages: [{ stageId: 's1', planStep: 1, title: 'Smoke', framework: 'transformers', startStep: 0, additionalSteps: 30, endStep: 30,
    metricScope: 'stage', loggingSteps: 1, scheduler: { mode: 'fresh', type: 'linear', learningRate: 0.0001, warmupSteps: 0, totalSteps: 30 },
    samples: { unit: 'example', meaning: 'consumed', expectedCount: 30, basis: 'Actual examples', perDeviceBatchSize: 1, gradientAccumulationSteps: 1, worldSize: 1 },
    requiredFiles: ['adapter/checkpoint'], results: { baseControl: true } }] })

it('commits a Transformers inference-only plan without inventing a training stage', async () => {
  const { root, owner, draft } = fixture()
  const input = { ...plan(), workload: 'inference', stages: [], summary: 'Restore the retained adapter without training',
    steps: ['Verify the retained adapter', 'Serve authenticated model generation'] }
  const result = await draft.import(input, 'inference-only')
  expect(result.issues).toEqual([])
  const saved = await draft.commit(result.revision)
  expect(saved.state).toBe('saved')
  expect(saved.plan).toMatchObject({ workload: 'inference', stages: [] })
  await expect(new PlanDraft(root, owner, 8192).read({ section: 'workload' })).resolves.toMatchObject({ text: '"inference"' })
})

it('lets the Agent repair only the workload classification in an inference draft', async () => {
  const { draft } = fixture()
  const invalid = await draft.import({ ...plan(), stages: [] }, 'legacy-framework-classification')
  expect(invalid.issues.some(issue => issue.path === 'stages')).toBe(true)
  const edited = await draft.edit({ requestId: 'declare-inference', expectedRevision: invalid.revision, workload: 'inference' })
  expect(edited.issues).toEqual([])
  expect((await draft.commit(edited.revision)).plan).toMatchObject({ workload: 'inference', stages: [] })
})

it('requires stages for legacy and explicitly declared Transformers training', async () => {
  for (const workload of [undefined, 'training']) {
    const { draft } = fixture()
    const result = await draft.import({ ...plan(), stages: [], ...(workload === undefined ? {} : { workload }) }, 'training')
    expect(result.state).toBe('invalid')
    expect(result.issues.some(issue => issue.path === 'stages')).toBe(true)
    expect((await draft.commit(result.revision)).state).toBe('invalid')
  }
})

it('rejects an inference classification that still contains a training stage', async () => {
  const { draft } = fixture()
  const result = await draft.import({ ...plan(), workload: 'inference' }, 'contradictory-workload')
  expect(result.state).toBe('invalid')
  expect(result.issues.some(issue => issue.path === 'stages')).toBe(true)
  expect((await draft.commit(result.revision)).state).toBe('invalid')
})

it('keeps submitted stage and retention requirements immutable while the Agent repairs its own draft', async () => {
  const { root, owner } = fixture(), reference = plan()
  const { samples: _samples, ...requiredStage } = reference.stages[0]!
  const requirements = planRequirementsSchema.parse({ version: 1, stepCount: 2, stages: [requiredStage], storagePolicy: {
    artifact: 'adapter', checkpointCount: 3, optimizerState: true, schedulerState: true, recoveryPoints: ['checkpoint-30', 'checkpoint-230'],
    outputMinimumBytes: 0, checkpointMinimumBytes: 0, basis: 'Required content; estimated sizes are separate' } })
  const source = { name: PLAN_REQUIREMENTS_INPUT, sha256: 'b'.repeat(64), requirements }
  const draft = new PlanDraft(root, owner, 8192, source)
  const noTraining = await draft.import({ ...reference, workload: 'inference', stages: [], storagePolicy: requirements.storagePolicy }, 'omit-required-training')
  expect(noTraining.state).toBe('invalid')
  expect(noTraining.issues.some(issue => issue.path.startsWith('stages'))).toBe(true)
  const invalid = await draft.import({ ...reference, storagePolicy: { ...requirements.storagePolicy, checkpointCount: 5 },
    stages: [{ ...reference.stages[0], requiredFiles: ['zero_to_fp32.py'] }] }, 'model-added-constraints')
  expect(invalid.state).toBe('invalid')
  expect(invalid.issues.map(issue => issue.path)).toEqual(expect.arrayContaining(['stages.0.samples', 'stages.0.requiredFiles', 'storagePolicy.checkpointCount']))
  expect((await draft.commit(invalid.revision)).state).toBe('invalid')
  const repaired = await draft.edit({ requestId: 'repair-only-rejected-fields', expectedRevision: invalid.revision,
    stages: [{ stageId: requiredStage.stageId, requiredFiles: requiredStage.requiredFiles }],
    removeStageFields: [{ stageId: requiredStage.stageId, fields: ['samples'] }], storagePolicy: requirements.storagePolicy })
  expect(repaired.issues).toEqual([])
  expect((await draft.commit(repaired.revision)).state).toBe('saved')
  expect((await draft.read({ section: 'requirements' }))).toMatchObject({ section: 'requirements', frozen: true })
  await expect(new PlanDraft(root, owner, 8192).validate()).rejects.toThrow('omitted')
  await expect(new PlanDraft(root, owner, 8192, { ...source, sha256: 'c'.repeat(64) }).validate()).rejects.toThrow('changed')
})

it('preserves a rejected full submission and repairs only the three incorrect fields', async () => {
  const { root, owner, draft } = fixture(), original = plan()
  const broken = { ...original, stages: original.stages.map(stage => ({ ...stage,
    samples: { ...stage.samples, unit: 'sequences', meaning: 'Examples consumed by training' }, results: { baseControl: 1 } })) }
  const rejected = await draft.import(broken, 'original-call')
  expect(rejected.state).toBe('invalid'); expect(rejected.issues.map(issue => issue.path)).toEqual(expect.arrayContaining([
    'stages.0.samples.unit', 'stages.0.samples.meaning', 'stages.0.results.baseControl']))
  const reopened = new PlanDraft(root, owner, 8192)
  const edit: Parameters<PlanDraft['edit']>[0] = { requestId: 'repair-call', expectedRevision: rejected.revision, stages: [{ stageId: 's1',
    samples: { unit: 'example', meaning: 'consumed' }, results: { baseControl: true } }] }
  const fixed = await reopened.edit(edit)
  expect(fixed.issues).toEqual([])
  expect(await reopened.edit(edit)).toEqual(fixed)
  const saved = await reopened.commit(fixed.revision)
  expect(saved.state).toBe('saved'); expect(saved.plan?.steps).toEqual(original.steps)
  expect(saved.plan?.stages?.[0]?.samples?.basis).toBe('Actual examples')
  expect(saved.plan?.stages?.[0]?.requiredFiles).toEqual(original.stages[0]?.requiredFiles)
  expect(JSON.parse(readFileSync(resolve(root, 'plan.json'), 'utf8')).sessionId).toBe(owner.sessionId)
  expect((await reopened.edit({ requestId: 'late-edit', expectedRevision: fixed.revision, summary: 'Changed' })).state).toBe('frozen')
  expect((await reopened.commit(fixed.revision)).plan).toEqual(saved.plan)
})

it('does not apply complete-plan defaults to omitted fields in a partial stage edit', async () => {
  const { draft } = fixture(), original = plan()
  const imported = await draft.import(original, 'original')
  const edited = await draft.edit({ requestId: 'only-one-field', expectedRevision: imported.revision,
    stages: [{ stageId: 's1', samples: { basis: 'A clarified counting explanation' }, results: {} }] })
  const saved = await draft.commit(edited.revision)
  expect(saved.plan?.stages?.[0]?.requiredFiles).toEqual(['adapter/checkpoint'])
  expect(saved.plan?.stages?.[0]?.results?.baseControl).toBe(true)
})

it('serializes edits from independent owners of the same draft and rejects stale revisions', async () => {
  const { root, owner, draft } = fixture(), second = new PlanDraft(root, owner, 8192)
  const results = await Promise.all([draft.edit({ requestId: 'first', expectedRevision: 0, summary: 'First' }),
    second.edit({ requestId: 'second', expectedRevision: 0, summary: 'Second' })])
  expect(results.map(value => value.state).sort()).toEqual(['conflict', 'invalid'])
  expect(results.map(value => value.revision)).toEqual([1, 1])
  await expect(draft.edit({ requestId: results[0]?.state === 'conflict' ? 'second' : 'first', expectedRevision: 0, summary: 'Different request' })).rejects.toThrow('request')
  expect((await draft.commit(1)).state).toBe('invalid')
})

it('builds sections in any order, keeps numbering stable and isolates sessions', async () => {
  const { root, owner, draft } = fixture()
  const first = await draft.edit({ requestId: 'step-first', expectedRevision: 0, steps: [{ step: 2, text: 'Second' }] })
  expect(first.state).toBe('invalid')
  const second = await draft.edit({ requestId: 'summary', expectedRevision: 1, summary: 'Summary', frameworks: [], steps: [{ step: 1, text: 'First' }] })
  expect(second.issues).toEqual([])
  const removed = await draft.edit({ requestId: 'remove', expectedRevision: 2, removeSteps: [1] })
  expect(removed.issues.some(issue => issue.path === 'steps.0')).toBe(true)
  await expect(new PlanDraft(root, { ...owner, deploymentId: 'b'.repeat(64) }, 8192).read({})).rejects.toThrow('owner')
  await expect(new PlanDraft(root, { ...owner, sessionId: SessionId('another-session') }, 8192).read({})).rejects.toThrow('owner')
})

it('exposes the exact nested literals and boolean type in the model tool declaration', () => {
  const text = JSON.stringify(planToolParameters)
  expect(text).toContain('microbatch'); expect(text).toContain('consumed'); expect(text).toContain('fetched')
  expect(text).toMatch(/baseControl.{0,40}boolean/)
})

it('accepts the published final-plan step texts as draft edits without dropping existing step numbers', async () => {
  const { draft } = fixture()
  const input = planDraftEditSchema.parse({ requestId: 'initial-text-steps', expectedRevision: 0,
    summary: 'Text steps from the plan schema', frameworks: [], steps: ['First', 'Second', 'Third'] })
  const initial = await draft.edit(input)
  expect(initial.issues).toEqual([])
  expect(await draft.edit(input)).toEqual(initial)
  const edited = await draft.edit(planDraftEditSchema.parse({ requestId: 'text-prefix', expectedRevision: 1, steps: ['Updated first'] }))
  const patched = await draft.edit({ requestId: 'numbered-patch', expectedRevision: edited.revision, steps: [{ step: 2, text: 'Updated second' }] })
  expect((await draft.commit(patched.revision)).plan?.steps).toEqual(['Updated first', 'Updated second', 'Third'])
})

it('projects both draft step formats into the real tool parameter declarations', () => {
  const declaration = planningToolParameters(planDraftEditSchema)
  const steps = declaration.steps
  expect(steps).toMatchObject({ type: 'array', items: { oneOf: [
    { type: 'string' }, { type: 'object', properties: { step: { type: 'integer' }, text: { type: 'string' } } },
  ] } })
})

it('rejects mixed step formats before saving and retains the original edit identity', async () => {
  const { draft } = fixture()
  await expect(draft.edit({ requestId: 'mixed', expectedRevision: 0, steps: ['First', { step: 2, text: 'Second' }] })).rejects.toThrow('do not mix')
  expect((await draft.validate()).revision).toBe(0)
  const input = planDraftEditSchema.parse({ requestId: 'same-edit', expectedRevision: 0, summary: 'Retained', frameworks: [], steps: ['First'] })
  await draft.edit(input)
  await expect(draft.edit({ ...input, steps: [{ step: 1, text: 'First' }] })).rejects.toThrow('identity')
  expect((await draft.commit(1)).plan?.steps).toEqual(['First'])
})

it('keeps page cursors revision-bound and rejects training arithmetic or missing stages at final commit', async () => {
  const { draft } = fixture(), original = plan()
  const imported = await draft.import(original, 'first')
  const page = JSON.parse(JSON.stringify(await draft.read({ section: 'steps' })))
  expect(page.text).toContain('Keep this long original requirement')
  const invalid = await draft.edit({ requestId: 'bad-arithmetic', expectedRevision: imported.revision, stages: [{ stageId: 's1', endStep: 500 }] })
  expect(invalid.issues.some(issue => issue.expected.includes('startStep'))).toBe(true)
  expect((await draft.commit(invalid.revision)).state).toBe('invalid')
  const stale = JSON.parse(JSON.stringify(await draft.read({ section: 'steps', revision: imported.revision })))
  expect(stale.state).toBe('conflict')
  const removed = await draft.edit({ requestId: 'no-stages', expectedRevision: invalid.revision, removeFields: ['stages'] })
  expect(removed.issues.some(issue => issue.path === 'stages')).toBe(true)
  expect((await draft.commit(removed.revision)).state).toBe('invalid')
})

it('reads large original requirements as complete Unicode pages without resending the plan', async () => {
  const { draft } = fixture(), original = plan()
  original.steps = Array.from({ length: 5 }, (_, index) => `Step ${index + 1} ` + '原始要求😀'.repeat(1000))
  await draft.import(original, 'large-plan')
  let query: Parameters<PlanDraft['read']>[0] = { section: 'steps' }, text = '', pages = 0
  for (;;) {
    const page = JSON.parse(JSON.stringify(await draft.read(query)))
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(8192)
    text += page.text; pages++
    if (page.next === undefined) break
    query = page.next
  }
  expect(pages).toBeGreaterThan(1); expect(JSON.parse(text)).toEqual(original.steps)
})
