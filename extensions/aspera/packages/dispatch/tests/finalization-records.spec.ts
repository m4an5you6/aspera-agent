/** Finalization copies preserve remote errors, observation times and deletion ownership. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import { experimentIdSchema, serverIdSchema, experimentFinalizationStatusSchema } from '@aspera/experiments'
import type { FleetExperiment } from '../src/types.ts'
import { FinalizationRecords } from '../src/finalization-records.ts'

const roots: string[] = [], stores: FinalizationRecords[] = []
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts', 'finalization-copy-')); roots.push(root)
  const id = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const record = fromAny<FleetExperiment, object>({ request: { experimentId: id }, submission: { nodes: [{ server: { id: serverId } }] } })
  const observation = experimentFinalizationStatusSchema.parse({ version: 1, experimentId: id, supported: true, observedAt: 1234, offline: false, truncated: false, waits: [], stages: [] })
  let alive = true
  const read = vi.fn(async (_record: FleetExperiment, _signal: AbortSignal): Promise<unknown> => observation)
  const store = new FinalizationRecords(root, { get: () => record, alive: () => alive, read }); stores.push(store)
  return { id, root, record, read, store, observation, remove: () => { alive = false } }
}
it('serves a dated offline copy without replacing its original observation time', async () => {
  const f = fixture(); expect(await f.store.read(f.id)).toMatchObject({ observedAt: 1234, offline: false })
  f.read.mockRejectedValue(new Error('ECONNREFUSED'))
  expect(await f.store.read(f.id)).toMatchObject({ observedAt: 1234, offline: true, error: expect.stringContaining('ECONNREFUSED') })
  expect(f.store.cached(f.id)).toMatchObject({ offline: false })
})
it('shares one in-flight read and refuses a source belonging to another experiment', async () => {
  const f = fixture(), release = Promise.withResolvers<unknown>()
  f.read.mockReturnValue(release.promise)
  const first = f.store.read(f.id), second = f.store.read(f.id)
  expect(first).toBe(second)
  release.resolve({ ...f.observation, experimentId: randomUUID() })
  await expect(first).rejects.toThrow('ownership changed'); expect(f.read).toHaveBeenCalledOnce()
})
it('waits for deletion and ignores a late reply instead of recreating the archive', async () => {
  const f = fixture(), release = Promise.withResolvers<unknown>(); f.read.mockReturnValue(release.promise)
  const work = f.store.read(f.id), rejected = expect(work).rejects.toThrow('deleted')
  f.remove(); const deleting = f.store.forget(f.id); release.resolve(f.observation)
  await rejected; await deleting
  expect(existsSync(resolve(f.root, f.id, 'finalization.v1.json'))).toBe(false)
})
it('restores a local observation after Host restart and surfaces a failed write', async () => {
  const f = fixture(); await f.store.read(f.id)
  const restarted = new FinalizationRecords(f.root, { get: () => f.record, alive: () => true, read: async () => { throw new Error('offline') } }); stores.push(restarted)
  expect(await restarted.read(f.id)).toMatchObject({ observedAt: 1234, offline: true })
  const other = fixture(); mkdirSync(resolve(other.root, other.id, 'finalization.v1.json'), { recursive: true })
  await expect(other.store.read(other.id)).rejects.toThrow()
})
