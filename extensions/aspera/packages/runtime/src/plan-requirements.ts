/** User-submitted planning requirements retain their original input digest. */
import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { clusterPath, planRequirementsSchema, planRequirementIssues } from '@aspera/experiments'
import type { ClusterSubmission, ExperimentPlan, PlanRequirements } from '@aspera/experiments'
import { z } from 'zod'

/** Reserved v1 input name; the immutable submission authenticates its contents. */
export const PLAN_REQUIREMENTS_INPUT = 'aspera-plan-requirements.json'
/** Durable requirement-source records retain the submitted name and digest. */
export const planRequirementsSourceSchema = z.object({ name: z.literal(PLAN_REQUIREMENTS_INPUT), sha256: z.string().regex(/^[a-f0-9]{64}$/), requirements: planRequirementsSchema }).strict()
/** Source identity and validated requirements loaded by the program, never tool arguments. */
export interface PlanRequirementsSource { name: string; sha256: string; requirements: PlanRequirements }

/** Read the declared requirements document without following model-selected paths.
 * @param submission - immutable input declarations. @param runRoot - program-owned experiment directory.
 * @returns validated constraints and their input identity, or no constraints for existing submissions.
 */
export function loadPlanRequirements(submission: Pick<ClusterSubmission, 'inputs'>, runRoot: string): PlanRequirementsSource | undefined {
  const input = submission.inputs.find(value => value.name === PLAN_REQUIREMENTS_INPUT)
  if (input === undefined) return undefined
  const path = clusterPath(resolve(runRoot, 'inputs'), input.name)
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Plan requirements must be a regular submitted input')
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd, { bigint: true })
    // Version 1 limits its complete JSON document to 64 KiB.
    if (!before.isFile() || before.size > 65536n) throw new Error('Plan requirements v1 exceeds its 64 KiB document limit')
    const bytes = readFileSync(fd), after = fstatSync(fd, { bigint: true })
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || createHash('sha256').update(bytes).digest('hex') !== input.sha256) throw new Error('Plan requirements differ from their submitted digest or file identity')
    return { name: input.name, sha256: input.sha256, requirements: planRequirementsSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
  } finally { closeSync(fd) }
}

/** Recheck fixed requirements at approval and execution entry points.
 * @param submission - immutable input declarations. @param runRoot - original experiment directory. @param plan - selected immutable plan.
 * @returns normally only when the plan preserves all submitted requirements.
 */
export function assertSubmittedPlanRequirements(submission: Pick<ClusterSubmission, 'inputs'>, runRoot: string, plan: ExperimentPlan): void {
  const source = loadPlanRequirements(submission, runRoot)
  if (source === undefined) return
  const issues = planRequirementIssues(plan, source.requirements)
  if (issues.length > 0) throw new Error('Plan differs from submitted requirements: ' + JSON.stringify(issues))
}
