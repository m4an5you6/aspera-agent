/** Fixed user requirements reject plan drift before commands or resource allocation. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { deploymentIdSchema, planInputSchema, planRequirementIssues, planRequirementsSchema, planSchema } from '@aspera/experiments'
import { assertSubmittedPlanRequirements, loadPlanRequirements, PLAN_REQUIREMENTS_INPUT } from '../src/plan-requirements.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts', 'plan-requirements-')); roots.push(root)
  mkdirSync(resolve(root, 'inputs'))
  const stages = [0, 1].map(index => ({ stageId: 'stage' + (index + 1), planStep: index + 1, title: 'Training', framework: 'transformers',
    startStep: index ? 30 : 0, additionalSteps: index ? 200 : 30, endStep: index ? 230 : 30, metricScope: index ? 'cumulative' : 'stage', loggingSteps: 5,
    scheduler: { mode: index ? 'continue' : 'fresh', type: 'cosine', learningRate: 0.0001, warmupSteps: 12, totalSteps: 230 },
    requiredFiles: ['optimizer.pt', 'scheduler.pt'], results: { evaluationSamples: 50, inferencePrompts: index ? 5 : 2, baseControl: !!index } }))
  const requirements = planRequirementsSchema.parse({ version: 1, stepCount: 2, stages, storagePolicy: { artifact: 'adapter', checkpointCount: 3,
    optimizerState: true, schedulerState: true, recoveryPoints: ['checkpoint-30', 'checkpoint-230'], outputMinimumBytes: 0, checkpointMinimumBytes: 0,
    basis: 'Required saved content' } })
  const bytes = JSON.stringify(requirements), file = resolve(root, 'inputs', PLAN_REQUIREMENTS_INPUT)
  writeFileSync(file, bytes)
  const submission = { inputs: [{ name: PLAN_REQUIREMENTS_INPUT, sha256: deploymentIdSchema.parse(createHash('sha256').update(bytes).digest('hex')) }] }
  const plan = planInputSchema.parse({ summary: 'Model-written details', steps: ['Stage one', 'Stage two'], frameworks: [], stages,
    storagePolicy: requirements.storagePolicy })
  return { root, file, requirements, submission, plan }
}
it('loads only declared requirements and rejects changed bytes before parsing them', () => {
  const f = fixture()
  expect(loadPlanRequirements(f.submission, f.root)?.requirements).toEqual(f.requirements)
  expect(loadPlanRequirements({ inputs: [] }, f.root)).toBeUndefined()
  writeFileSync(f.file, readFileSync(f.file, 'utf8') + ' ')
  expect(() => loadPlanRequirements(f.submission, f.root)).toThrow('submitted digest')
})
it('rejects inferred samples, restarted continuation, extra checkpoint sets and substituted evidence files', () => {
  const f = fixture(), second = f.plan.stages![1]!
  const proposed = planInputSchema.parse({ ...f.plan, stages: [f.plan.stages![0], { ...second,
    scheduler: { ...second.scheduler, mode: 'restart' }, requiredFiles: ['zero_to_fp32.py'],
    samples: { unit: 'example', meaning: 'consumed', expectedCount: 1600, basis: '200*8', perDeviceBatchSize: 1, gradientAccumulationSteps: 8, worldSize: 1 } }],
    storagePolicy: { ...f.plan.storagePolicy, checkpointCount: 5, checkpointMinimumBytes: 779010048 } })
  expect(planRequirementIssues(proposed, f.requirements).map(row => row.path)).toEqual(expect.arrayContaining([
    'stages.1.samples', 'stages.1.scheduler.mode', 'stages.1.requiredFiles', 'storagePolicy.checkpointCount', 'storagePolicy.checkpointMinimumBytes' ]))
  expect(() => assertSubmittedPlanRequirements(f.submission, f.root, planSchema.parse({ ...proposed, revision: 1, createdAt: 1 }))).toThrow('submitted requirements')
  expect(() => assertSubmittedPlanRequirements(f.submission, f.root, planSchema.parse({ ...f.plan, revision: 1, createdAt: 1 }))).not.toThrow()
})
it('permits narrative and estimation explanations while matching file sets independently of order', () => {
  const f = fixture()
  const changed = planInputSchema.parse({ ...f.plan, summary: 'Updated explanation ' + randomUUID(), stages: f.plan.stages?.map(stage => ({ ...stage,
    title: 'Actual execution detail', requiredFiles: [...stage.requiredFiles].reverse() })), storagePolicy: { ...f.plan.storagePolicy, basis: 'New measured size estimate' } })
  expect(planRequirementIssues(changed, f.requirements)).toEqual([])
})
it.skipIf(process.platform === 'win32')('rejects a requirements symlink outside the owned input directory', () => {
  const f = fixture(), outside = resolve(f.root, 'outside.json')
  writeFileSync(outside, readFileSync(f.file)); rmSync(f.file); symlinkSync(outside, f.file)
  expect(() => loadPlanRequirements(f.submission, f.root)).toThrow()
})
