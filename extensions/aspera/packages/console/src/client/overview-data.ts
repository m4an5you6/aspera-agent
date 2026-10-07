/** Display projections select measured metrics without deriving lifecycle or acceptance states. */
import type { ClusterRecord } from '@aspera/experiments/types'

/** One of the three overview metrics; a valid total is available only for step counts. */
export interface OverviewMetric { label: 'trainingSteps' | 'trainingLoss' | 'trainingThroughput' | 'trainingTokenRate'; value: number; total?: number }

/** @param metrics - latest numeric Agent report. @returns available core metrics; missing fields remain missing. */
export function overviewMetrics(metrics: Record<string, number>): OverviewMetric[] {
  const result: OverviewMetric[] = []
  const step = metrics.step
  const total = metrics.total_steps
  if (step !== undefined && step >= 0) result.push({ label: 'trainingSteps', value: step,
    ...(total !== undefined && Number.isInteger(total) && total > 0 && Number.isInteger(step) && step <= total ? { total } : {}) })
  if (metrics.loss !== undefined) result.push({ label: 'trainingLoss', value: metrics.loss })
  const throughput = metrics.tokens_per_second ?? metrics.throughput
  if (throughput !== undefined && throughput >= 0) result.push({ label: metrics.tokens_per_second === undefined ? 'trainingThroughput' : 'trainingTokenRate', value: throughput })
  return result
}

const labels = new Map(Object.entries({
  step: 'trainingSteps', total_steps: 'totalTrainingSteps', loss: 'trainingLoss', throughput: 'trainingThroughput', tokens_per_second: 'trainingTokenRate',
  run_experiment_command_attempts: 'commandAttempts', run_experiment_command_successes: 'successfulCommands', distinct_run_ids_attempted: 'distinctCommands',
  goal_rounds_with_same_failure: 'repeatedFailureRounds', gpu_probe_completed: 'gpuProbeReport', environment_created: 'environmentReport',
  model_downloaded: 'modelDownloadReport', dataset_prepared: 'datasetReport', smoke_run_completed: 'smokeRunReport', formal_training_completed: 'formalTrainingReport',
  adapter_saved: 'adapterSavedReport', adapter_reload_verified: 'adapterReloadReport', artifacts_created_on_node: 'artifactCountReport',
  docs_verified_pages: 'documentationPageReport', assigned_nodes: 'assignedNodeReport', gpus_assigned: 'assignedGpuReport',
} as const))

/** @param name - original Agent metric key. @returns a translated label key where its meaning is known. */
export function diagnosticMetricLabel(name: string) { return labels.get(name) }

/** @param remote - latest remote record. @returns only the last saved Agent measurement time. */
export function overviewReportTime(remote: ClusterRecord | undefined): number | undefined { return remote?.progress?.updatedAt }

/** @param text - retained Agent activity or error. @returns a bounded first-line overview; full text stays in diagnostics. */
export function overviewSummary(text: string): string {
  const first = text.trim().split(/\r?\n/, 1)[0] ?? ''
  return first.length > 180 ? `${first.slice(0, 179)}…` : first
}
