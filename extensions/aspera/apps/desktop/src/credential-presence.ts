/** Read model credential metadata through authenticated published RPC without reading secrets. */
import { randomUUID } from 'node:crypto'
import z from 'zod'

const record = z.record(z.string(), z.unknown())
const namespace = z.object({ ns: z.string(), value: z.unknown() })
const provider = z.object({ settingsNs: z.string(), settingsPath: z.array(z.string()) })
const metadata = z.record(z.string(), z.object({ configured: z.boolean() }))

/**
 * Query every configurable provider's credential references, including the official provider.
 * @param origin - owned local Host origin.
 * @param send - cookie-authenticated Electron session fetch.
 * @returns whether a model API key is configured; malformed or failed reads reject.
 */
export async function readApiKeyPresence(origin: string, send: (url: string, init: RequestInit) => Promise<Response>): Promise<boolean> {
  const invoke = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    const rpcId = randomUUID()
    const response = await send(new URL(`/api/${method}`, origin).href, {
      method: 'POST', credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    if (!response.ok) throw new Error('Model credential metadata request failed')
    const envelope = z.object({ type: z.literal('server-response'), rpcId: z.literal(rpcId),
      result: z.object({ ok: z.literal(true), value: z.unknown() }) }).parse(await response.json())
    return envelope.result.value
  }
  const settings = z.object({ namespaces: z.array(namespace) }).parse(await invoke('settings/describe', {}))
  const providers = z.array(provider).parse(await invoke('llm/listConfigurableProviders', {}))
  const refs = new Set<string>()
  const official = settings.namespaces.find(item => item.ns === 'llm-deepseek')
  if (official !== undefined) refs.add(z.object({ apiKeyEnv: z.string() }).parse(official.value).apiKeyEnv)
  for (const item of providers) {
    let value: unknown = settings.namespaces.find(itemNs => itemNs.ns === item.settingsNs)?.value
    for (const key of item.settingsPath) value = record.parse(value)[key]
    if (value === undefined) throw new Error('Missing configurable provider settings')
    const configured = record.parse(value)
    if (typeof configured.apiKeyEnv === 'string') refs.add(configured.apiKeyEnv)
  }
  const unique = [...refs]; let present = false
  for (let offset = 0; offset < unique.length; offset += 64) {
    const batch = unique.slice(offset, offset + 64)
    const states = metadata.parse(await invoke('credentials/describe', { refs: batch }))
    for (const ref of batch) {
      const state = states[ref]
      if (state === undefined) throw new Error('Missing model credential metadata')
      present ||= state.configured
    }
  }
  return present
}
