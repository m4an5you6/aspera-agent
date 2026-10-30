/** Documentation deadlines include body reads and preserve complete snapshots. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { experimentIdSchema } from '@aspera/experiments'
import { SessionId } from '@deepseek-ai/dsh-session'
import { FrameworkDocumentation, resolveDocumentationPolicy } from '../src/framework-documentation.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(fetcher: typeof fetch, timeout = 1000) {
  const base = resolve('.artifacts'); mkdirSync(base, { recursive: true })
  const root = mkdtempSync(resolve(base, 'documentation-')); roots.push(root)
  const owner = { experimentId: experimentIdSchema.parse(randomUUID()), deploymentId: 'a'.repeat(64), sessionId: SessionId('planning') }
  const policy = { documentationReadTimeoutMs: timeout, documentationPageBytes: 1024, documentationBytes: 16384, documentationHosts: ['docs.example.com'] }
  return { root, owner, policy, docs: new FrameworkDocumentation(root, owner, policy, fetcher) }
}

it('uses the experiment snapshot when a reused coordinator has different profile defaults', () => {
  const saved = { documentationReadTimeoutMs: 5000, documentationPageBytes: 4096 }
  expect(resolveDocumentationPolicy(saved, { documentationReadTimeoutMs: 300000, documentationPageBytes: 65536 })).toEqual(saved)
  expect(resolveDocumentationPolicy(undefined, {})).toEqual({ documentationReadTimeoutMs: 30000, documentationPageBytes: 8192 })
})

it('cancels a stalled body, returns the original failure without automatic retry and permits an explicit retry', async () => {
  let calls = 0, cancelled = false
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')) }, cancel() { cancelled = true } })
  const { docs } = fixture(async () => { calls++; return new Response(calls === 1 ? body : 'repaired source') }, 20)
  const result = await docs.read({ url: 'https://docs.example.com/v1/file' }, new AbortController().signal)
  expect(result.state).toBe('failed'); expect(result.error?.kind).toBe('timeout'); expect(result.receivedBytes).toBe(7)
  expect(cancelled).toBe(true); expect(result.complete).toBe(false)
  const same = await docs.read({ url: 'https://docs.example.com/v1/file' }, new AbortController().signal)
  expect(same.requestId).toBe(result.requestId); expect(calls).toBe(1)
  expect(same.cached).toBe(true); expect(result.cached).toBe(false)
  const retried = await docs.read({ url: 'https://docs.example.com/v1/file', retry: true }, new AbortController().signal)
  expect(retried.state).toBe('complete'); expect(retried.text).toBe('repaired source'); expect(calls).toBe(2)
})

it('uses one persisted policy after reopening and cancels before response headers without leaving a request', async () => {
  let requests = 0, active = 0
  const fetcher: typeof fetch = async (_url, init) => {
    requests++; active++
    try { return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true })) }
    finally { active-- }
  }
  const { docs, root, owner, policy } = fixture(fetcher, 20)
  const first = await docs.read({ url: 'https://docs.example.com/headers' }, new AbortController().signal)
  expect(first.error?.kind).toBe('timeout'); expect(active).toBe(0)
  const reopened = new FrameworkDocumentation(root, owner, { ...policy, documentationReadTimeoutMs: 300000 }, fetcher)
  const same = await reopened.read({ url: 'https://docs.example.com/headers' }, new AbortController().signal)
  expect(same.requestId).toBe(first.requestId); expect(requests).toBe(1)
  const next = await reopened.read({ url: 'https://docs.example.com/headers', retry: true }, new AbortController().signal)
  expect(next.error?.kind).toBe('timeout'); expect(active).toBe(0); expect(requests).toBe(2)
})

it('reports caller cancellation and oversized content without a complete snapshot', async () => {
  const cancellation = new AbortController()
  const { docs } = fixture(async (_url, init) => {
    queueMicrotask(() => cancellation.abort(new Error('operator stopped')))
    return await new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true }))
  })
  expect((await docs.read({ url: 'https://docs.example.com/cancel' }, cancellation.signal)).error?.kind).toBe('cancelled')
  const oversized = fixture(async () => new Response('x'.repeat(20000)))
  const result = await oversized.docs.read({ url: 'https://docs.example.com/huge' }, new AbortController().signal)
  expect(result.error?.kind).toBe('too-large'); expect(result.complete).toBe(false); expect(result.snapshotId).toBeUndefined()
})

it('deduplicates an in-flight request and pages the same immutable Unicode body after a refresh', async () => {
  let calls = 0
  const old = 'fixed😀内容\n'.repeat(400)
  const { docs, root, owner, policy } = fixture(async () => { calls++; return new Response(calls === 1 ? old : 'new content') })
  const signal = new AbortController().signal
  const [first, merged] = await Promise.all([docs.read({ url: 'https://docs.example.com/v1/file' }, signal), docs.read({ url: 'https://docs.example.com/v1/file' }, signal)])
  expect(calls).toBe(1); expect(first.snapshotId).toBe(merged.snapshotId)
  expect(Buffer.byteLength(first.text ?? '')).toBeLessThanOrEqual(1024)
  const refreshed = await docs.read({ url: 'https://docs.example.com/v1/file', refresh: true }, signal)
  expect(calls).toBe(2); expect(refreshed.snapshotId).not.toBe(first.snapshotId)
  const reopened = new FrameworkDocumentation(root, owner, policy, async () => { throw new Error('must use saved content') })
  let text = first.text ?? '', cursor = first.next
  while (cursor !== undefined) { const page = await reopened.read(cursor, signal); text += page.text ?? ''; cursor = page.next }
  expect(text).toBe(old)
  expect((await reopened.read({ url: 'https://docs.example.com/v1/file' }, signal)).text).toBe('new content')
})

it('preserves source identity, refuses foreign cursors and never follows a redirect', async () => {
  const { docs } = fixture(async () => new Response('', { status: 302, headers: { location: 'https://private.invalid/' } }))
  const signal = new AbortController().signal
  expect((await docs.read({ url: 'https://docs.example.com/file' }, signal)).error?.kind).toBe('http')
  await expect(docs.read({ url: 'http://docs.example.com/file' }, signal)).rejects.toThrow('documentation')
  await expect(docs.read({ url: 'https://user:password@docs.example.com/file' }, signal)).rejects.toThrow('documentation')
  await expect(docs.read({ url: 'https://docs.example.com/file', snapshotId: 'f'.repeat(64), offset: 0 }, signal)).rejects.toThrow()
})

it('closes real HTTP requests stalled before headers or during the body', async () => {
  const closed: Promise<void>[] = []
  const server = createServer((request, response) => {
    closed.push(new Promise<void>(done => { response.once('close', done) }))
    if (request.url === '/body') response.write('partial body')
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Expected allocated TCP address')
  const { docs } = fixture(async (url, init) => fetch(`http://127.0.0.1:${address.port}${new URL(String(url)).pathname}`, init), 1000)
  try {
    for (const path of ['headers', 'body']) {
      const result = await docs.read({ url: 'https://docs.example.com/' + path }, new AbortController().signal)
      expect(result.error?.kind).toBe('timeout'); expect(result.complete).toBe(false)
    }
    await Promise.all(closed); expect(closed).toHaveLength(2)
  } finally { server.closeAllConnections(); await new Promise<void>((done, reject) => { server.close(error => { if (error) reject(error); else done() }) }) }
})
