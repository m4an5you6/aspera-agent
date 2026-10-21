/** JSON evidence and embedded Session payloads retain parseable fields after credential removal. */
import { expect, it } from 'vitest'
import { redactCompletionData, redactCompletionText } from '../src/completion-data.ts'

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
