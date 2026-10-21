/** Narrow legacy interpretation recognizes explicit two-stage continuation requirements, never guessed targets. */
import { stageRequirementSchema } from '@aspera/experiments'
import type { ExperimentPlan, StageRequirement } from '@aspera/experiments'

/** @param objective - immutable original requirements. @param plan - original approved plan.
 * @returns structured stages only when fixed step arithmetic and all scheduler/batch values are explicit.
 */
export function legacyTrainingStages(objective: string, plan: ExperimentPlan): StageRequirement[] {
  if (plan.stages !== undefined) return plan.stages
  const text = [objective, ...plan.steps].join('\n')
  const initial = /先完成\s*(\d+)\s*个优化器/.exec(objective)?.[1]
  const extra = /(?:自动)?续训\s*(\d+)\s*步/.exec(objective)?.[1]
  const end = /累计\s*global_step\s*=\s*(\d+)/i.exec(objective)?.[1]
  const scalar = (key: string) => new RegExp(key + '\\s*=\\s*([\\d.eE+-]+)').exec(text)?.[1]
  const learningRate = scalar('learning_rate'), warmup = scalar('warmup_steps'), batch = scalar('per_device_train_batch_size'), accumulation = scalar('gradient_accumulation_steps')
  const scheduler = /lr_scheduler_type\s*=\s*(cosine|linear|constant)/.exec(text)?.[1]
  const first = plan.steps.findIndex(step => /阶段一.*正式训练/.test(step)), second = plan.steps.findIndex(step => /阶段二续训/.test(step))
  if ([initial, extra, end, learningRate, warmup, batch, accumulation, scheduler].some(value => value === undefined) || first < 0 || second < 0) return []
  const start = Number(initial), delta = Number(extra), finish = Number(end)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(delta) || start + delta !== finish || !/单(?:张|卡)/.test(text)) return []
  const logging = Number(/每\s*(\d+)\s*个优化器步/.exec(text)?.[1] ?? 1)
  const totalSamples = /累计样本\s*(\d+)/.exec(text)?.[1]
  const perStep = Number(batch) * Number(accumulation)
  const samples = (steps: number, firstIndex: number) => totalSamples !== undefined && Number(totalSamples) === finish * perStep
    ? { unit: 'example', meaning: 'fetched', expectedCount: steps * perStep, basis: 'Original approved cumulative sample count and fixed batch/accumulation; verify actual order and tail batches',
      perDeviceBatchSize: Number(batch), gradientAccumulationSteps: Number(accumulation), worldSize: 1,
      ...(/450\s*[/／]\s*50|450\s*条/.test(text) ? { datasetSize: 450, firstIndex: firstIndex % 450 } : {}) } : undefined
  return [stageRequirementSchema.parse({ stageId: 'phase1', planStep: first + 1, title: 'Original first training stage', framework: 'transformers',
    startStep: 0, additionalSteps: start, endStep: start, metricScope: 'stage', loggingSteps: logging,
    scheduler: { mode: 'fresh', type: scheduler, learningRate: Number(learningRate), warmupSteps: Number(warmup), totalSteps: finish }, samples: samples(start, 0) }),
  stageRequirementSchema.parse({ stageId: 'phase2', planStep: second + 1, title: 'Original continuation stage', framework: 'transformers',
    startStep: start, additionalSteps: delta, endStep: finish, metricScope: 'stage', loggingSteps: logging,
    scheduler: { mode: 'continue', type: scheduler, learningRate: Number(learningRate), warmupSteps: Number(warmup), totalSteps: finish }, samples: samples(delta, start * perStep),
    results: { evaluationSamples: /完整\s*50\s*条/.test(text) ? 50 : undefined, inferencePrompts: /固定\s*5\s*条/.test(text) ? 5 : undefined, baseControl: /基座.*对照|未启用\s*adapter.*对照/s.test(text) } })]
}
