/** A model budget claim cannot terminate an experiment with unfinished finalization. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { experimentIdSchema } from '@aspera/experiments'
import type { CompletionCheck } from '@aspera/experiments'
import { decideExperimentFinish } from '../src/finish-decision.ts'
import { finalizationPolicySchema } from '../src/finalization-policy.ts'

function fixture() {
  const check: CompletionCheck = { version: 1, ready: false, checkedAt: 1, issues: [{ code: 'steps', detail: 'Steps 18–23 have not been reported', remedy: 'Read existing results and supplement the reports' }] }
  return { experimentId: experimentIdSchema.parse(randomUUID()), sessionId: 'execution', requested: 'blocked' as const,
    detail: 'context budget exhausted', observations: [], check, activeCommands: [] as string[], corrections: 0,
    policy: finalizationPolicySchema.parse({}), facts: { checkpoint: 230 } }
}
it('refuses an unsupported context budget explanation and asks for existing step evidence', () => {
  expect(decideExperimentFinish(fixture())).toMatchObject({ decision: 'unconfirmed', verified: false, reason: 'input-context-limit' })
})
it('waits for the real finalizer before accepting either a success or a block request', () => {
  const f = fixture(); f.activeCommands.push('final-run-01')
  expect(decideExperimentFinish(f).decision).toBe('wait')
  expect(decideExperimentFinish({ ...f, requested: 'completed' }).decision).toBe('wait')
})
it('does not call an output token limit an input context failure', () => {
  const f = fixture()
  expect(decideExperimentFinish({ ...f, detail: 'max-tokens', observations: [{ seq: 44, reason: 'output-token-limit', detail: 'Output cap reached' }] }))
    .toMatchObject({ decision: 'accepted', reason: 'output-token-limit', verified: true, evidenceSeqs: [44] })
  expect(decideExperimentFinish({ ...f, observations: [{ seq: 44, reason: 'output-token-limit', detail: 'Output cap reached' }] }).verified).toBe(false)
})
it('records incomplete Agent finalization after bounded corrections without inventing a budget fault', () => {
  expect(decideExperimentFinish({ ...fixture(), corrections: 2 })).toMatchObject({ decision: 'agent-incomplete', verified: false })
})
it('allows a real requirement failure without requiring every plan step to complete', () => {
  const f = fixture(); f.check.issues.push({ code: 'environment', detail: 'CUDA verification failed', remedy: 'Resolve the actual driver/device issue' })
  expect(decideExperimentFinish({ ...f, reason: 'requirement' })).toMatchObject({ decision: 'accepted', verified: true })
})
it('labels a passing independent completion decision as program verified', () => {
  expect(decideExperimentFinish({ ...fixture(), requested: 'completed', check: { version: 1, ready: true, checkedAt: 1, issues: [] } }))
    .toMatchObject({ decision: 'accepted', verified: true })
})
