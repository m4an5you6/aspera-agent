/** Captures DSH provider settings and write-only credentials at experiment admission. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { builtinProviders, getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all'
import { experimentPhases, experimentModelsSchema, experimentModelSnapshotsSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentModels, ExperimentModelDirectory, ExperimentModelSnapshots, ExperimentModelOption, PhaseModelSelection } from '@aspera/experiments'

function profile(ctx: Context, provider: string): { adapter: 'deepseek-api-key' | 'pi-ai'; options: Record<string, z.infer<ReturnType<typeof z.json>>>; ref?: string; api: string; baseURL?: string } {
  const route = ctx.llm.listConfigurableProviders().find(item => item.provider === provider)
  if (route === undefined) throw new Error('This provider does not expose transferable API settings')
  const descriptor = ctx.settings.describe().find(item => item.ns === route.settingsNs)
  if (descriptor === undefined) throw new Error('Provider configuration is unavailable')
  let value: unknown = structuredClone(descriptor.value)
  for (const part of route.settingsPath) value = z.record(z.string(), z.unknown()).parse(value)[part]
  // Settings resolves optional fields to undefined; provider JSON omits those fields.
  let options = z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(value)))
  const adapter = provider === 'deepseek-official' && route.settingsPath.length === 0 ? 'deepseek-api-key'
    : route.settingsPath.length === 2 && route.settingsPath[0] === 'providers' && route.settingsPath[1] === provider ? 'pi-ai' : undefined
  if (adapter === undefined) throw new Error('This provider cannot be transferred; select a DeepSeek API key or llm-pi-ai key API')
  if (adapter === 'deepseek-api-key') options = z.record(z.string(), z.json()).parse(JSON.parse(JSON.stringify(resolveAdapterOptions(options, launchEnvironmentOf(ctx)))))
  const ref = z.string().min(1).optional().parse(options.apiKeyEnv)
  const api = adapter === 'deepseek-api-key' ? 'deepseek-messages' : typeof options.api === 'string' ? options.api : `pi-ai:${provider}`
  const baseURL = typeof options.baseURL === 'string' ? options.baseURL : undefined
  if (baseURL !== undefined) {
    const url = new URL(baseURL)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API address must not contain credentials, query parameters or a fragment')
  }
  return { adapter, options, ...(ref === undefined ? {} : { ref }), api, ...(baseURL === undefined ? {} : { baseURL }) }
}

async function readKey(ctx: Context, configuration: ReturnType<typeof profile>, provider: string): Promise<string | undefined> {
  if (configuration.ref !== undefined) return (await ctx.credentials.resolve(credentialRef(configuration.ref)))?.value
  // DSH 0.2.0-rc.2 stores pi-ai API-key sign-ins in this published credential-record namespace.
  const record = await ctx.credentials.readRecord(credentialKey('llm-pi-ai', provider))
  if (record === undefined) return undefined
  if (record.kind !== 'api-key' || record.env !== undefined) throw new Error('This authentication cannot be transferred; configure a single API key for this provider')
  return record.key
}

function phaseConfiguration(configuration: ReturnType<typeof profile>, selection: PhaseModelSelection): ReturnType<typeof profile> {
  if (configuration.adapter === 'deepseek-api-key') return configuration
  const route = getBuiltinProviders().find(provider => provider === selection.provider)
  const catalog = route === undefined ? [] : getBuiltinModels(route)
  const base = catalog.find(model => model.id === selection.model)
  const protocols = new Set(catalog.map(model => model.api))
  const api = typeof configuration.options.api === 'string' ? configuration.options.api : base?.api ?? (protocols.size === 1 ? [...protocols][0] : undefined)
  const baseURL = configuration.baseURL ?? base?.baseUrl ?? builtinProviders().find(provider => provider.id === selection.provider)?.baseUrl
  if (api === undefined || baseURL === undefined) throw new Error('The selected model needs an explicit API protocol and address')
  const { modelOverrides, ...options } = configuration.options
  const entry = Array.isArray(options.models) ? options.models.find(model => typeof model === 'object' && model !== null && !Array.isArray(model) && model.id === selection.model) : undefined
  const override = modelOverrides === undefined ? {} : z.record(z.string(), z.json()).parse(modelOverrides)[selection.model] ?? {}
  return { ...configuration, api, baseURL, options: { ...options, api, baseURL,
    models: [entry ?? { id: selection.model, ...z.record(z.string(), z.json()).parse(override) }] } }
}

/** Read configured routes, model capabilities and credential presence without keys.
 * @param ctx - DSH Host services. @returns selections available to the experiment form.
 */
export async function experimentModelDirectory(ctx: Context): Promise<ExperimentModelDirectory> {
  const models: ExperimentModelOption[] = []
  for (const provider of ctx.llm.listProviders()) {
    let detail: string | undefined
    let configured = false
    let transferable = false
    try {
      const config = profile(ctx, provider.id)
      configured = Boolean((await readKey(ctx, config, provider.id))?.trim())
      transferable = true
      if (!configured) detail = 'API credential is missing'
    } catch (error) { detail = String(error) }
    try {
      for (const model of await ctx.llm.listModels(provider.id)) {
        const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
        models.push({ provider: provider.id, providerName: provider.name, model: model.id, name: model.name,
          reasoning: (info.reasoning?.efforts ?? []).map(item => ({ id: item.id, name: item.name })), configured, transferable,
          ...(detail === undefined ? {} : { detail }) })
      }
    } catch (error) {
      models.push({ provider: provider.id, providerName: provider.name, model: '', name: provider.name,
        reasoning: [], configured: false, transferable: false, detail: String(error) })
    }
  }
  const current = ctx.agentDefaultModel.currentSelection()
  return { models, ...(models.some(item => item.provider === current.provider && item.model === current.model && item.configured && item.transferable) ? { current } : {}) }
}

async function resolveModels(ctx: Context, input: ExperimentModels) {
  const selections = experimentModelsSchema.parse(input)
  return Promise.all(experimentPhases.map(async phase => {
    const selection = selections[phase]
    try {
      const configuration = phaseConfiguration(profile(ctx, selection.provider), selection)
      const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
      if (!(await ctx.llm.listModels(selection.provider)).some(model => model.id === selection.model)) throw new Error('Model is absent from the configured provider')
      if (selection.reasoningEffort !== undefined && !info.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) throw new Error('Selected reasoning option is unsupported')
      const key = await readKey(ctx, configuration, selection.provider)
      if (key === undefined || key.trim() === '') throw new Error('API credential is missing')
      const resolved: PhaseModelSelection = { ...selection, ...(selection.reasoningEffort === undefined && info.reasoning?.defaultEffort !== undefined ? { reasoningEffort: info.reasoning.defaultEffort } : {}) }
      return { phase, selection: resolved, configuration, key }
    } catch (error) { throw new Error(`${phase}: ${String(error)}`) }
  }))
}

/** Validate all three phases without creating a task or copying keys.
 * @param ctx - DSH Host. @param selections - explicit phase choices. @returns validated choices.
 */
export async function validateExperimentModels(ctx: Context, selections: ExperimentModels): Promise<ExperimentModels> {
  const values = await resolveModels(ctx, selections)
  return experimentModelsSchema.parse(Object.fromEntries(values.map(value => [value.phase, value.selection])))
}

/** Freeze complete provider settings and copy keys into independent credential references.
 * @param ctx - DSH Host. @param id - admitted task identity. @param input - three explicit selections.
 * @returns public summaries; raw settings and keys remain private.
 */
export async function captureExperimentModels(ctx: Context, id: ExperimentId, input: ExperimentModels): Promise<ExperimentModelSnapshots> {
  const resolved = await resolveModels(ctx, input)
  const rows = []
  for (const { phase, selection, configuration, key } of resolved) {
    const suffix = `${id.replaceAll('-', '_')}_${phase}`.toUpperCase()
    const keyRef = `ASPERA_KEY_${suffix}`
    const configurationRef = `ASPERA_MODEL_${suffix}`
    const privateValue = JSON.stringify({ version: 1, adapter: configuration.adapter, provider: selection.provider,
      options: { ...configuration.options, apiKeyEnv: keyRef }, keyRef })
    await ctx.credentials.set(credentialRef(keyRef), key)
    await ctx.credentials.set(credentialRef(configurationRef), privateValue)
    rows.push([phase, { ...selection, adapter: configuration.adapter, adapterVersion: '0.2.0-rc.2', api: configuration.api,
      ...(configuration.baseURL === undefined ? {} : { baseURL: configuration.baseURL }), configurationRef,
      configurationHash: createHash('sha256').update(privateValue).digest('hex') }])
  }
  return experimentModelSnapshotsSchema.parse(Object.fromEntries(rows))
}
