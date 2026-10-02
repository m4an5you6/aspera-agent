/** Actual loopback sockets exercise identity checks, parallel starts and joined cleanup. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { NetworkProbes, networkProofSchema } from '../src/network-probes.ts'

const owned: NetworkProbes[] = []
afterEach(async () => { await Promise.all(owned.splice(0).map(value => value.close())) })
function controller(lifetime = 30000) { const value = new NetworkProbes(lifetime, 1000); owned.push(value); return value }
it('deduplicates simultaneous listeners and verifies both directions without an allocation', async () => {
  const a = controller(); const b = controller(); const experimentId = randomUUID(); const serverId = randomUUID()
  const [first, retry] = await Promise.all([a.request('probe-network-start', { experimentId, serverId }), a.request('probe-network-start', { experimentId, serverId })])
  expect(first).toEqual(retry)
  const peer = await b.request('probe-network-start', { experimentId, serverId: randomUUID() })
  await expect(a.request('probe-network-connect', { experimentId, host: '127.0.0.1', proof: peer })).resolves.toEqual({ connected: true })
  await expect(b.request('probe-network-connect', { experimentId, host: '127.0.0.1', proof: first })).resolves.toEqual({ connected: true })
  await a.request('probe-network-stop', { experimentId })
  await expect(b.request('probe-network-connect', { experimentId, host: '127.0.0.1', proof: first })).rejects.toThrow()
})
it('refuses the wrong node, experiment or listener ownership', async () => {
  const a = controller(); const b = controller(); const experimentId = randomUUID(); const serverId = randomUUID()
  const proof = networkProofSchema.parse(await a.request('probe-network-start', { experimentId, serverId }))
  await expect(b.request('probe-network-connect', { experimentId, host: '127.0.0.1', proof: { ...proof, serverId: randomUUID() } })).rejects.toThrow('different node')
  await expect(b.request('probe-network-connect', { experimentId: randomUUID(), host: '127.0.0.1', proof })).rejects.toThrow('another experiment')
  await expect(a.request('probe-network-start', { experimentId, serverId: randomUUID() })).rejects.toThrow('identity conflicts')
})
it('expires abandoned listeners and joins shutdown racing with listener creation', async () => {
  const a = controller(25); const b = controller(); const experimentId = randomUUID()
  const proof = await a.request('probe-network-start', { experimentId, serverId: randomUUID() })
  await vi.waitFor(async () => { await expect(b.request('probe-network-connect', { experimentId, host: '127.0.0.1', proof })).rejects.toThrow() })
  const starting = a.request('probe-network-start', { experimentId, serverId: randomUUID() })
  await a.close()
  await starting
  await expect(a.request('probe-network-start', { experimentId, serverId: randomUUID() })).rejects.toThrow('stopping')
})
