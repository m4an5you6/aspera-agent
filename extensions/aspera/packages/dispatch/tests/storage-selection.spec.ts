/** Agent termination and cancellation cannot leave local storage preparation waiting forever. */
import { randomUUID } from 'node:crypto'
import { fromAny } from '@total-typescript/shoehorn'
import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { experimentIdSchema, serverIdSchema, serverSettingsSchema } from '@aspera/experiments'
import { inventory } from '../../experiments/tests/fixtures.ts'
import { StorageSelection, refreshStorageSelection } from '../src/storage-selection.ts'

function fixture() {
  let interval = Promise.resolve(); let work = async () => {}
  const followup = vi.fn(() => { interval = work() }); const append = vi.fn(); const inject = vi.fn(); const cancel = vi.fn()
  const agent = fromAny<Agent, object>({ followup, inject, cancel, whenIdle: () => interval, status: 'idle', session: { append } })
  const observation = { server: serverSettingsSchema.parse({ id: randomUUID(), name: 'node', host: 'node', username: 'trainer',
    sshPort: 22, remotePort: 43019, authMode: 'password', storagePreference: { mode: 'auto' } }), inventory: inventory('/data') }
  const id = experimentIdSchema.parse(randomUUID()); const abort = new AbortController()
  const tools = new Map<string, { name: string; execute: (args: Record<string, string>) => Promise<string> }>()
  const ctx = fromAny<Context, object>({ effect: (body: () => unknown) => body(), on: () => () => {},
    tools: { restrict: () => {}, register: (tool: { name: string; execute: (args: Record<string, string>) => Promise<string> }) => {
      tools.set(tool.name, tool); return () => {}
    } } })
  const call = (name: string, args: Record<string, string> = {}) => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error('Storage fixture tool is missing')
    return tool.execute({ server_id: observation.server.id, ...args })
  }
  return { agent, observation, id, abort, followup, append, inject, cancel, ctx, call,
    loop: (body: () => Promise<void>) => { work = body } }
}

it('reports an incomplete choice when the model ends its turn without selecting storage', async () => {
  const f = fixture()
  await expect(new StorageSelection().run(f.agent, f.id, 'a'.repeat(64), [f.observation], 1024, f.abort.signal)).rejects.toThrow('did not select every server')
  expect(JSON.stringify(f.followup.mock.calls)).toContain('prepare-experiment-storage')
})

it('logs explicit storage decisions and never calls a model for manual settings', async () => {
  const f = fixture(); f.observation.server.storagePreference = { mode: 'manual', directory: '/data' }
  const saved = await new StorageSelection().run(f.agent, f.id, 'a'.repeat(64), [f.observation], 1024, f.abort.signal)
  expect(saved.placements[0]?.candidate.directory).toBe('/data')
  expect(saved.inventories[0]?.inventory).toEqual(f.observation.inventory)
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.append).not.toHaveBeenCalled()
  expect(JSON.stringify(f.inject.mock.calls)).toContain('Explicit server storage setting')
})

it('returns the placement and its refreshed selection inventory together after disk cleanup', async () => {
  const f = fixture()
  f.observation.inventory.candidates[0]!.availableBytes = 15_331_328
  const fresh = structuredClone(f.observation.inventory)
  fresh.observedAt = 2; fresh.candidates[0]!.availableBytes = 3_285_319_680
  const storage = new StorageSelection(async () => ({ inventory: fresh, history: { complete: true } }))
  storage.install(f.ctx, f.agent)
  f.loop(async () => {
    await f.call('inspect_server_storage')
    await f.call('select_experiment_storage', { candidate_id: fresh.candidates[0]!.id, reason: 'Observed space after cleanup' })
  })
  const saved = await storage.run(f.agent, f.id, 'a'.repeat(64), [f.observation], 1024 ** 3, f.abort.signal)
  expect(saved.inventories[0]?.inventory.observedAt).toBe(2)
  expect(saved.placements[0]?.candidate).toEqual(saved.inventories[0]?.inventory.candidates[0])
  expect(saved.placements[0]?.candidate.availableBytes).toBe(3_285_319_680)
})

it('keeps the matching selection snapshot when later inspection observes another free-space value', async () => {
  const f = fixture(); const first = structuredClone(f.observation.inventory); first.observedAt = 2
  const later = structuredClone(first); later.observedAt = 3; later.candidates[0]!.availableBytes -= 4096
  const provider = vi.fn().mockResolvedValueOnce({ inventory: first, history: {} }).mockResolvedValueOnce({ inventory: later, history: {} })
  const storage = new StorageSelection(provider); storage.install(f.ctx, f.agent)
  f.loop(async () => {
    await f.call('inspect_server_storage')
    await f.call('select_experiment_storage', { candidate_id: first.candidates[0]!.id, reason: 'Selected current observed disk' })
    await f.call('inspect_server_storage')
  })
  const saved = await storage.run(f.agent, f.id, 'a'.repeat(64), [f.observation], 1024, f.abort.signal)
  expect(saved.inventories[0]?.inventory).toEqual(first)
  expect(saved.placements[0]?.candidate).toEqual(first.candidates[0])
})

it('cancels the scoped preparation Agent when its experiment is cancelled', async () => {
  const f = fixture(); f.followup.mockImplementation(() => { f.abort.abort() })
  await expect(new StorageSelection().run(f.agent, f.id, 'a'.repeat(64), [f.observation], 1024, f.abort.signal)).rejects.toThrow()
  expect(f.cancel).toHaveBeenCalledWith({ kind: 'user' })
})

function retryFixture() {
  const f = fixture(); f.observation.server.storagePreference = { mode: 'manual', directory: '/data' }
  const fresh = structuredClone(f.observation.inventory); fresh.observedAt = 3
  const setup = new StorageSelection()
  return { ...f, fresh, input: async () => {
    const saved = await setup.run(f.agent, f.id, 'a'.repeat(64), [f.observation], 1024 ** 3, f.abort.signal)
    saved.inventories[0]!.inventory.candidates[0]!.availableBytes = 15_331_328
    saved.placements[0]!.candidate.availableBytes = 3_285_319_680
    fresh.candidates[0]!.availableBytes = 3_100_000_000
    return { id: f.id, digest: 'a'.repeat(64), servers: [f.observation.server], saved, signal: f.abort.signal,
      inspect: vi.fn(async () => structuredClone(fresh)) }
  } }
}

it('refreshes an unsubmitted fixed placement without changing its directory or release', async () => {
  const f = retryFixture(); const input = await f.input(); const original = structuredClone(input.saved)
  const result = await refreshStorageSelection(input)
  expect(result.placements[0]).toEqual({ ...original.placements[0], candidate: f.fresh.candidates[0] })
  expect(result.inventories[0]?.inventory).toEqual(f.fresh)
  expect(input.saved).toEqual(original)
})

it.each(['candidate-id', 'directory', 'mount-source', 'mount-device', 'mount-root', 'mount-uuid', 'system-volume'] as const)(
  'rejects a changed %s when refreshing fixed storage', async field => {
    const f = retryFixture(); const input = await f.input(); const candidate = f.fresh.candidates[0]!
    switch (field) {
      case 'candidate-id': candidate.id = inventory('/other').candidates[0]!.id; break
      case 'directory': candidate.directory = '/other'; break
      case 'mount-source': candidate.mount.source = '/dev/replaced'; break
      case 'mount-device': candidate.mount.device = '8:2'; break
      case 'mount-root': candidate.mount.root = '/other'; break
      case 'mount-uuid': candidate.mount.uuid = 'replaced-volume'; break
      case 'system-volume': candidate.systemVolume = true; break
    }
    const original = structuredClone(input.saved)
    await expect(refreshStorageSelection(input)).rejects.toThrow('Storage identity changed')
    expect(input.saved).toEqual(original)
  })

it.each(['capacity', 'read-only', 'ephemeral'] as const)('retains the %s check on storage retry', async field => {
  const f = retryFixture(); const input = await f.input(); const candidate = f.fresh.candidates[0]!
  if (field === 'capacity') candidate.availableBytes = 15_331_328
  if (field === 'read-only') candidate.writable = false
  if (field === 'ephemeral') candidate.persistence = 'ephemeral'
  await expect(refreshStorageSelection(input)).rejects.toThrow('unavailable or has insufficient space')
})

it.each(['experiment', 'release', 'node', 'missing-inventory', 'saved-volume', 'directory-owner', 'namespace'] as const)(
  'rejects mismatched %s evidence before refreshing a fixed selection', async field => {
    const f = retryFixture(); const input = await f.input(); const placement = input.saved.placements[0]!
    switch (field) {
      case 'experiment': placement.experimentId = experimentIdSchema.parse(randomUUID()); break
      case 'release': input.digest = 'b'.repeat(64); break
      case 'node': input.servers = []; break
      case 'missing-inventory': input.saved.inventories = []; break
      case 'saved-volume': input.saved.inventories[0]!.inventory.candidates[0]!.mount.source = '/dev/other'; break
      case 'directory-owner': placement.controlRoot = '/other'; break
      case 'namespace': placement.namespaceRoot = '/other'; break
    }
    await expect(refreshStorageSelection(input)).rejects.toThrow()
  })

it('does not publish a partial refresh when another selected node cannot be read', async () => {
  const f = retryFixture(); const input = await f.input(); const other = structuredClone(input.servers[0]!)
  other.id = serverIdSchema.parse(randomUUID())
  const placement = structuredClone(input.saved.placements[0]!); placement.serverId = other.id
  input.servers.push(other); input.saved.placements.push(placement)
  input.saved.inventories.push({ serverId: other.id, inventory: structuredClone(input.saved.inventories[0]!.inventory) })
  input.inspect.mockResolvedValueOnce(f.fresh).mockRejectedValueOnce(new Error('SSH unavailable'))
  const original = structuredClone(input.saved)
  await expect(refreshStorageSelection(input)).rejects.toThrow('SSH unavailable')
  expect(input.saved).toEqual(original)
})

it('does not commit a fresh selection after cancellation during inspection', async () => {
  const f = retryFixture(); const input = await f.input(); const original = structuredClone(input.saved)
  input.inspect.mockImplementationOnce(async () => { f.abort.abort(); return f.fresh })
  await expect(refreshStorageSelection(input)).rejects.toThrow()
  expect(input.saved).toEqual(original)
})
