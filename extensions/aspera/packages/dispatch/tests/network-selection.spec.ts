/** Directional transport failures verify that preparation never accepts a partial network. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { clusterNodeSchema, experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { inventory, placement } from '../../experiments/tests/fixtures.ts'
import { resolveTrainingNetwork } from '../src/network-selection.ts'
import type { NetworkParticipant } from '../src/network-selection.ts'
import { request } from '../src/transport.ts'

vi.mock('../src/transport.ts', () => ({ request: vi.fn() }))
afterEach(() => { vi.resetAllMocks() })

function fixture() {
  const id = experimentIdSchema.parse(randomUUID())
  const peers = ['node-a', 'node-b'].map((name, index): NetworkParticipant => {
    const serverId = serverIdSchema.parse(randomUUID())
    const node = clusterNodeSchema.parse({ server: { id: serverId, name, host: name, username: 'trainer', sshPort: 22,
      remotePort: 43019, remoteRoot: '/control', authMode: 'password', storagePlacement: placement(serverId, id, '/control') },
    devicePaths: ['/dev/nvidia0'], backendPath: '/usr/bin/bwrap', hiddenPaths: [], gpuInfo: 'CPU fixture' })
    return { node, inventory: { ...inventory(), addresses: [
      { interface: 'eth0', address: `10.0.0.${index + 1}`, family: 'IPv4', private: true },
      { interface: 'eth1', address: `192.168.0.${index + 1}`, family: 'IPv4', private: true },
    ] }, token: 'x'.repeat(32), target: { ...node.server, localRepo: '/release', dataRoots: [], allowedSystemPackages: [],
      agentCredentialRefs: [], tokenRef: 'token', toolTimeoutMs: 1000, controlPollIntervalMs: 100 } }
  })
  vi.mocked(request).mockImplementation(async (target, _token, path, _method, raw) => {
    if (path.endsWith('/probe-network-start')) return { status: 200, value: {
      experimentId: id, serverId: peers.find(peer => peer.target.host === target.host)!.node.server.id, nonce: randomUUID(), port: 32123,
    } }
    if (path.endsWith('/probe-network-connect')) {
      const { host } = z.object({ host: z.string() }).parse(raw)
      if (host.startsWith('10.')) return { status: 503, value: { error: 'unreachable interface' } }
      return { status: 200, value: { connected: true } }
    }
    return { status: 200, value: { stopped: true } }
  })
  return { id, peers, abort: new AbortController() }
}

it('needs no internal address or listener for a single node', async () => {
  const f = fixture()
  await expect(resolveTrainingNetwork(f.id, [f.peers[0]!], f.abort.signal)).resolves.toEqual([f.peers[0]!.node])
  expect(request).not.toHaveBeenCalled()
})

it('tries multiple interfaces and verifies the chosen address from every other node', async () => {
  const f = fixture()
  const selected = await resolveTrainingNetwork(f.id, f.peers, f.abort.signal)
  expect(selected.map(node => node.server.trainingAddress)).toEqual(['192.168.0.1', '192.168.0.2'])
  expect(vi.mocked(request).mock.calls.filter(call => call[2].endsWith('connect'))).toHaveLength(4)
  expect(vi.mocked(request).mock.calls.filter(call => call[2].endsWith('stop'))).toHaveLength(2)
})

it('reports the failing manual node and cleans both listeners when only one direction works', async () => {
  const f = fixture()
  f.peers[0]!.node.server.trainingAddress = '192.168.0.1'
  f.peers[1]!.node.server.trainingAddress = '10.0.0.2'
  await expect(resolveTrainingNetwork(f.id, f.peers, f.abort.signal)).rejects.toThrow('node-b')
  expect(vi.mocked(request).mock.calls.filter(call => call[2].endsWith('stop'))).toHaveLength(2)
})

it('cleans a possibly started listener after a cancelled or lost start response', async () => {
  const f = fixture()
  vi.mocked(request).mockImplementationOnce(async () => { f.abort.abort(); throw new Error('start reply lost') })
  await expect(resolveTrainingNetwork(f.id, f.peers, f.abort.signal)).rejects.toThrow('start reply lost')
  const cleanup = vi.mocked(request).mock.calls.find(call => call[2].endsWith('stop'))
  expect(cleanup?.[0].host).toBe('node-a')
  expect(cleanup?.[5]).toBeUndefined()
})

it('rejects a start response belonging to a different receiver before testing addresses', async () => {
  const f = fixture()
  vi.mocked(request).mockResolvedValueOnce({ status: 200, value: { experimentId: f.id, serverId: randomUUID(), nonce: randomUUID(), port: 32123 } })
  await expect(resolveTrainingNetwork(f.id, f.peers, f.abort.signal)).rejects.toThrow()
  expect(vi.mocked(request).mock.calls.some(call => call[2].endsWith('connect'))).toBe(false)
  expect(vi.mocked(request).mock.calls.some(call => call[2].endsWith('stop'))).toBe(true)
})

it('requires a positive connectivity result and preserves a verified manual hostname', async () => {
  const f = fixture()
  f.peers[0]!.node.server.trainingAddress = 'training-a.internal'
  const original = vi.mocked(request).getMockImplementation()!
  vi.mocked(request).mockImplementation(async (...args) => args[2].endsWith('connect') && args[0].host === 'node-a'
    ? { status: 200, value: { connected: false } } : original(...args))
  await expect(resolveTrainingNetwork(f.id, f.peers, f.abort.signal)).rejects.toThrow('node-b')
  vi.mocked(request).mockImplementation(original)
  const nodes = await resolveTrainingNetwork(f.id, f.peers, f.abort.signal)
  expect(nodes[0]?.server.trainingAddress).toBe('training-a.internal')
})
