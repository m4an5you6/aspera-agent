/** Native Transformers recovery filenames retain their actual optimizer-step identity. */
import { posix } from 'node:path'
import type { StageRegistration } from '@aspera/experiments'

/** @param requirement - approved stage files. @returns unique native recovery states and their declared cumulative steps. */
export function stageCheckpointFiles(requirement: StageRegistration['requirement']): { path: string; step: number }[] {
  return [...new Set(requirement.requiredFiles)].flatMap(path => {
    const match = /(?:^|\/)checkpoint-(\d+)\/trainer_state\.json$/.exec(path)
    if (match === null) return []
    const step = Number(match[1])
    if (!Number.isSafeInteger(step)) throw new Error('Recovery checkpoint filename has an unsupported optimizer step: ' + path)
    return [{ path, step }]
  })
}

/**
 * Check native intermediate recovery points in registered and approved native output directories.
 * @param requirement - approved cumulative endpoints and required files.
 * @param args - effective parameter JSON.
 * @param trainerState - registered final state filename.
 * @param resumeState - original native TrainerState for scheduler continuation.
 * @returns after confirming an explicit step interval produces and retains every declared intermediate point.
 */
export function verifyCheckpointSaving(requirement: StageRegistration['requirement'], args: Record<string, unknown>, trainerState: string, resumeState?: Record<string, unknown>): void {
  const outputs = new Set([posix.dirname(posix.dirname(trainerState)), ...stageCheckpointFiles(requirement)
    .filter(value => value.step === requirement.endStep).map(value => posix.dirname(posix.dirname(value.path)))])
  const points = stageCheckpointFiles(requirement).filter(value => value.step > requirement.startStep && value.step < requirement.endStep
    && outputs.has(posix.dirname(posix.dirname(value.path))))
  if (points.length === 0) return
  const interval = requirement.scheduler.mode === 'continue' ? resumeState?.save_steps : args.save_steps, retention = args.save_total_limit
  const basis = requirement.scheduler.mode === 'continue' ? 'original resumed TrainerState.save_steps' : 'effective save_steps'
  if (args.save_strategy !== 'steps' || typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval <= 0) {
    throw new Error('Cannot confirm approved intermediate recovery files from ' + basis + '. Use an explicit integer step-based save policy; continuation inherits the original TrainerState interval, and a new CLI save_steps or custom callback declaration does not establish checkpoint creation: ' + points[0]!.path)
  }
  if (retention !== undefined && retention !== null && (typeof retention !== 'number' || !Number.isSafeInteger(retention) || retention < 0)) throw new Error('Checkpoint retention save_total_limit must be a nonnegative integer or null')
  for (const point of points) {
    if (point.step % interval !== 0) throw new Error(`Approved recovery file ${point.path} requires cumulative step ${point.step}, but ${basis}=${interval} does not produce it. Correct the save policy before training; renaming another checkpoint cannot satisfy this requirement.`)
    const later = Math.floor(requirement.endStep / interval) - Math.floor(point.step / interval) + (requirement.endStep % interval === 0 ? 0 : 1)
    if (typeof retention === 'number' && retention > 0 && later >= retention) throw new Error(`Checkpoint retention save_total_limit=${retention} would remove approved recovery file ${point.path} before the final checkpoint. Preserve all approved recovery points without increasing their allowed count.`)
  }
}

/**
 * Check a stage's saved cadence against approved continuation recovery points before its first launch.
 * @param requirement - current approved stage.
 * @param args - current effective parameters.
 * @param resumeState - original native state when the current stage continues another attempt.
 * @param stages - immutable approved stages.
 * @returns after confirming future continuations can inherit a compatible interval.
 */
export function verifyContinuationSaving(requirement: StageRegistration['requirement'], args: Record<string, unknown>, resumeState: Record<string, unknown> | undefined, stages: StageRegistration['requirement'][]): void {
  const inherited = requirement.scheduler.mode === 'continue' ? resumeState : args
  for (const next of stages.filter(value => value.scheduler.mode === 'continue' && value.startStep === requirement.endStep && value.planStep > requirement.planStep)) {
    for (const point of stageCheckpointFiles(next).filter(value => value.step > next.startStep && value.step < next.endStep)) {
      const final = posix.join(posix.dirname(posix.dirname(point.path)), `checkpoint-${next.endStep}/trainer_state.json`)
      try { verifyCheckpointSaving(next, { save_strategy: 'steps', save_total_limit: null }, final, inherited) }
      catch (error) { throw new Error(`Current stage ${requirement.stageId} would save an incompatible cadence for approved continuation ${next.stageId}: ${String(error)} Choose compatible initial save_steps before training. Preserve existing checkpoint contents.`) }
    }
  }
}
