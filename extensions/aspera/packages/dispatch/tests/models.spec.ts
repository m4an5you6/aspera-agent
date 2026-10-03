/** Admission freezes provider configuration before asynchronous credentials are read. */
import { randomUUID } from 'node:crypto'
import { fromAny } from '@total-typescript/shoehorn'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { experimentIdSchema } from '@aspera/experiments'
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all'
import { captureExperimentModels, experimentModelDirectory, validateExperimentModels } from '../src/models.ts'
import { modelSelections } from '../../experiments/tests/fixtures.ts'

function fixture() {
  const secrets = new Map<string, string>([['CUSTOM_KEY', 'private-original-key']])
  const options = { api: 'openai-completions', baseURL: 'https://qwen.example.test/v1', apiKeyEnv: 'CUSTOM_KEY',
    headers: { 'x-private-header': 'private-header-value' }, retryPolicy: undefined, models: [{ id: 'test-model', contextWindow: 8192, maxTokens: 512, reasoningEfforts: undefined }] }
  const ctx = fromAny<Context, object>({
    llm: { listProviders: () => [{ id: 'test', name: 'Custom Qwen' }], listConfigurableProviders: () => [{ provider: 'test', settingsNs: 'api', settingsPath: ['providers', 'test'] }],
      listModels: async () => [{ id: 'test-model', name: 'Qwen custom' }], resolveModelInfo: async () => ({}) },
    settings: { describe: () => [{ ns: 'api', value: { providers: { test: options } } }] },
    credentials: { describe: async (ref: string) => ({ configured: secrets.has(ref) }), resolve: async (ref: string) => secrets.has(ref) ? { value: secrets.get(ref) } : undefined,
      set: async (ref: string, value: string) => { secrets.set(ref, value) } },
    agentDefaultModel: { currentSelection: () => modelSelections.preparation },
  })
  return { ctx, options, secrets }
}

it('copies independent phase keys and keeps secrets out of the model directory and receipts', async () => {
  const f = fixture()
  const snapshots = await captureExperimentModels(f.ctx, experimentIdSchema.parse(randomUUID()), modelSelections)
  f.options.baseURL = 'https://changed.example.test/v1'; f.secrets.set('CUSTOM_KEY', 'changed-key')
  for (const phase of Object.values(snapshots)) {
    const stored = JSON.parse(f.secrets.get(phase.configurationRef)!)
    expect(stored.options.baseURL).toBe('https://qwen.example.test/v1')
    expect(f.secrets.get(stored.keyRef)).toBe('private-original-key')
    expect(stored.options.headers).toEqual({ 'x-private-header': 'private-header-value' })
  }
  expect(new Set(Object.values(snapshots).map(value => value.configurationRef)).size).toBe(3)
  const directory = await experimentModelDirectory(f.ctx)
  expect(directory.models[0]).toMatchObject({ configured: true, transferable: true })
  expect(JSON.stringify({ directory, snapshots })).not.toMatch(/private-original-key|private-header-value|changed-key/)
})

it('rejects missing credentials and unsupported reasoning before storing any snapshots', async () => {
  const f = fixture(); f.secrets.clear()
  await expect(captureExperimentModels(f.ctx, experimentIdSchema.parse(randomUUID()), modelSelections)).rejects.toThrow('preparation: Error: API credential is missing')
  expect(f.secrets.size).toBe(0)
  f.secrets.set('CUSTOM_KEY', 'key')
  await expect(validateExperimentModels(f.ctx, { ...modelSelections, execution: { ...modelSelections.execution, reasoningEffort: 'invalid' as import('@deepseek-ai/dsh-llm').ReasoningEffortId } })).rejects.toThrow('execution: Error: Selected reasoning option is unsupported')
  expect(f.secrets.size).toBe(1)
})

it('rejects API addresses with embedded credentials before returning public summaries', async () => {
  const f = fixture(); f.options.baseURL = 'https://secret:key@qwen.example.test/v1'
  await expect(validateExperimentModels(f.ctx, modelSelections)).rejects.toThrow('API address must not contain credentials')
  expect(JSON.stringify(await experimentModelDirectory(f.ctx))).not.toContain('secret:key')
})

it('transfers a saved pi-ai API-key sign-in and refuses an OAuth grant', async () => {
  const f = fixture(); Reflect.deleteProperty(f.options, 'apiKeyEnv')
  f.ctx.credentials.readRecord = async () => ({ kind: 'api-key', key: 'stored-key' })
  const snapshots = await captureExperimentModels(f.ctx, experimentIdSchema.parse(randomUUID()), modelSelections)
  const stored = JSON.parse(f.secrets.get(snapshots.execution.configurationRef)!)
  expect(f.secrets.get(stored.keyRef)).toBe('stored-key')
  f.ctx.credentials.readRecord = async () => ({ kind: 'grant', payload: { type: 'oauth' } })
  await expect(validateExperimentModels(f.ctx, modelSelections)).rejects.toThrow('authentication cannot be transferred')
})

it('materializes the installed catalog protocol and endpoint for the selected model', async () => {
  const f = fixture(); const model = getBuiltinModels('openai')[0]!
  Reflect.deleteProperty(f.options, 'api'); Reflect.deleteProperty(f.options, 'baseURL')
  f.options.models[0]!.id = model.id
  Object.assign(f.ctx.llm, { listConfigurableProviders: () => [{ provider: 'openai', settingsNs: 'api', settingsPath: ['providers', 'openai'] }], listModels: async () => [{ id: model.id }] })
  Object.assign(f.ctx.settings, { describe: () => [{ ns: 'api', value: { providers: { openai: f.options } } }] })
  const selection = { provider: 'openai', model: model.id }
  const snapshots = await captureExperimentModels(f.ctx, experimentIdSchema.parse(randomUUID()), { preparation: selection, planning: selection, execution: selection })
  const saved = JSON.parse(f.secrets.get(snapshots.execution.configurationRef)!)
  expect(saved.options).toMatchObject({ api: model.api, baseURL: model.baseUrl })
  expect(snapshots.execution).toMatchObject({ api: model.api, baseURL: model.baseUrl })
})
