/** Agent termination and cancellation cannot leave local storage preparation waiting forever. */
import { randomUUID } from 'node:crypto'
import { fromAny } from '@total-typescript/shoehorn'
import { expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { experimentIdSchema, serverSettingsSchema } from '@aspera/experiments'
import { inventory } from '../../experiments/tests/fixtures.ts'
import { StorageSelection } from '../src/storage-selection.ts'

function fixture() {
  const followup = vi.fn(); const append = vi.fn(); const inject = vi.fn(); const cancel = vi.fn()
  const agent = fromAny<Agent, object>({ followup, inject, cancel, whenIdle: async () => {}, status: 'idle', session: { append } })
  const observation = { server: serverSettingsSchema.parse({ id: randomUUID(), name: 'node', host: 'node', username: 'trainer',
    sshPort: 22, remotePort: 43019, authMode: 'password', storagePreference: { mode: 'auto' } }), inventory: inventory('/data') }
  const id = experimentIdSchema.parse(randomUUID()); const abort = new AbortController()
  return { agent, observation, id, abort, followup, append, inject, cancel }
}

it('reports an incomplete choice when the model ends its turn without selecting storage', async () => {
  const f = fixture()
  await expect(new StorageSelection().run(f.agent, f.id, 'a'.repeat(64), [f.observation], 1024, f.abort.signal)).rejects.toThrow('did not select every server')
  expect(JSON.stringify(f.followup.mock.calls)).toContain('prepare-experiment-storage')
})

it('logs explicit storage decisions and never calls a model for manual settings', async () => {
  const f = fixture(); f.observation.server.storagePreference = { mode: 'manual', directory: '/data' }
  const saved = await new StorageSelection().run(f.agent, f.id, 'a'.repeat(64), [f.observation], 1024, f.abort.signal)
  expect(saved[0]?.candidate.directory).toBe('/data')
  expect(f.followup).not.toHaveBeenCalled()
  expect(f.append).not.toHaveBeenCalled()
  expect(JSON.stringify(f.inject.mock.calls)).toContain('Explicit server storage setting')
})

it('cancels the scoped preparation Agent when its experiment is cancelled', async () => {
  const f = fixture(); f.followup.mockImplementation(() => { f.abort.abort() })
  await expect(new StorageSelection().run(f.agent, f.id, 'a'.repeat(64), [f.observation], 1024, f.abort.signal)).rejects.toThrow()
  expect(f.cancel).toHaveBeenCalledWith({ kind: 'user' })
})
