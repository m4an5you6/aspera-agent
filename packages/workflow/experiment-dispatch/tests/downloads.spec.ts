/** Real HTTP downloads exercise cursor continuation, private ticket consumption, and teardown. */
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { experimentIdSchema, serverIdSchema } from '@deepseek-ai/dsh-experiment-worker'
import { expect, it, onTestFinished, vi } from 'vitest'
import { ExperimentDownloads } from '../src/downloads.ts'
import type { ExperimentFleet } from '../src/fleet.ts'

async function fixture(read: ExperimentFleet['read']) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  const downloads = new ExperimentDownloads(ctx, { read } as ExperimentFleet, 60000)
  await vi.waitFor(() => { expect(ctx.webServer.port).toBeGreaterThan(0) })
  const url = await downloads.issue(experimentIdSchema.parse(randomUUID()), serverIdSchema.parse(randomUUID()), 'output.txt')
  return { ctx, url: `http://127.0.0.1:${ctx.webServer.port}${url}` }
}

it('streams bounded chunks in order and consumes each private ticket once', async () => {
  const bytes = Buffer.from('训练结果'.repeat(4096))
  const read = vi.fn<ExperimentFleet['read']>(async (_id, _kind, offset) => {
    const part = bytes.subarray(offset, offset + 1024)
    return { data: part.toString('base64'), generation: 'file-1', offset, nextOffset: offset + part.length, reset: false,
      eof: offset + part.length === bytes.length }
  })
  const f = await fixture(read)
  const response = await fetch(f.url)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  expect(read.mock.calls.slice(1).map(call => call[2])).toEqual(Array.from({ length: bytes.length / 1024 }, (_, index) => index * 1024))
  expect((await fetch(f.url)).status).toBe(404)
})

it('aborts the active remote read when its download connection closes', async () => {
  const started = Promise.withResolvers<AbortSignal>()
  const stopped = Promise.withResolvers<undefined>()
  const read: ExperimentFleet['read'] = async (_id, _kind, offset, _server, _path, _generation, signal) => {
    if (offset === 0) return { data: Buffer.from('first').toString('base64'), generation: 'one', offset, nextOffset: 5,
      eof: false, reset: false }
    return new Promise((_resolve, reject) => {
      if (signal === undefined) throw new Error('download read is missing its cancellation signal')
      signal.addEventListener('abort', () => { stopped.resolve(undefined); reject(new Error('download aborted')) }, { once: true })
      started.resolve(signal)
    })
  }
  const f = await fixture(read)
  const abort = new AbortController()
  const response = await fetch(f.url, { signal: abort.signal })
  const reading = response.arrayBuffer().catch((error: unknown) => error)
  const signal = await started.promise
  abort.abort()
  await stopped.promise
  await reading
  expect(signal.aborted).toBe(true)
})
