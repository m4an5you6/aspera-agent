/** Original and recovery service aliases cannot duplicate or redirect operator actions. */
import { expect, it } from 'vitest'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import { fromAny } from '@total-typescript/shoehorn'
import { collectServices, serviceExample, serviceKeyBlocker, serviceStatus } from '../src/client/inference-services.ts'
import { inferenceRow, inferenceService } from './inference-fixtures.ts'
import type { AcceptanceRecovery } from '@aspera/experiments/types'

const recovery = (services = [inferenceService()]): AcceptanceRecovery => fromAny<AcceptanceRecovery, object>({ services, managedRuntimes: ['child'] })

it('combines original history and recovery aliases once using the freshest actual owner', () => {
  const saved = inferenceService()
  const stopped = inferenceService({ id: inferenceService().id, experimentId: inferenceRow('original', []).request.experimentId, state: 'stopped', released: true })
  const original = inferenceRow('original', [stopped], { acceptanceRecovery: recovery([{ ...saved, updatedAt: 15 }]) })
  const child = inferenceRow('child', [{ ...saved, detail: 'owner' }], { acceptanceParentId: original.request.experimentId })
  const rows = collectServices([original, child])
  expect(rows).toHaveLength(2)
  expect(rows[0]).toMatchObject({ displayExperimentId: 'original', experimentName: 'original', nodeName: '4090-1', service: { experimentId: 'child', detail: 'owner' } })
  expect(rows[1]?.service.released).toBe(true)
  const tied = collectServices([inferenceRow('original', [], { acceptanceRecovery: recovery() }), child])
  expect(tied[0]?.service.detail).toBe('owner')
})

it('limits detail scope to explicit descendants and retains unconfirmed failures in current services', () => {
  const original = inferenceRow('original', [], { acceptanceRecovery: recovery() })
  const child = inferenceRow('child', [inferenceService({ state: 'failed', updatedAt: 21 })], { acceptanceParentId: original.request.experimentId })
  const unrelated = inferenceRow('unrelated', [inferenceService({ experimentId: inferenceRow('unrelated', []).request.experimentId })])
  const result = collectServices([original, child, unrelated], 'original')
  expect(result).toHaveLength(1)
  expect(result[0]?.service).toMatchObject({ experimentId: 'child', released: false, state: 'failed' })
  expect(collectServices([unrelated], 'missing')).toEqual([])
})

it('uses original timestamps and keeps process health separate from external access', () => {
  expect(serviceStatus(inferenceService())).toMatchObject({ label: 'serviceAvailable', tone: 'success' })
  expect(serviceStatus(inferenceService({ external: { ...inferenceService().external!, state: 'unreachable' } }))).toMatchObject({ label: 'servicePublicBlocked', tone: 'warning' })
  expect(serviceStatus(inferenceService(), true)).toMatchObject({ label: 'serviceStatusUnconfirmed', dot: 'warning' })
  expect(serviceStatus(inferenceService(), false, true)).toMatchObject({ label: 'serviceExitPending', dot: 'ongoing' })
  expect(serviceStatus(inferenceService({ state: 'failed', released: true }))).toMatchObject({ label: 'serviceFailedHistory', tone: 'neutral' })
})

it('does not revive a deleted recovery runtime from its retained original alias', () => {
  const parent = inferenceRow('original', [], { acceptanceRecovery: recovery() })
  expect(collectServices([parent], 'original')).toHaveLength(1)
  expect(collectServices([parent], 'original', ['child'])).toEqual([])
})

it('allows an explicit key read when status is uncertain but still blocks released or unpublished services', () => {
  expect(serviceStatus(inferenceService(), true).label).toBe('serviceStatusUnconfirmed')
  expect(serviceKeyBlocker(inferenceService())).toBeUndefined()
  expect(serviceKeyBlocker(inferenceService({ released: true }))).toBe('serviceKeyStopped')
  expect(serviceKeyBlocker(inferenceService({ external: undefined }))).toBe('serviceKeyUnpublished')
  expect(serviceKeyBlocker(inferenceService(), true)).toBe('serviceKeyStopping')
})

it('requires actual public mapping and model identity without inventing loopback calling examples', () => {
  expect(serviceExample(inferenceService({ external: undefined }), 'health', 'curl', 'hello', 'setup')).toBeUndefined()
  expect(serviceExample(inferenceService({ modelName: undefined }), 'inference', 'powershell', 'hello', 'setup')).toBeUndefined()
  expect(serviceExample(inferenceService({ modelName: undefined }), 'health', 'curl', 'hello', 'setup')).toContain('/base/_aspera/health')
})

it('generates a valid generation payload for the selected model with Chinese and terminal-sensitive characters', () => {
  const modelName = 'qwen\'s "model"\nnext'
  const message = '你好，what\'s "$HOME"?\n换行'
  const service = inferenceService({ modelName })
  const code = serviceExample(service, 'inference', 'curl', message, 'setup')!
  expect(code).toContain('/base/v1/chat/completions')
  expect(code).toContain('Bearer YOUR_API_KEY')
  const shellArgument = code.slice(code.indexOf('--data-raw ') + 11)
  const json = shellArgument.slice(1, -1).replaceAll("'\\''", "'")
  expect(JSON.parse(json)).toEqual({ model: modelName, messages: [{ role: 'user', content: message }], max_tokens: 256, stream: false })
  const powershell = serviceExample(service, 'inference', 'powershell', message, 'setup')!
  expect(powershell).toContain("qwen''s")
  expect(powershell).toContain('UTF8.GetBytes($body)')
  expect(powershell).toContain('ConvertTo-Json -Depth 6')
  expect(powershell).toContain('Invoke-RestMethod @params')
  expect(powershell).toContain('$response.choices[0].message.content')
})

it('keeps health templates non-generating and all four templates credential-free', () => {
  for (const language of ['curl', 'powershell'] as const) {
    const health = serviceExample(inferenceService(), 'health', language, 'hello', 'setup')!
    expect(health).toContain('/base/_aspera/health')
    expect(health).not.toContain('messages')
    for (const kind of ['health', 'inference'] as const) {
      const code = serviceExample(inferenceService(), kind, language, 'hello', 'setup')!
      expect(code).toContain('YOUR_API_KEY')
      expect(code).not.toContain('127.0.0.1')
    }
  }
})

it('fills only explicitly supplied calling keys and preserves shell quoting', () => {
  for (const kind of ['inference', 'health'] as const) {
    const powershell = serviceExample(inferenceService(), kind, 'powershell', 'hello', 'ready', "test'key")!
    expect(powershell).toContain("$apiKey = 'test''key'")
    expect(powershell).not.toContain('YOUR_API_KEY')
    const curl = serviceExample(inferenceService(), kind, 'curl', 'hello', 'ready', "test'key")!
    expect(curl).toContain("-H 'Authorization: Bearer test'\\''key'")
  }
})

// Windows PowerShell owns the quoting and UTF-8 behavior of the desktop's default example.
it.skipIf(process.platform !== 'win32')('executes both PowerShell examples with literal Chinese, quotes and newlines intact', () => {
  const modelName = 'qwen\'s "model"\nnext'
  const message = '你好，what\'s "$HOME"?\n换行'
  for (const kind of ['inference', 'health'] as const) {
    const example = serviceExample(inferenceService({ modelName }), kind, 'powershell', message, 'ready', "test'key")!
    const script = `
$ErrorActionPreference = 'Stop'
function Invoke-WebRequest {
  param($Uri, $Method, $Headers, $ContentType, [byte[]]$Body, [switch]$UseBasicParsing)
  $observed = @{ uri = $Uri; method = $Method; authorization = $Headers.Authorization; contentType = $ContentType }
  if ($Body) { $observed.body = [System.Text.Encoding]::UTF8.GetString($Body) | ConvertFrom-Json }
  $json = $observed | ConvertTo-Json -Depth 8 -Compress
  [Console]::Out.WriteLine([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json)))
  return @{ RawContentStream = [System.IO.MemoryStream]::new([System.Text.Encoding]::UTF8.GetBytes('{"choices":[{"message":{"content":"fixture reply"}}]}')) }
}
${example}
`
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      windowsHide: true, timeout: 30000, encoding: 'utf8',
    })
    const observed: object = JSON.parse(Buffer.from(output.trim().split(/\r?\n/)[0]!, 'base64').toString('utf8'))
    expect(observed).toMatchObject({ method: kind === 'health' ? 'GET' : 'POST', authorization: "Bearer test'key" })
    if (kind === 'inference') expect(observed).toMatchObject({ contentType: 'application/json; charset=utf-8',
      body: { model: modelName, messages: [{ role: 'user', content: message }], max_tokens: 256, stream: false } })
    else expect(observed).not.toHaveProperty('body')
  }
}, 60000)

it.skipIf(process.platform !== 'win32')('decodes UTF-8 JSON replies without a response charset in Windows PowerShell', async () => {
  const reply = '你好，我是人工智能助手。'
  const received: object[] = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (chunks.length > 0) {
      const body: object = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      received.push(body)
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ status: reply, choices: [{ message: { content: reply } }] }))
  })
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Expected a loopback listener')
    const service = inferenceService({ external: { ...inferenceService().external!, url: `http://127.0.0.1:${address.port}` } })
    for (const kind of ['inference', 'health'] as const) {
      const code = serviceExample(service, kind, 'powershell', '你好，请介绍自己。', 'ready', 'fixture-key')!
      const script = `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\n$result = & {\n${code}\n}\n[Console]::Write([Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]${kind === 'health' ? '$result.status' : '$result'})))`
      const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        windowsHide: true, timeout: 30000, encoding: 'utf8',
      })
      expect(Buffer.from(stdout.trim(), 'base64').toString('utf8')).toBe(reply)
    }
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ messages: [{ content: '你好，请介绍自己。' }] })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done, reject) => { server.close(error => { if (error) reject(error); else done() }) })
  }
}, 60000)
