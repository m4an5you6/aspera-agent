/** Keyless model and turn observer for the real Web profile's first filesystem call. */

import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { runFixtureTurn } from '@deepseek-ai/dsh-loader-smoke'

class ReadAdapter extends LlmAdapter {
  constructor(filePath) {
    super()
    this.filePath = filePath
  }

  async resolveModel(provider, model) {
    return { provider, id: model, name: model }
  }

  async * stream(options) {
    const result = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (result === undefined) {
      const call = {
        type: 'tool-call',
        id: ToolCallId('web-read-call'),
        name: 'read',
        arguments: JSON.stringify({ file_path: this.filePath }),
      }
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: call.id, name: call.name, argumentsDelta: call.arguments }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'web-tool-turn'
export const inject = ['llm', 'agents', 'tools', 'sessions']

/** Register the deterministic model and drive a turn after the parent observes Web readiness. */
export function apply(ctx, config) {
  ctx.llm.registerAdapter(['web-tool-turn'], new ReadAdapter(config.filePath))
  const receive = async (command) => {
    if (command === 'stop') {
      process.emit('SIGTERM')
      return
    }
    if (command !== 'turn') return
    const events = []
    try {
      const result = await runFixtureTurn(ctx, {
        task: 'Read the fixture file once.',
        onEvent: (_sessionId, event) => {
          if (['tool/call', 'tool/result', 'turn/end'].includes(event.type)) events.push(event)
        },
      })
      process.send?.({ events, output: result.output })
    } catch (error) {
      process.send?.({ error: String(error), events })
    }
  }
  ctx.effect(() => {
    process.on('message', receive)
    return () => { process.off('message', receive) }
  })
}
