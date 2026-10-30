/** Real local HTTP verifies fixed-prompt generation, service identity, authentication and non-replay after disconnect. */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { serviceVerificationSchema, serviceVerificationClaimIdSchema, serviceVerificationResultSchema } from '@aspera/experiments'
import { verifyPublicInference, PublicServiceChecks } from '../src/service-verification.ts'
import type { PublicServiceCheckOwner } from '../src/service-verification.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  const experimentId = randomUUID(), serviceId = randomUUID(), token = 'a'.repeat(64), seen: object[] = []
  let unsafeAuthentication = false, disconnect = false, wrongIdentity = false
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    response.setHeader('content-type', 'application/json')
    if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(unsafeAuthentication ? 200 : 401); response.end('{}'); return }
    if (url.pathname === '/_aspera/health') { response.end(JSON.stringify({ serviceId: wrongIdentity ? randomUUID() : serviceId, experimentId, nonce: url.searchParams.get('nonce') })); return }
    if (url.pathname === '/v1/models') { response.end('{"data":[{"id":"fixture"}]}'); return }
    let body = ''
    request.on('data', chunk => { body += String(chunk) })
    request.on('end', () => {
      seen.push(JSON.parse(body))
      if (disconnect) { response.destroy(); return }
      response.end(JSON.stringify({ model: 'fixture', choices: [{ message: { role: 'assistant', content: 'Service available' } }] }))
    })
  })
  await new Promise<void>((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  cleanup.push(() => new Promise<void>(done => { server.closeAllConnections(); server.close(() => { done() }) }))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture listener has no port')
  const url = 'http://127.0.0.1:' + address.port
  const operation = serviceVerificationSchema.parse({ version: 1, experimentId, serverId: randomUUID(), deploymentId: 'b'.repeat(64),
    input: { operationId: randomUUID(), serviceId, maxTokens: 16 }, commandId: 'service', modelName: 'fixture', url,
    createdAt: Date.now(), deadline: Date.now() + 10000, state: 'claimed', claimId: randomUUID() })
  return { operation, access: { url, token, modelName: 'fixture' }, seen,
    unauthenticatedAccepted: () => { unsafeAuthentication = true }, disconnect: () => { disconnect = true }, wrongService: () => { wrongIdentity = true } }
}
it('uses only the fixed harmless prompt and records five actual checks without a credential', async () => {
  const f = await fixture(), result = await verifyPublicInference(f.operation, f.access, new AbortController().signal, 65536, 'direct')
  expect(result.state).toBe('passed'); expect(result.checks).toHaveLength(5)
  expect(f.seen).toEqual([{ model: 'fixture', stream: false, temperature: 0, max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with one short sentence confirming this LoRA inference service is available.' }] }])
  expect(JSON.stringify(result)).not.toContain(f.access.token)
})
it('refuses an unprotected or different public service before sending a generation', async () => {
  const f = await fixture(); f.unauthenticatedAccepted()
  expect((await verifyPublicInference(f.operation, f.access, new AbortController().signal, 65536, 'direct')).state).toBe('failed')
  expect(f.seen).toEqual([])
  const wrong = await fixture(); wrong.wrongService()
  expect((await verifyPublicInference(wrong.operation, wrong.access, new AbortController().signal, 65536, 'direct')).state).toBe('failed')
  expect(wrong.seen).toEqual([])
})
it('records a lost generation response as unknown and never retries it', async () => {
  const f = await fixture(); f.disconnect()
  expect((await verifyPublicInference(f.operation, f.access, new AbortController().signal, 65536, 'direct')).state).toBe('unknown')
  expect(f.seen).toHaveLength(1)
})
it('recovers a saved Host result after restart without issuing a second generation', async () => {
  const f = await fixture()
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts/public-verification-'))
  cleanup.push(async () => { rmSync(root, { recursive: true, force: true }) })
  let record = serviceVerificationSchema.parse({ ...f.operation, state: 'requested', claimId: undefined }), rejectCommit = true
  const owner: PublicServiceCheckOwner = { alive: () => true, report: vi.fn(), call: async (id, operation, input) => {
    expect(id).toBe(f.operation.experimentId)
    if (operation === 'service-verification-pending') return { supported: true, operations: ['requested', 'claimed'].includes(record.state) ? [record] : [] }
    if (operation === 'service-verification-claim') {
      if (!('claimId' in input)) throw new Error('Claim identity missing')
      record = { ...record, state: 'claimed', claimId: serviceVerificationClaimIdSchema.parse(input.claimId) }
      return { operation: record, access: f.access }
    }
    expect(operation).toBe('service-verification-result')
    if (rejectCommit) throw new Error('Original result commit transport failed')
    if (!('result' in input)) throw new Error('Result missing')
    const result = serviceVerificationResultSchema.parse(input.result)
    record = { ...record, state: result.state, result }; return record
  } }
  const first = new PublicServiceChecks(root, owner, 65536, 10000, 'direct')
  cleanup.push(() => first.close())
  first.changed(f.operation.experimentId)
  await vi.waitFor(() => { expect(owner.report).toHaveBeenCalledOnce() })
  await first.close(); rejectCommit = false
  const recovered = new PublicServiceChecks(root, owner, 65536, 10000, 'direct')
  cleanup.push(() => recovered.close())
  recovered.changed(f.operation.experimentId)
  await vi.waitFor(() => { expect(record.state).toBe('passed') })
  expect(f.seen).toHaveLength(1)
})

it('uses a request-owned direct transport while preserving the inherited fetch policy', async () => {
  const f = await fixture()
  const proxyFailure = new TypeError('fetch failed', { cause: Object.assign(new Error('Private proxy diagnostic must stay private'), { code: 'ECONNRESET' }) })
  const inherited = vi.spyOn(globalThis, 'fetch').mockRejectedValue(proxyFailure)
  try {
    const failed = await verifyPublicInference(f.operation, f.access, new AbortController().signal, 65536, 'inherit')
    expect(failed.state).toBe('failed')
    expect(failed.detail).toContain('ECONNRESET')
    expect(failed.detail).not.toContain('Private proxy diagnostic')
    expect(f.seen).toHaveLength(0)
    const direct = await verifyPublicInference(f.operation, f.access, new AbortController().signal, 65536, 'direct')
    expect(direct.state).toBe('passed')
    expect(f.seen).toHaveLength(1)
    expect(globalThis.fetch).toBe(inherited)
    expect(inherited).toHaveBeenCalledOnce()
  } finally { inherited.mockRestore() }
})
