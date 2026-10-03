/** Explicit key-only provider snapshots for CPU profile replays. Never used by installed product profiles. */
import { createHash } from 'node:crypto'

export const fixtureProvider = 'aspera-cpu'
export const fixtureOptions = {
  api: 'openai-completions', baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: 'ASPERA_FIXTURE_API_KEY',
  models: ['preparation', 'planning', 'execution'].map(phase => ({ id: `qwen-${phase}`, name: `CPU Qwen ${phase}`, contextWindow: 131072, maxTokens: 4096 })),
}
export const fixtureSelections = Object.fromEntries(['preparation', 'planning', 'execution'].map(phase => [phase, { provider: fixtureProvider, model: `qwen-${phase}` }]))

export function fixtureModelSnapshots() {
  const refs = {}; const models = {}
  for (const [phase, selection] of Object.entries(fixtureSelections)) {
    const keyRef = `ASPERA_KEY_FIXTURE_${phase.toUpperCase()}`
    const configurationRef = `ASPERA_MODEL_FIXTURE_${phase.toUpperCase()}`
    const value = JSON.stringify({ version: 1, adapter: 'pi-ai', provider: fixtureProvider, options: { ...fixtureOptions, apiKeyEnv: keyRef }, keyRef })
    refs[keyRef] = `cpu-only-${phase}`; refs[configurationRef] = value
    models[phase] = { ...selection, adapter: 'pi-ai', adapterVersion: '0.2.0-rc.2', api: fixtureOptions.api,
      baseURL: fixtureOptions.baseURL, configurationRef, configurationHash: createHash('sha256').update(value).digest('hex') }
  }
  return { models, refs }
}
