/** Real published providers send three phase requests to CPU-only loopback API fixtures. */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import * as PiAi from '@deepseek-ai/dsh-llm-pi-ai'
import * as DeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { phaseModelSnapshotSchema } from '@aspera/experiments'
import { afterEach, expect, it } from 'vitest'
import { openPhaseModelContext } from '../src/phase-model.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })

it.each([
  { adapter: 'pi-ai', layout: 'config' },
  { adapter: 'deepseek-api-key', layout: 'config' },
  { adapter: 'deepseek-api-key', layout: 'resolved' },
] as const)('$adapter $layout creates and resumes concurrent phase Agents with private routes and shared lifecycle', async ({ adapter, layout }) => {
  const requests: { path: string; authorization: string | undefined; body: unknown }[] = []
  const heldRequest = Promise.withResolvers<void>()
  const heldSummary = Promise.withResolvers<void>()
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const payload = Buffer.concat(chunks).toString()
    requests.push({ path: req.url ?? '', authorization: req.headers.authorization ?? req.headers['x-api-key']?.toString(), body: JSON.parse(payload) })
    if (payload.includes('Wait until cancelled')) { heldRequest.resolve(); return }
    if (payload.includes('Cancelled summary evidence') && payload.includes('You are now acting as a compaction engine')) {
      heldSummary.resolve(); return
    }
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
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPersistence, { root: join(home, 'sessions') })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  const owner = await ctx.plugin({ inject: ['agents', 'agentLoop', 'llm', 'credentials'], apply() {} })
  const failures: string[] = []
  ctx.on('agent/error', ({ error }) => { failures.push(String(error)) }, { global: true })
  const created: string[] = []; const disposed: string[] = []
  ctx.on('agent/created', ({ agent }) => { expect(ctx.agents.get(agent.id)).toBe(agent); created.push(agent.id) }, { global: true })
  ctx.on('agent/disposed', ({ agent }) => { expect(ctx.agents.get(agent.id)).toBeUndefined(); disposed.push(agent.id) }, { global: true })
  ctx.on('agent/request', ({ agent }, next) => { expect(ctx.agents.currentInitiator()).toBe(agent); return next() }, { global: true })
  await ctx.credentials.set(credentialRef('GLOBAL_TEST_KEY'), 'changed-global-key')
  const provider = adapter === 'pi-ai' ? 'qwen-chat' : 'deepseek-official'
  const globalOptions = { apiKeyEnv: 'GLOBAL_TEST_KEY', baseURL: `http://127.0.0.1:${address.port}/global`, retryPolicy: { mode: 'normal' as const, maxRetries: 0 } }
  if (adapter === 'pi-ai') await ctx.plugin(PiAi, { providers: { [provider]: { ...globalOptions, api: 'openai-completions',
    models: ['preparation', 'planning', 'execution'].map(phase => ({ id: `qwen-${phase}`, contextWindow: 8192, maxTokens: 512 })) } } })
  else await ctx.plugin(DeepSeek, globalOptions)
  await ctx.plugin(ToolResultPruner)
  await ctx.plugin(BasicCompactionEngine, { thresholdRatio: 0.5, headroomTokens: 1024, retainRatio: 0.1, maxTokens: 512 })
  const parentProviders = ctx.llm.listProviders()
  const scenarios = []
  for (const phase of ['preparation', 'planning', 'execution']) {
    const keyRef = `ASPERA_KEY_${phase.toUpperCase()}`; const configurationRef = `ASPERA_MODEL_${phase.toUpperCase()}`
    const model = adapter === 'pi-ai' ? `qwen-${phase}` : 'deepseek-v4-flash'; const baseURL = `http://127.0.0.1:${address.port}/${phase}`
    const api = adapter === 'pi-ai' ? 'openai-completions' : 'deepseek-messages'
    const options = { apiKeyEnv: keyRef, baseURL, retryPolicy: { mode: 'normal' as const, maxRetries: 0 },
      ...(adapter === 'pi-ai' ? { api, models: [{ id: model, contextWindow: 8192, maxTokens: 512 }] } : {}) }
    const value = JSON.stringify({ version: 1, adapter, provider, keyRef,
      options: layout === 'resolved' ? DeepSeek.resolveAdapterOptions(options) : options })
    await ctx.credentials.set(credentialRef(keyRef), `private-${phase}-key`)
    await ctx.credentials.set(credentialRef(configurationRef), value)
    const snapshot = phaseModelSnapshotSchema.parse({ provider, model, adapter, adapterVersion: '0.2.0-rc.2', api, baseURL,
      configurationRef, configurationHash: createHash('sha256').update(value).digest('hex') })
    scenarios.push({ phase, keyRef, snapshot, value, retryPolicy: DeepSeek.resolveAdapterOptions(options).retryPolicy })
  }
  const results = await Promise.allSettled(scenarios.map(async ({ phase, keyRef, snapshot, value, retryPolicy }) => {
    await expect(openPhaseModelContext(owner.ctx, { ...snapshot, configurationHash: '0'.repeat(64) })).rejects.toThrow('snapshot changed')
    const sessionId = SessionId(`phase-${adapter}-${phase}`)
    for (const resume of [false, true]) {
      const scope = await openPhaseModelContext(owner.ctx, snapshot, { compaction: { thresholdRatio: 0.5,
        headroomTokens: 1024, retainRatio: 0.1, maxTokens: 512 }, pruning: {} })
      try {
        expect(scope.context.llm.providerRetryPolicy(provider)).toEqual(retryPolicy)
        const options = { agentOptions: { provider, model: snapshot.model } }
        const handle = resume ? await scope.context.agents.resume({ resumeSessionId: sessionId, ...options })
          : await scope.context.agents.create({ sessionId, ...options })
        try {
          expect(ctx.agents.get(sessionId)).toBe(handle.agent)
          handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text:
            adapter === 'pi-ai' && !resume ? 'Earlier measured evidence: ' + 'x '.repeat(10000) : 'Reply through the saved experiment provider.' }] }))
          await handle.agent.whenIdle()
          if (adapter === 'pi-ai' && !resume) {
            handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Recent verified facts: ' + 'y '.repeat(2500) }] }))
            await handle.agent.whenIdle()
          }
          expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'assistant/message')).toHaveLength(adapter === 'pi-ai' ? resume ? 3 : 2 : resume ? 2 : 1)
          expect(JSON.stringify(handle.agent.session.snapshotEvents())).toContain('fixture reply')
          expect(JSON.stringify(handle.agent.session.snapshotEvents())).not.toContain(`private-${phase}-key`)
          if (adapter === 'pi-ai' && resume) {
            const summaries = handle.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')
            expect(summaries).toHaveLength(1)
            expect(summaries[0]!.data).toMatchObject({ provider, model: snapshot.model, llmStreamCall: true })
          }
        } finally { await handle.dispose() }
        expect(ctx.agents.get(sessionId)).toBeUndefined()
      } finally { await scope.dispose() }
    }
    const phaseRequests = requests.filter(request => request.path.startsWith(`/${phase}/`))
    expect(phaseRequests).toHaveLength(adapter === 'pi-ai' ? 4 : 2)
    for (const request of phaseRequests) expect(request).toMatchObject({ path: `/${phase}/${adapter === 'pi-ai' ? 'chat/completions' : 'v1/messages'}`,
      authorization: `${adapter === 'pi-ai' ? 'Bearer ' : ''}private-${phase}-key`, body: { model: snapshot.model } })
    expect((await ctx.credentials.resolve(credentialRef(snapshot.configurationRef)))?.value).toBe(value)
    if (phase === 'preparation') {
      const scope = await openPhaseModelContext(owner.ctx, snapshot)
      try {
        const handle = await scope.context.agents.create({ sessionId: SessionId(`cancel-${adapter}`), agentOptions: { provider, model: snapshot.model } })
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Wait until cancelled' }] }))
        await heldRequest.promise
        await scope.dispose()
        expect(handle.agent.status).toBe('idle')
        expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
      } finally { await scope.dispose() }
      if (adapter === 'pi-ai') {
        const summaryScope = await openPhaseModelContext(owner.ctx, snapshot, { compaction: { thresholdRatio: 0.5,
          headroomTokens: 1024, retainRatio: 0.1, maxTokens: 512 }, pruning: {} })
        try {
          const handle = await summaryScope.context.agents.create({ sessionId: SessionId('cancel-summary'), agentOptions: { provider, model: snapshot.model } })
          for (const text of ['Cancelled summary evidence: ' + 'x '.repeat(10000), 'Recent verified facts: ' + 'y '.repeat(2500)]) {
            handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
            await handle.agent.whenIdle()
          }
          handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Continue after the verified facts.' }] }))
          await heldSummary.promise
          await summaryScope.dispose()
          expect(handle.agent.status).toBe('idle')
          expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toEqual([])
          expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
        } finally { await summaryScope.dispose() }
      }
    }
    await expect(openPhaseModelContext(owner.ctx, snapshot, { compaction: { summarizationModel: 'another-model' }, pruning: {} }))
      .rejects.toThrow('saved provider and model')
    await expect(openPhaseModelContext(owner.ctx, snapshot, { compaction: { modelPolicies: [{ provider, model: snapshot.model,
      summarizationProvider: 'another-provider' }] }, pruning: {} })).rejects.toThrow('saved provider and model')
    await ctx.credentials.unset(credentialRef(keyRef))
    await expect(openPhaseModelContext(owner.ctx, snapshot)).rejects.toThrow('credential snapshot is missing')
  }))
  for (const result of results) if (result.status === 'rejected') throw result.reason
  if (adapter === 'pi-ai') {
    const handle = await ctx.agents.create({ sessionId: SessionId('ordinary-conversation'), agentOptions: { provider, model: 'qwen-preparation' } })
    try {
      for (const text of ['Ordinary conversation history: ' + 'x '.repeat(10000), 'Recent user facts: ' + 'y '.repeat(2500), 'Continue the ordinary conversation.']) {
        handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
        await handle.agent.whenIdle()
      }
      expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    } finally { await handle.dispose() }
    const globalRequests = requests.filter(request => request.path.startsWith('/global/'))
    expect(globalRequests).toHaveLength(4)
    for (const request of globalRequests) expect(request.authorization).toBe('Bearer changed-global-key')
  }
  expect(ctx.llm.listProviders()).toEqual(parentProviders)
  expect(ctx.agents.list()).toEqual([])
  expect(failures).toEqual([])
  expect(created).toHaveLength(adapter === 'pi-ai' ? 9 : 7)
  expect(disposed).toHaveLength(adapter === 'pi-ai' ? 9 : 7)
  expect(requests).toHaveLength(adapter === 'pi-ai' ? 20 : 7)
  if (adapter === 'pi-ai') {
    const bodies = requests.map(request => JSON.stringify(request.body))
    expect(bodies.filter(body => body.includes('You are now acting as a compaction engine'))).toHaveLength(5)
    expect(bodies.filter(body => body.includes('<compacted-summary>') && !body.includes('You are now acting as a compaction engine'))).toHaveLength(4)
  }
})
