/** A model budget claim cannot terminate an experiment with unfinished finalization. */
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { experimentIdSchema, requirementEvidenceSchema } from '@aspera/experiments'
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
it.each(['agent-report', 'requirement'] as const)('keeps an unverified %s block open for correction before stopping the Agent', reason => {
  const request = { ...fixture(), reason, detail: 'The installer failed; no recovery evidence was supplied' }
  const first = decideExperimentFinish(request)
  expect(first).toMatchObject({ decision: 'unconfirmed', verified: false })
  expect(first.detail).toContain('existing')
  expect(decideExperimentFinish({ ...request, corrections: 2 })).toMatchObject({ decision: 'agent-incomplete', verified: false })
})
it('retains a reported requirement block without inferring proof from an environment check issue', () => {
  const f = fixture(); f.check.issues.push({ code: 'environment', detail: 'CUDA verification failed', remedy: 'Resolve the actual driver/device issue' })
  expect(decideExperimentFinish({ ...f, reason: 'requirement' })).toMatchObject({ decision: 'unconfirmed', verified: false })
})
it.each(['storage-plan', 'environment-operation'] as const)('confirms only %s evidence associated with this plan and Session', kind => {
  const f = fixture(), serverId = randomUUID()
  const evidence = requirementEvidenceSchema.parse({ version: 1, formatVersion: '0.1.1', experimentId: f.experimentId, serverId,
    sessionId: f.sessionId, planRevision: 1, reference: { serverId, kind, id: randomUUID() },
    requestHash: 'a'.repeat(64), checkedAt: 1, detail: kind === 'storage-plan' ? 'Declared output budget is short by 100 bytes' : 'Historical candidate RECORD mismatch; other repair choices are not disproved' })
  const request = { ...f, reason: 'requirement' as const, planRevision: 1, requirementEvidence: [evidence], detail: 'No historical models exist' }
  const result = decideExperimentFinish(request)
  expect(result).toMatchObject({ decision: 'accepted', verified: true })
  expect(result.detail).toContain(evidence.detail)
  expect(result.detail).not.toContain(request.detail)
  expect(decideExperimentFinish({ ...request, sessionId: 'another-session' }).verified).toBe(false)
  expect(decideExperimentFinish({ ...request, planRevision: 2 }).verified).toBe(false)
})
it('does not treat an unregistered training stage as independent proof of a material or capacity failure', () => {
  const f = fixture(); f.check.issues.push({ code: 'stages', detail: 'Approved stage has no registration', remedy: 'Read existing evidence' })
  const result = decideExperimentFinish({ ...f, reason: 'requirement', detail: 'Materials are unavailable and capacity is insufficient' })
  expect(result).toMatchObject({ decision: 'unconfirmed', verified: false })
  expect(result.detail).not.toContain('Program checks confirm')
})
it('labels a passing independent completion decision as program verified', () => {
  expect(decideExperimentFinish({ ...fixture(), requested: 'completed', check: { version: 1, ready: true, checkedAt: 1, issues: [] } }))
    .toMatchObject({ decision: 'accepted', verified: true })
})
