/** Desktop onboarding reads model credential presence without fetching credential values. */
import { expect, it } from 'vitest'
import { readApiKeyPresence } from '../src/credential-presence.ts'

it('discovers nested provider references and reads metadata only', async () => {
  const calls: { method: string; args: Record<string, unknown> }[] = []
  const send = async (_url: string, request: RequestInit): Promise<Response> => {
    const body: { rpcId: string; method: string; payload: { args: Record<string, unknown> } } = JSON.parse(String(request.body))
    calls.push({ method: body.method, args: body.payload.args })
    const value = body.method === 'settings/describe' ? { namespaces: [
      { ns: 'llm-deepseek', value: { apiKeyEnv: 'OFFICIAL_KEY' } },
      { ns: 'custom', value: { providers: { primary: { apiKeyEnv: 'CUSTOM_KEY' } } } },
    ] } : body.method === 'llm/listConfigurableProviders' ? [
      { settingsNs: 'custom', settingsPath: ['providers', 'primary'] },
    ] : { OFFICIAL_KEY: { configured: false, writable: true }, CUSTOM_KEY: { configured: true, writable: false } }
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })
  }
  expect(await readApiKeyPresence('http://127.0.0.1:12345', send)).toBe(true)
  expect(calls).toEqual([
    { method: 'settings/describe', args: {} }, { method: 'llm/listConfigurableProviders', args: {} },
    { method: 'credentials/describe', args: { refs: ['OFFICIAL_KEY', 'CUSTOM_KEY'] } },
  ])
})

it('rejects failed or missing credential metadata instead of claiming no key', async () => {
  const send = async (_url: string, request: RequestInit): Promise<Response> => {
    const body: { rpcId: string; method: string } = JSON.parse(String(request.body))
    const value = body.method === 'settings/describe' ? { namespaces: [{ ns: 'llm-deepseek', value: { apiKeyEnv: 'OFFICIAL_KEY' } }] }
      : body.method === 'llm/listConfigurableProviders' ? [] : {}
    return Response.json({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } })
  }
  await expect(readApiKeyPresence('http://127.0.0.1:12345', send)).rejects.toThrow('Missing model credential metadata')
  await expect(readApiKeyPresence('http://127.0.0.1:12345', async () => new Response('', { status: 503 }))).rejects.toThrow('metadata request failed')
})
