/** Loopback OpenAI-compatible responses reached through the published pi-ai adapter. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { workerResponses } from './worker.mjs'

export async function createWorkerApi() {
  let current
  const server = createServer((request, response) => {
    void (async () => {
      assert.ok(current, 'No HTTP worker scenario is active')
      const { config, observed, responses } = current
      const chunks = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const body = JSON.parse(Buffer.concat(chunks).toString())
      assert.equal(request.url, '/v1/chat/completions')
      assert.equal(request.headers.authorization, `Bearer cpu-only-${config.planning ? 'planning' : 'execution'}`)
      assert.equal(body.stream, true)
      Object.assign(observed, JSON.parse(readFileSync(config.observed, 'utf8')))
      current.requests += 1
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (delta, finish_reason = null) => response.write(`data: ${JSON.stringify({
        id: 'worker-response', object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason }],
      })}\n\n`)
      send({ role: 'assistant' })
      if (JSON.stringify(body.messages.at(-1)).includes('You are now acting as a compaction engine')) {
        assert.ok(config.contextPressure, 'Unexpected compaction request in the short replay')
        current.summaryRequests += 1
        const history = JSON.stringify(body.messages.slice(0, -1))
        const facts = ['name: unsloth', 'lack completed reports', 'read the latest revision', 'The first source is unavailable', 'has no recorded framework', 'An execution record write has not committed', 'claimed budget failure is unconfirmed']
          .filter(text => history.includes(text))
        send({ content: 'Verified CPU replay checkpoint. Preserve the approved plan, server and settled command identities. ' + facts.join('; ') })
        send({}, 'stop'); response.end('data: [DONE]\n\n'); return
      }
      for await (const chunk of responses({ model: body.model, tools: body.tools?.map(tool => tool.function), messages: body.messages })) {
        if (chunk.type === 'block-end') {
          const block = chunk.block
          send(block.type === 'text' ? { content: block.text } : { tool_calls: [{ index: 0, id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }] })
        }
        if (chunk.type === 'finish') send({}, chunk.reason.kind === 'tool-calls' ? 'tool_calls' : chunk.reason.kind === 'max-tokens' ? 'length' : 'stop')
      }
      response.end('data: [DONE]\n\n')
    })().catch(error => {
      if (current) current.error = error
      current?.onError?.()
      if (!response.headersSent) response.writeHead(500)
      response.end('Worker HTTP fixture failed')
    })
  })
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return {
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    begin(config) {
      const observed = { tools: [], calls: [], guidanceRead: false, inputRead: false, inputBlocked: false }
      current = { config, observed, responses: workerResponses(config, observed), requests: 0, summaryRequests: 0 }
      return current
    },
    close: () => new Promise((done, reject) => { server.close(error => error ? reject(error) : done()); server.closeAllConnections() }),
  }
}
