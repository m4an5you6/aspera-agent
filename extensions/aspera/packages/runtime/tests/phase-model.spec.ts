/** Real published providers send three phase requests to CPU-only loopback API fixtures. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { phaseModelSnapshotSchema } from '@aspera/experiments'
import { afterEach, expect, it } from 'vitest'
import { openPhaseModelContext } from '../src/phase-model.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it.each(['pi-ai', 'deepseek-api-key'] as const)('%s uses each fixed endpoint, model and key and refuses missing snapshots', async adapter => {
  const requests: { path: string; authorization: string | undefined; body: unknown }[] = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization ?? req.headers['x-api-key']?.toString(), body: JSON.parse(Buffer.concat(chunks).toString()) })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    if (adapter === 'deepseek-api-key') {
      for (const event of [
        { type: 'message_start', message: { id: 'cpu-response', model: 'deepseek-v4-flash', usage: { input_tokens: 3, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fixture reply' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      res.end(); return
    }
    for (const delta of [{ role: 'assistant', content: 'fixture reply' }, {}]) res.write(`data: ${JSON.stringify({ id: 'cpu-response', object: 'chat.completion.chunk', created: 1, model: 'phase-model', choices: [{ index: 0, delta, finish_reason: 'content' in delta ? null : 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  cleanups.push(() => new Promise<void>((done, reject) => { server.close(error => { if (error) reject(error); else done() }); server.closeAllConnections() }))
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('fixture did not bind')
  const home = await mkdtemp(join(tmpdir(), 'aspera-phase-'))
  cleanups.push(() => rm(home, { recursive: true, force: true }))
  const ctx = new Context(); cleanups.push(() => ctx.fiber.dispose())
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LocalCredentialProvider, { path: join(home, 'credentials.json'), watch: false })
  await ctx.credentials.set(credentialRef('GLOBAL_TEST_KEY'), 'changed-global-key')
  for (const phase of ['preparation', 'planning', 'execution']) {
    const keyRef = `ASPERA_KEY_${phase.toUpperCase()}`; const configurationRef = `ASPERA_MODEL_${phase.toUpperCase()}`
    const model = adapter === 'pi-ai' ? `qwen-${phase}` : 'deepseek-v4-flash'; const baseURL = `http://127.0.0.1:${address.port}/${phase}`
    const provider = adapter === 'pi-ai' ? 'qwen-fixture' : 'deepseek-official'
    const api = adapter === 'pi-ai' ? 'openai-completions' : 'deepseek-messages'
    const value = JSON.stringify({ version: 1, adapter, provider, keyRef,
      options: { apiKeyEnv: keyRef, baseURL, retryPolicy: { mode: 'normal', maxRetries: 0 },
        ...(adapter === 'pi-ai' ? { api, models: [{ id: model, contextWindow: 8192, maxTokens: 512 }] } : {}) } })
    await ctx.credentials.set(credentialRef(keyRef), `private-${phase}-key`)
    await ctx.credentials.set(credentialRef(configurationRef), value)
    const snapshot = phaseModelSnapshotSchema.parse({ provider, model, adapter, adapterVersion: '0.2.0-rc.2', api, baseURL,
      configurationRef, configurationHash: createHash('sha256').update(value).digest('hex') })
    const scope = await openPhaseModelContext(ctx, snapshot)
    try {
      const chunks = []
      for await (const chunk of scope.context.llm.stream({ provider: snapshot.provider, model, messages: [], tools: [] })) chunks.push(chunk)
      expect(JSON.stringify(chunks)).toContain('fixture reply')
      expect(requests.at(-1)).toMatchObject({ path: `/${phase}/${adapter === 'pi-ai' ? 'chat/completions' : 'v1/messages'}`,
        authorization: `${adapter === 'pi-ai' ? 'Bearer ' : ''}private-${phase}-key`, body: { model } })
      expect(ctx.llm.listProviders()).toEqual([])
    } finally { await scope.dispose() }
    await ctx.credentials.unset(credentialRef(keyRef))
    await expect(openPhaseModelContext(ctx, snapshot)).rejects.toThrow('credential snapshot is missing')
  }
  expect(requests).toHaveLength(3)
})
