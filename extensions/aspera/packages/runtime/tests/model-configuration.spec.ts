/** Saved DeepSeek settings preserve provider semantics and reject ambiguous durable records. */
import { z } from 'zod'
import { expect, it } from 'vitest'
import { resolveAdapterOptions, type Options } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { deepSeekConfigurationOptions, readDeepSeekConfigurationOptions } from '../src/model-configuration.ts'

const jsonOptions = (value: object) => z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)))

it.each([
  { thinking: 'enabled', reasoningEffort: 'max', retryPolicy: { mode: 'normal', maxRetries: 3,
    retryableCodes: ['TRANSPORT', 'TIMEOUT'], backoff: { initialDelayMs: 450, maxDelayMs: 2500, jitterRatio: 0.15 } } },
  { thinking: 'disabled', reasoningEffort: 'off', retryPolicy: { mode: 'always',
    backoff: { initialDelayMs: 550, maxDelayMs: 2300, jitterRatio: 0 } } },
] satisfies Options[])('reads resolved snapshots without replacing their retry, thinking or file policies: %j', overrides => {
  const options = { apiKeyEnv: 'ASPERA_KEY_TEST', baseURL: 'https://deepseek.example.test/saved',
    maxTokens: 456, defaultContextWindow: 98765, models: [{ id: 'saved-model', inputModalities: ['text' as const], contextWindow: 8192 }],
    streamIdleTimeoutMs: 12345, maxRequestFilesBytes: 76543, maxInlineRequestImageBytes: 43210, maxImagesPerRequest: 3,
    imageOffloadByteQuantum: 12345, inlineImageOffloadByteQuantum: 1234, imageOffloadCountQuantum: 2, filesApiTimeoutMs: 4567,
    fileExpiresAfterSeconds: 7200, fileRefreshMarginSeconds: 123, fileQuotaCleanupBatch: 9, ...overrides }
  const resolved = resolveAdapterOptions(options)
  const legacy = jsonOptions(resolved)
  const original = JSON.stringify(legacy)
  expect(resolveAdapterOptions(readDeepSeekConfigurationOptions(legacy))).toEqual(resolved)
  expect(JSON.stringify(legacy)).toBe(original)
  expect(resolveAdapterOptions(deepSeekConfigurationOptions(resolved))).toEqual(resolved)
})

it.each([
  { defaults: { thinking: 'unexpected' } },
  { filePolicy: { expiresAfterSeconds: 7200 } },
  { thinking: 'enabled' },
  { retryPolicy: { mode: 'normal', maxRetries: 2, retryableCodes: ['TRANSPORT'], initialDelayMs: 400, maxDelayMs: 1200, jitterRatio: 0, backoff: {} } },
])('rejects malformed or mixed resolved records: %j', fields => {
  const legacy = jsonOptions({ ...resolveAdapterOptions({}), ...fields })
  expect(() => readDeepSeekConfigurationOptions(legacy)).toThrow()
})

it('preserves native validation for raw inputs and invalid restored values', () => {
  const raw = jsonOptions({ retryPolicy: { mode: 'normal', initialDelayMs: 400 } })
  expect(() => resolveAdapterOptions(readDeepSeekConfigurationOptions(raw))).toThrow('unknown key "initialDelayMs"')
  const resolved = resolveAdapterOptions({})
  const invalid = jsonOptions({ ...resolved, retryPolicy: { ...resolved.retryPolicy, initialDelayMs: -1 } })
  expect(() => resolveAdapterOptions(readDeepSeekConfigurationOptions(invalid))).toThrow('initialDelayMs must be a positive finite number')
})
