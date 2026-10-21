/** Legacy requirements are interpreted only from explicit immutable plan numbers. */
import { expect, it } from 'vitest'
import { planSchema } from '@aspera/experiments'
import { legacyTrainingStages } from '../src/legacy-stages.ts'

const objective = '单卡先完成 30 个优化器步，通过后自动续训 200 步，累计 global_step = 230。'
const plan = planSchema.parse({ revision: 1, createdAt: 1, summary: 'Original continuation', frameworks: [], steps: [
  '配置 learning_rate=1e-4 warmup_steps=12 lr_scheduler_type=cosine per_device_train_batch_size=1 gradient_accumulation_steps=8，每 5 个优化器步记录；累计样本 1840，450/50。',
  '阶段一正式训练，保存 checkpoint-30。', '阶段二续训，恢复原 scheduler 至累计 230；完整 50 条评估，固定 5 条重载推理与基座对照。',
] })
it('keeps the original 30 plus 200 arithmetic and scheduler horizon', () => {
  const stages = legacyTrainingStages(objective, plan)
  expect(stages).toHaveLength(2)
  expect(stages[1]).toMatchObject({ startStep: 30, additionalSteps: 200, endStep: 230, loggingSteps: 5,
    scheduler: { mode: 'continue', totalSteps: 230, warmupSteps: 12 }, samples: { expectedCount: 1600, firstIndex: 240 },
    results: { evaluationSamples: 50, inferencePrompts: 5, baseControl: true } })
})
it('does not infer absent or contradictory training targets', () => {
  expect(legacyTrainingStages(objective.replace('230', '200'), plan)).toEqual([])
  expect(legacyTrainingStages('Training was reportedly completed', plan)).toEqual([])
  expect(legacyTrainingStages(objective, { ...plan, steps: plan.steps.map(step => step.replace('warmup_steps=12', 'warmup not specified')) })).toEqual([])
})
