/** Missing execution evidence is rejected before completing a Goal, even when commands and steps succeeded. */
import { fromAny } from '@total-typescript/shoehorn'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { experimentIdSchema, serverIdSchema, stageRequirementSchema } from '@aspera/experiments'
import { checkExperimentCompletion } from '../src/completion-check.ts'
import type { CompletionFacts } from '../src/completion-check.ts'

function fixture(): CompletionFacts {
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  return fromAny<CompletionFacts, object>({ submission: { experimentId, nodes: [{ server: { id: serverId, name: '4090-1' } }] },
    planRevision: 1, sessionId: 'original-execution', planSteps: 1,
    progress: { version: 1, experimentId, planRevision: 1, sessionId: 'original-execution', revision: 1, steps: [{ step: 1, state: 'completed' }] },
    entries: [], nodes: [{ serverId, commands: [{ commandId: 'train', state: 'completed', exitCode: 0, released: true }] }],
    environments: [{ serverId, verified: true }], services: [] })
}
it('returns the missing node and recording tool instead of accepting a textual completion claim', () => {
  const facts = fixture(), check = checkExperimentCompletion(facts)
  expect(check.ready).toBe(false)
  expect(check.issues).toMatchObject([{ code: 'execution', serverId: facts.submission.nodes[0]!.server.id }])
  expect(check.issues[0]!.remedy).toContain('record_experiment_execution')
})
it('accepts the same settled commands after recording their actual execution evidence', () => {
  const facts = fixture()
  facts.entries.push({ serverId: facts.submission.nodes[0]!.server.id, framework: 'ms-swift', version: '4.6.0',
    script: 'train.py', environment: 'training', parameters: { epoch: '1' }, artifacts: ['checkpoint-57'], evaluation: { loss: 1.65 } })
  expect(checkExperimentCompletion(facts)).toMatchObject({ ready: true, issues: [] })
  expect(facts.nodes[0]!.commands).toHaveLength(1)
})
it('keeps the final execution parameters consistent with the approved cumulative stage', () => {
  const facts = fixture()
  facts.stages = [stageRequirementSchema.parse({ stageId: 'phase2', planStep: 1, title: 'Continue', framework: 'transformers', startStep: 30,
    additionalSteps: 200, endStep: 230, metricScope: 'stage', loggingSteps: 1,
    scheduler: { mode: 'continue', type: 'cosine', learningRate: 0.0001, warmupSteps: 12, totalSteps: 230 } })]
  facts.entries.push({ serverId: facts.submission.nodes[0]!.server.id, framework: 'swift', version: '1', script: 'train.py', environment: 'training', parameters: { max_steps: '200' }, artifacts: [], evaluation: {} })
  expect(checkExperimentCompletion(facts)).toMatchObject({ ready: false, issues: expect.arrayContaining([expect.objectContaining({ code: 'execution', detail: expect.stringContaining('max_steps') })]) })
  facts.entries[0]!.parameters.max_steps = '230'; expect(checkExperimentCompletion(facts).ready).toBe(true)
})
it('reports every missing selected node and never infers participation from the coordinator', () => {
  const facts = fixture(), other = serverIdSchema.parse(randomUUID())
  facts.submission = fromAny<CompletionFacts['submission'], object>({ ...facts.submission, nodes: [...facts.submission.nodes, { server: { id: other, name: 'Node B' } }] })
  const issues = checkExperimentCompletion(facts).issues
  expect(issues.filter(issue => issue.serverId === other).map(issue => issue.code)).toEqual(['execution', 'environment', 'commands'])
})
it.each(['plan', 'session', 'steps', 'exit', 'environment'] as const)('retains the independent %s prerequisite after evidence is recorded', kind => {
  const facts = fixture(), id = facts.submission.nodes[0]!.server.id
  facts.entries.push({ serverId: id, framework: 'swift', version: '1', script: 'train.py', environment: 'training', parameters: {}, artifacts: [], evaluation: {} })
  if (kind === 'plan') facts.progress!.planRevision++
  if (kind === 'session') facts.progress!.sessionId = 'other'
  if (kind === 'steps') facts.progress!.steps[0]!.state = 'running'
  if (kind === 'exit') facts.nodes[0]!.commands[0]!.released = false
  if (kind === 'environment') facts.environments[0]!.verified = false
  expect(checkExperimentCompletion(facts).ready).toBe(false)
})
