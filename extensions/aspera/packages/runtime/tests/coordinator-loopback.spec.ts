/** Self-node operations use the pinned control identity without public SSH hairpinning. */
import { createServer } from 'node:http'
import type { Server, RequestListener } from 'node:http'
import { randomUUID } from 'node:crypto'
import { fromAny } from '@total-typescript/shoehorn'
import { afterEach, expect, it, vi } from 'vitest'
import { serverIdSchema } from '@aspera/experiments'
import { clusterNodeRequest } from '../src/cluster-runtime.ts'
import type { ClusterPrivate } from '../src/cluster-runtime.ts'
import { request } from '../src/transport.ts'
vi.mock('../src/transport.ts', () => ({ request: vi.fn(async () => ({ status: 200, value: { ssh: true } })) }))
const listeners: Server[] = []
afterEach(async () => {
  for (const server of listeners.splice(0)) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())) }
  vi.mocked(request).mockClear()
})
async function fixture(handler: RequestListener) {
  const server = createServer(handler); listeners.push(server)
  await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Listener did not bind')
  const id = serverIdSchema.parse(randomUUID()); const other = serverIdSchema.parse(randomUUID())
  const node = (id: typeof other) => ({ server: { id, host: 'public-fixture.invalid', sshPort: 30288, remotePort: address.port, name: 'node' } })
  const runtime = fromAny<ClusterPrivate, object>({ submission: { protocol: 4, experimentId: randomUUID(), coordinator: { id }, nodes: [node(id), node(other)] },
    connections: [id, other].map(serverId => ({ serverId, token: 'private-local-fixture-token', knownHostsFile: '/fixture/known-hosts' })), toolTimeoutMs: 10000 })
  return { runtime, id, other }
}
it('authenticates the coordinator by server id and leaves another node on SSH even with the same host', async () => {
  const seen: { url?: string; auth?: string; body: string }[] = []
  const f = await fixture((req, res) => {
    let body = ''; req.on('data', (chunk: Buffer) => { body += chunk.toString() }); req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body }); res.setHeader('content-type', 'application/json'); res.end('{"local":true}')
    })
  })
  expect(await clusterNodeRequest(f.runtime, f.id, 'allocate', { marker: 'test' })).toEqual({ local: true })
  expect(seen).toEqual([{ url: '/aspera/v4/node/allocate', auth: 'Bearer private-local-fixture-token', body: JSON.stringify({ marker: 'test', experimentId: f.runtime.submission.experimentId }) }])
  expect(request).not.toHaveBeenCalled()
  expect(await clusterNodeRequest(f.runtime, f.other, 'release')).toEqual({ ssh: true })
  expect(request).toHaveBeenCalledOnce()
})
it('cancels a waiting local request and preserves an explicit cleanup failure', async () => {
  const entered = Promise.withResolvers<void>()
  const f = await fixture((req, res) => {
    if (req.url?.endsWith('/release')) { res.statusCode = 409; res.end('{"error":"cleanup unconfirmed"}'); return }
    entered.resolve()
  })
  const abort = new AbortController()
  const pending = clusterNodeRequest(f.runtime, f.id, 'allocate', {}, abort.signal)
  const rejected = expect(pending).rejects.toThrow('fixture cancelled')
  await entered.promise; abort.abort(new Error('fixture cancelled')); await rejected
  await expect(clusterNodeRequest(f.runtime, f.id, 'release')).rejects.toThrow('cleanup unconfirmed')
})
