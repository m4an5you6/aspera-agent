/** Real HTTP fixtures exercise public authentication, forwarding, identity checks and listener disposal. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { inferenceMappingSchema, serviceSchema } from '@aspera/experiments'
import { openInferenceGateway } from '../src/inference-gateway.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function listen(server: Server): Promise<number> {
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  cleanup.push(() => new Promise<void>((done) => { server.closeAllConnections(); server.close(() => { done() }) }))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('Fixture listener has no port')
  return address.port
}
async function fixture(url?: string) {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts/inference-gateway-'))
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }) })
  const seen: { path: string; authorization: string | undefined; body: string }[] = []
  const backend = createServer((req, res) => {
    if (req.url === '/health') { res.end('ok'); return }
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      seen.push({ path: req.url ?? '/', authorization: req.headers.authorization, body })
      res.setHeader('content-type', 'text/event-stream')
      res.write('data: first\n\n'); res.end('data: [DONE]\n\n')
    })
  })
  const port = await listen(backend)
  const reserved = createServer()
  const mappedPort = await listen(reserved)
  await new Promise<void>(done => { reserved.close(() => { done() }) })
  const service = serviceSchema.parse({ id: randomUUID(), experimentId: randomUUID(), serverId: randomUUID(),
    commandId: 'service', command: 'test', modelPath: 'model', modelName: 'test-model', port, healthPath: '/health',
    state: 'healthy', createdAt: 1, updatedAt: 1, released: false,
    external: { url: url ?? `http://127.0.0.1:${mappedPort}/models/demo`, port: mappedPort, state: 'unchecked' } })
  let live = true
  const gateway = await openInferenceGateway(service, { root, healthTimeoutMs: 2000, requestTimeoutMs: 2000, requestBytes: 1024 }, () => live)
  cleanup.push(() => gateway.close())
  return { gateway, service, seen, address: `http://127.0.0.1:${mappedPort}`, stopProcess: () => { live = false } }
}

it('requires a service-only Bearer key and forwards streaming POST bodies without sending that key to the model', async () => {
  const f = await fixture()
  expect((await fetch(f.address)).status).toBe(401)
  expect((await fetch(f.address, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401)
  expect(f.seen).toEqual([])
  const access = f.gateway.access()
  expect(access.modelName).toBe('test-model')
  expect(JSON.stringify(f.service)).not.toContain(access.token)
  const response = await fetch(access.url + '/v1/chat/completions', { method: 'POST',
    headers: { authorization: 'Bearer ' + access.token, 'content-type': 'application/json' }, body: '{"stream":true}' })
  expect(response.headers.get('content-type')).toBe('text/event-stream')
  expect(await response.text()).toBe('data: first\n\ndata: [DONE]\n\n')
  expect(f.seen).toEqual([{ path: '/v1/chat/completions', authorization: undefined, body: '{"stream":true}' }])
  expect(await f.gateway.probe()).toMatchObject({ state: 'reachable' })
  f.stopProcess()
  expect(await f.gateway.probe()).toMatchObject({ state: 'unreachable', detail: expect.stringContaining('503') })
  await f.gateway.close()
  await expect(fetch(f.address)).rejects.toThrow()
})

it('reports a different service and refuses redirected health checks', async () => {
  const wrong = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"serviceId":"other"}') })
  const wrongPort = await listen(wrong)
  const f = await fixture(`http://127.0.0.1:${wrongPort}`)
  expect(await f.gateway.probe()).toMatchObject({ state: 'unreachable', detail: expect.stringContaining('different service') })
  let redirected = false
  const destination = createServer((_req, res) => { redirected = true; res.end('unexpected') })
  const port = await listen(destination)
  wrong.removeAllListeners('request')
  wrong.on('request', (_req, res) => { res.writeHead(302, { location: `http://127.0.0.1:${port}/` }); res.end() })
  expect(await f.gateway.probe()).toMatchObject({ state: 'unreachable' })
  expect(redirected).toBe(false)
})

it('rejects credentials and ambiguous external addresses while allowing HTTPS ports and path prefixes', () => {
  expect(inferenceMappingSchema.parse({ url: 'https://example.test:8443/prefix', port: 17000 })).toEqual({ url: 'https://example.test:8443/prefix', port: 17000 })
  for (const url of ['http://example.test', 'https://user:password@example.test', 'https://example.test/?token=secret', 'https://example.test/#fragment', 'file:///tmp/model']) {
    expect(inferenceMappingSchema.safeParse({ url, port: 17000 }).success).toBe(false)
  }
})
