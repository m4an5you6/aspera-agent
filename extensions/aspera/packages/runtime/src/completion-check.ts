/** One completion decision for normal execution and read-only historical reviews. */
import type { ClusterSubmission, ExecutionProgress, CompletionCheck, CompletionIssue, InferenceService, StageRequirement } from '@aspera/experiments'
import type { z } from 'zod'
import type { executionEntrySchema, clusterCommandResultSchema } from '@aspera/experiments'

/** Independent observations; missing values remain failures rather than inferred successes. */
export interface CompletionFacts {
  submission: ClusterSubmission
  planRevision: number
  sessionId: string
  planSteps: number
  stages?: StageRequirement[]
  progress?: ExecutionProgress
  entries: z.infer<typeof executionEntrySchema>[]
  nodes: { serverId: ClusterSubmission['nodes'][number]['server']['id']; commands: z.infer<typeof clusterCommandResultSchema>[] }[]
  environments: { serverId: ClusterSubmission['nodes'][number]['server']['id']; verified: boolean; detail?: string }[]
  services: InferenceService[]
  issues?: CompletionIssue[]
}

/** @param facts - program-owned snapshots of all selected nodes. @returns recoverable missing evidence before a Goal may complete. */
export function checkExperimentCompletion(facts: CompletionFacts): CompletionCheck {
  const issues: CompletionIssue[] = [...facts.issues ?? []]
  const issue = (code: CompletionIssue['code'], detail: string, remedy: string, serverId?: CompletionIssue['serverId']) => {
    issues.push({ code, detail, remedy, ...(serverId === undefined ? {} : { serverId }) })
  }
  const progress = facts.progress
  if (progress === undefined || progress.experimentId !== facts.submission.experimentId || progress.planRevision !== facts.planRevision
    || progress.sessionId !== facts.sessionId || progress.steps.length !== facts.planSteps
    || new Set(progress.steps.map(step => step.step)).size !== facts.planSteps
    || progress.steps.some(step => step.step > facts.planSteps || step.state !== 'completed')) {
    issue('steps', 'Approved-plan steps lack completed reports matching the current plan and Session.', 'Read get_experiment_execution_progress and report actual results; never rerun settled commands to repair reports.')
  }
  for (const entry of facts.entries) if (!facts.submission.nodes.some(node => node.server.id === entry.serverId)) {
    issue('identity', 'An execution record belongs to an unselected node.', 'Use the original selected node identities.')
  }
  for (const node of facts.submission.nodes) {
    const id = node.server.id
    const finalStage = [...facts.stages ?? []].sort((a, b) => b.endStep - a.endStep)[0]
    const execution = facts.entries.findLast(entry => entry.serverId === id)
    if (finalStage !== undefined && execution !== undefined && (execution.parameters.max_steps === undefined || !Number.isSafeInteger(Number(execution.parameters.max_steps))
      || (finalStage.scheduler.mode === 'restart' ? Number(execution.parameters.max_steps) < finalStage.endStep
        : Number(execution.parameters.max_steps) !== finalStage.scheduler.totalSteps))) issue('execution', 'Recorded execution max_steps differs from the approved final stage or is missing.',
      'Read the final effective argument file and record its actual max_steps using record_experiment_execution; do not repeat training.', id)
    if (!facts.entries.some(entry => entry.serverId === id && Object.keys(entry.parameters).length > 0)) issue('execution', `Node ${node.server.name} has no recorded framework, version, script, environment and parameters.`,
      'Read existing scripts, logs and results, then call record_experiment_execution for this node. A report or finish detail does not save an execution entry. Do not retrain.', id)
    const environment = facts.environments.find(value => value.serverId === id)
    if (environment?.verified !== true) issue('environment', environment?.detail ?? `Node ${node.server.name} has no verified environment.`,
      'Inspect the original environment and its verification evidence; do not install another environment to repair missing records.', id)
    const commands = facts.nodes.find(value => value.serverId === id)?.commands
    const services = new Set(facts.services.filter(service => service.serverId === id && service.state === 'healthy' && !service.released).map(service => service.commandId))
    if (commands === undefined || commands.length === 0 || commands.some(command => !command.released && !services.has(command.commandId))
      || !commands.some(command => command.state === 'completed' && command.exitCode === 0 || services.has(command.commandId))) {
      issue('commands', `Node ${node.server.name} lacks successful settled commands or a verified healthy service.`, 'Read get_experiment_commands and confirm the original command exits; do not restart completed work.', id)
    }
  }
  return { version: 1, ready: issues.length === 0, checkedAt: Date.now(), issues }
}
