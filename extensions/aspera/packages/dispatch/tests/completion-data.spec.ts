/** JSON evidence and embedded Session payloads retain parseable fields after credential removal. */
import { expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { serverIdSchema, experimentIdSchema, executionProgressSchema, completionAssessmentSchema } from '@aspera/experiments'
import { redactCompletionData, redactCompletionText, redactCompletionScript, reviewProgressSummary, reviewCompletionSummary } from '../src/completion-data.ts'

it('distinguishes verified associated serving from an unresolved original-step assessment without changing acceptance', () => {
  const proof = { experimentId: experimentIdSchema.parse(randomUUID()), recoveryExperimentId: experimentIdSchema.parse(randomUUID()),
    evidencePath: 'reports/acceptance-recovery/proof.json', evidenceHash: 'a'.repeat(64) }
  const check = { version: 1 as const, ready: false, checkedAt: 1000, issues: [{ code: 'steps' as const, detail: 'Missing supplemental report', remedy: 'Record actual evidence' }] }
  expect(reviewCompletionSummary(check, proof)).toMatchObject({ ready: false, associatedServing: { verified: true, evidencePath: proof.evidencePath } })
  const failed = reviewCompletionSummary({ ...check, issues: [{ code: 'results', detail: 'Public generation failed', remedy: 'Continue original serving recovery' }] }, proof)
  expect(failed).toMatchObject({ ready: false, associatedServing: { verified: false } })
  expect(reviewCompletionSummary(check).associatedServing).toBeUndefined()
  expect(check.ready).toBe(false)
})

it('separates the current supplementary outcome from an unchanged historical blocked report', () => {
  const id = randomUUID(), session = 'original-execution'
  const original = executionProgressSchema.parse({ version: 1, experimentId: id, planRevision: 1, sessionId: session, revision: 36, updatedAt: 1000,
    steps: Array.from({ length: 18 }, (_value, index) => ({ step: index + 1, state: index === 15 ? 'blocked' : 'completed', updatedAt: 1000 })) })
  const assessment = completionAssessmentSchema.parse({ version: 1, experimentId: id, operationId: randomUUID(), originalState: 'blocked',
    originalRevision: 15690, submissionHash: 'a'.repeat(64), planRevision: 1, executionSessionId: session, revision: 0,
    eligibilityVerified: true, steps: [], stages: [], verifications: [], updatedAt: 1000 })
  const review = { experimentId: original.experimentId, planRevision: 1, executionSessionId: session }, before = JSON.stringify(original)
  expect(reviewProgressSummary({ original, assessment }, review, 18)).toMatchObject({ progressIdentity: 'confirmed', unresolvedSteps: [16] })
  const corrected = completionAssessmentSchema.parse({ ...assessment, steps: [{ step: 16, state: 'completed', detail: 'Program-associated exact-checkpoint public-serving proof',
    recordedAt: 2000, callId: 'supplement-service', sources: [{ serverId: randomUUID(), path: 'reports/acceptance-recovery/proof.json', purpose: 'inference',
      sha256: 'b'.repeat(64), generation: 'original-proof', bytes: 100 }] }] })
  expect(reviewProgressSummary({ original, assessment: corrected }, review, 18).unresolvedSteps).toEqual([])
  expect(JSON.stringify(original)).toBe(before)
  expect(original.steps[15]!.state).toBe('blocked')
  expect(reviewProgressSummary({ original: { ...original, sessionId: 'another' }, assessment: corrected }, review, 18))
    .toMatchObject({ progressIdentity: 'unconfirmed', unresolvedSteps: Array.from({ length: 18 }, (_value, index) => index + 1) })
})

it('keeps null credential fields and normal parameters readable in saved training arguments', () => {
  const original = { model: 'fixture/model', max_length: 512, num_train_epochs: 1, hub_token: null, api_key: 'private-key',
    password: 'private-"quoted-value', headers: { authorization: 'Bearer private-token' }, extraHeaders: { token: 'private' } }
  const text = redactCompletionText(JSON.stringify(original), ['private-"quoted-value'])
  expect(JSON.parse(text)).toEqual({ model: 'fixture/model', max_length: 512, num_train_epochs: 1,
    hub_token: null, api_key: '[redacted]', password: '[redacted]', headers: { redacted: true }, extraHeaders: { redacted: true } })
  expect(original.password).toBe('private-"quoted-value')
  expect(text).not.toContain('private')
  expect(redactCompletionData({ push_to_hub_token: 'private-hf', service_api_key: 'private-service', refresh_token: null }, [])).toEqual({
    push_to_hub_token: '[redacted]', service_api_key: '[redacted]', refresh_token: null })
})
it('preserves each complete JSONL row and nested tool-result JSON', () => {
  const text = JSON.stringify({ steps: 57, token: null }) + '\n' + JSON.stringify({ loss: 1.65, secret: 'hidden' }) + '\n'
  const event = { message: { content: [{ type: 'text', text: JSON.stringify({ text, arguments: JSON.stringify({ password: 'hidden', max_steps: 57 }) }) }] } }
  const outer = JSON.parse(JSON.stringify(redactCompletionData(event, ['hidden'])))
  const result = JSON.parse(outer.message.content[0].text)
  expect(result.text.trim().split('\n').map(JSON.parse)).toEqual([{ steps: 57, token: null }, { loss: 1.65, secret: '[redacted]' }])
  expect(JSON.parse(result.arguments)).toEqual({ password: '[redacted]', max_steps: 57 })
})
it('retains plain text and incomplete JSON windows without inventing structured evidence', () => {
  expect(redactCompletionText('hf_token: private-value"\n诊断', ['private-value'])).not.toContain('private-value')
  expect(() => JSON.parse(redactCompletionText('{"step":57,"unfinished":', []))).toThrow()
  expect(redactCompletionText('{"step":57,"loss":NaN}', [])).toContain('NaN')
})
it('distinguishes the retained source digest from credential-masked Python text', () => {
  const text = 'IM_END_TOKEN = chr(60) + "|im_end|" + chr(62)\napi_key = "private-source-key"\n'
  const sha256 = createHash('sha256').update(text).digest('hex')
  const original = { serverId: serverIdSchema.parse(randomUUID()), path: 'configs/serve.py', sha256, text }
  const supplied = redactCompletionScript(original, ['private-source-key'])
  expect(supplied).toMatchObject({ sha256, textRedacted: true, textSha256: createHash('sha256').update(supplied.text).digest('hex') })
  expect(supplied.text).not.toContain('private-source-key')
  expect(original.text).toBe(text)
})
it('preserves matching original and supplied digests when source text requires no masking', () => {
  const text = 'print("public source")\n', sha256 = createHash('sha256').update(text).digest('hex')
  expect(redactCompletionScript({ serverId: serverIdSchema.parse(randomUUID()), path: 'scripts/public.py', sha256, text }, []))
    .toMatchObject({ sha256, textSha256: sha256, textRedacted: false, text })
})
