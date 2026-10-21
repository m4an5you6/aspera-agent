/** Replay the desktop Agent and captured phase snapshots through the packaged DeepSeek provider without a real key. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const inject = ['loader', 'agents', 'agentLoop', 'llm', 'sessions', 'settings', 'credentials']

/** Run after the real desktop profile settles and retain its canonical Session diagnostics. */
export function apply(ctx, config) {
  void ctx.loader.await().then(async () => {
    const root = process.env.ASPERA_EXTENSION_ROOT
    assert.ok(root)
    const { createUserMessage } = await import(pathToFileURL(resolve(root, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href)
    const { SessionId } = await import(pathToFileURL(resolve(root, 'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href)
    const { credentialRef } = await import(pathToFileURL(resolve(root, 'node_modules/@deepseek-ai/dsh-credentials/lib/index.js')).href)
    const { resolveAdapterOptions } = await import(pathToFileURL(resolve(root, 'node_modules/@deepseek-ai/dsh-llm-deepseek-api-key/lib/index.js')).href)
    const { captureExperimentModels } = await import(pathToFileURL(resolve(root, 'node_modules/@aspera/dispatch/lib/models.js')).href)
    const { openPhaseModelContext, experimentIdSchema } = await import(pathToFileURL(resolve(root, 'node_modules/@aspera/runtime/lib/index.js')).href)
    const handle = await ctx.agents.create({ sessionId: SessionId('desktop-deepseek-profile-replay'),
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' }, meta: { cwd: config.workspace } })
    let events, conversation
    try {
      handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Reply with DESKTOP_EXTENSION_OK.' }] }))
      await handle.agent.whenIdle()
      events = handle.agent.session.snapshotEvents()
      conversation = summarize(handle.agent)
    } finally { await handle.dispose() }
    const selection = { provider: 'deepseek-official', model: 'deepseek-flash' }
    const snapshots = await captureExperimentModels(ctx, experimentIdSchema.parse(randomUUID()),
      { preparation: selection, planning: selection, execution: selection })
    const phases = [], phaseEvents = []
    for (const [phase, original] of Object.entries(snapshots)) {
      const saved = (await ctx.credentials.resolve(credentialRef(original.configurationRef))).value
      for (const layout of ['config', 'resolved']) {
        let snapshot = original, value = saved
        if (layout === 'resolved') {
          const stored = JSON.parse(saved)
          value = JSON.stringify({ ...stored, options: resolveAdapterOptions(stored.options) })
          snapshot = { ...original, configurationRef: original.configurationRef + '_LEGACY',
            configurationHash: createHash('sha256').update(value).digest('hex') }
          await ctx.credentials.set(credentialRef(snapshot.configurationRef), value)
        }
        const scope = await openPhaseModelContext(ctx, snapshot)
        try {
          const handle = await scope.context.agents.create({ sessionId: SessionId(`desktop-${phase}-${layout}`),
            agentOptions: selection, meta: { cwd: config.workspace } })
          try {
            handle.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Reply with DESKTOP_EXTENSION_OK.' }] }))
            await handle.agent.whenIdle()
            const preserved = (await ctx.credentials.resolve(credentialRef(snapshot.configurationRef))).value === value
            phases.push({ phase, layout, ...summarize(handle.agent), snapshotPreserved: preserved })
            phaseEvents.push({ phase, layout, events: handle.agent.session.snapshotEvents() })
          } finally { await handle.dispose() }
        } finally { await scope.dispose() }
      }
    }
    save(config.observed, { result: { conversation, phases }, events, phaseEvents })
  }).catch(error => { save(config.observed, { error: { message: error.message } }) })
}

/** Read completed Agent output and canonical request-extension acceptance. */
function summarize(agent) {
  const events = agent.session.snapshotEvents()
  const end = events.findLast(event => event.type === 'turn/end')
  const message = agent.session.deriveMessages().findLast(message => message.role === 'assistant')
  return { provider: 'deepseek-official', model: 'deepseek-flash', turnResult: end?.data.reason.kind,
    response: message?.content.filter(block => block.type === 'text').map(block => block.text).join(''),
    sessionLogAccepted: events.some(event => event.type === 'session-log-deepseek/delivery-accepted'),
    ...end?.data.reason.kind === 'error' ? { error: end.data.reason.error } : {} }
}

/** Replace the completed replay result without exposing a partial JSON record. */
function save(file, value) {
  writeFileSync(file + '.incoming', JSON.stringify(value, null, 2) + '\n')
  renameSync(file + '.incoming', file)
}
