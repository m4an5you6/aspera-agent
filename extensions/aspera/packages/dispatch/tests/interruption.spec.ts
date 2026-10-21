/** Interruption journals own background attempts, recovery and deletion independently of page lifetime. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import type { FleetExperiment } from '../src/types.ts'
import { ExperimentInterruptions } from '../src/interruption.ts'
import type { InterruptionOwner } from '../src/interruption.ts'

const roots: string[] = []
const services: ExperimentInterruptions[] = []
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts', 'interruption-')); roots.push(root)
  const id = experimentIdSchema.parse(randomUUID())
  const serverId = serverIdSchema.parse(randomUUID())
  let alive = true
  const record = fromAny<FleetExperiment, object>({ request: { experimentId: id, objective: 'Original objective' },
    servers: [{ id: serverId, name: 'CPU fixture' }] })
  const owner: InterruptionOwner = { get: requested => { if (requested !== id || !alive) throw new Error('Experiment not found'); return record },
    alive: requested => requested === id && alive, settle: vi.fn(async () => undefined), accept: vi.fn(async () => {}), changed: vi.fn(), report: vi.fn() }
  const make = (directory = root) => { const service = new ExperimentInterruptions(directory, owner, () => 1000); services.push(service); return service }
  return { root, id, serverId, record, owner, make, remove: () => { alive = false } }
}

it('persists intent before one background attempt and shares repeated requests', async () => {
  const f = fixture(); let finish = () => {}
  f.owner.settle = vi.fn(async () => { await new Promise<void>(resolveDone => { finish = resolveDone }); return undefined })
  const service = f.make(); const first = service.request(f.id)
  expect(first.phase).toBe('requested'); expect(first.stopRequested).toBe(true)
  expect(JSON.parse(readFileSync(resolve(f.root, `${f.id}.v1.json`), 'utf8')).operationId).toBe(first.operationId)
  expect(service.request(f.id).operationId).toBe(first.operationId)
  await vi.waitFor(() => { expect(f.owner.settle).toHaveBeenCalledOnce() })
  finish(); await service.wait(f.id)
  expect(service.status(f.id)?.phase).toBe('released'); expect(f.owner.accept).toHaveBeenCalledOnce()
  expect(service.request(f.id).operationId).toBe(first.operationId); expect(f.owner.settle).toHaveBeenCalledOnce()
})
it('status reads return isolated copies without triggering transport or repair', async () => {
  const f = fixture(); const service = f.make(); service.request(f.id); await service.wait(f.id)
  const first = service.status(f.id)!; first.nodes[0]!.phase = 'blocked'
  expect(service.status(f.id)?.nodes[0]?.phase).toBe('released'); expect(f.owner.settle).toHaveBeenCalledOnce()
})
it('retains a blocked operation and retries its identity without inventing a result', async () => {
  const f = fixture(); f.owner.settle = vi.fn(async () => { throw new Error('Original command exit is unconfirmed') })
  const service = f.make(); const first = service.request(f.id); await service.wait(f.id)
  expect(service.status(f.id)).toMatchObject({ phase: 'blocked', detail: expect.stringContaining('unconfirmed') })
  expect(f.owner.accept).not.toHaveBeenCalled()
  f.owner.settle = vi.fn(async () => undefined)
  expect(service.request(f.id).operationId).toBe(first.operationId); await service.wait(f.id)
  expect(service.status(f.id)?.phase).toBe('released')
})
it('automatic recovery carries no permission to stop active processes', async () => {
  const f = fixture(); f.owner.settle = vi.fn(async (_record, status) => { expect(status.stopRequested).toBe(false); throw new Error('Agent is still active') })
  const service = f.make(); const result = await service.recover(f.id, new AbortController().signal)
  expect(result).toMatchObject({ reason: 'controller-recovery', stopRequested: false, phase: 'blocked' })
  expect(f.owner.accept).not.toHaveBeenCalled()
})
it('allows explicit user interruption to reuse a blocked recovery operation', async () => {
  const f = fixture(); f.owner.settle = vi.fn(async () => { throw new Error('Active task retained') })
  const service = f.make(); const prior = await service.recover(f.id, new AbortController().signal)
  f.owner.settle = vi.fn(async (_record, status) => { expect(status.stopRequested).toBe(true); return undefined })
  expect(service.request(f.id).operationId).toBe(prior.operationId); await service.wait(f.id)
  expect(service.status(f.id)?.phase).toBe('released')
})

it('does not acknowledge a conflicting stop intent while exit verification is still running', async () => {
  const f = fixture(); const gate = Promise.withResolvers<void>()
  f.owner.settle = vi.fn(async () => { await gate.promise; return undefined })
  const service = f.make(); const first = service.reconcile(f.id)
  try {
    await vi.waitFor(() => { expect(f.owner.settle).toHaveBeenCalledOnce() })
    expect(() => service.request(f.id)).toThrow('verification is already running')
    expect(service.status(f.id)).toMatchObject({ operationId: first.operationId, stopRequested: false })
  } finally { gate.resolve(); await service.wait(f.id) }
})
it('refuses another submission under a retained operation identity', async () => {
  const f = fixture(); const service = f.make(); service.request(f.id); await service.wait(f.id)
  f.record.request.objective = 'Changed objective'
  expect(() => service.request(f.id)).toThrow('submission identity changed')
})
it('recovers a crash journal with its original operation identity', async () => {
  const f = fixture(); const firstService = f.make(); const first = firstService.request(f.id); await firstService.wait(f.id)
  const crashed = resolve(f.root, 'crashed'); mkdirSync(crashed)
  writeFileSync(resolve(crashed, `${f.id}.v1.json`), JSON.stringify(first))
  const resumed = f.make(crashed); resumed.resume(); await resumed.wait(f.id)
  expect(resumed.status(f.id)).toMatchObject({ operationId: first.operationId, phase: 'released' })
})
it('waits for cancellation and rejects late writes after deletion', async () => {
  const f = fixture(); f.owner.settle = vi.fn(async (_record, _status, signal) => {
    await new Promise<void>((_resolveDone, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true }) })
    return undefined
  })
  const service = f.make(); service.request(f.id); await vi.waitFor(() => { expect(f.owner.settle).toHaveBeenCalledOnce() })
  f.remove(); await service.forget(f.id)
  expect(service.status(f.id)).toBeUndefined(); expect(existsSync(resolve(f.root, `${f.id}.v1.json`))).toBe(false)
  expect(f.owner.accept).not.toHaveBeenCalled()
})
it('restores exit verification after Host shutdown using the same operation identity', async () => {
  const f = fixture(); f.owner.settle = vi.fn(async (_record, _status, signal) => {
    await new Promise<void>((_resolveDone, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true }) }); return undefined
  })
  const service = f.make(); const first = service.request(f.id); await vi.waitFor(() => { expect(f.owner.settle).toHaveBeenCalledOnce() })
  await service.close()
  const restored = f.make()
  expect(restored.status(f.id)).toMatchObject({ operationId: first.operationId, phase: 'blocked', resumeVerification: true })
  f.owner.settle = vi.fn(async () => undefined); restored.resume(); await restored.wait(f.id)
  expect(restored.status(f.id)).toMatchObject({ operationId: first.operationId, phase: 'released' })
})
it('does not start remote work when intent cannot be written', () => {
  const f = fixture(); const path = resolve(f.root, 'not-a-directory'); const service = f.make(path); writeFileSync(path, 'occupied')
  expect(() => service.request(f.id)).toThrow(); expect(f.owner.settle).not.toHaveBeenCalled()
})

it('records unselected-node blockers without any remote stop and permits explicit manual recovery', async () => {
  const f = fixture(); const service = f.make()
  const blocked = service.observeBlocked(f.id, 'Original task includes an unselected node')
  expect(blocked).toMatchObject({ reason: 'controller-recovery', stopRequested: false, phase: 'blocked' })
  expect(f.owner.settle).not.toHaveBeenCalled()
  expect(service.request(f.id).operationId).toBe(blocked.operationId)
  await service.wait(f.id)
  expect(service.status(f.id)).toMatchObject({ stopRequested: true, phase: 'released' })
  expect(service.observeBlocked(f.id, 'A late probe failed').phase).toBe('released')
})

it('stops activity on a journal write failure and retains the committed intent for restart', async () => {
  const f = fixture(); const path = resolve(f.root, `${f.id}.v1.json`)
  let saved = ''
  f.owner.settle = vi.fn(async () => {
    saved = readFileSync(path, 'utf8'); rmSync(path); mkdirSync(path)
    throw new Error('Remote exit evidence is incomplete')
  })
  const service = f.make(); const first = service.request(f.id); await service.wait(f.id)
  expect(service.status(f.id)).toMatchObject({ phase: 'blocked', detail: expect.stringContaining('journal could not be written') })
  expect(f.owner.report).toHaveBeenCalledOnce()
  rmSync(path, { recursive: true }); writeFileSync(path, saved)
  f.owner.settle = vi.fn(async () => undefined)
  const restored = f.make(); restored.resume(); await restored.wait(f.id)
  expect(restored.status(f.id)).toMatchObject({ phase: 'released', operationId: first.operationId })
})

it('rejects a persisted receipt with a foreign submission or missing original node', async () => {
  const f = fixture(); const service = f.make(); service.request(f.id); await service.wait(f.id)
  const path = resolve(f.root, `${f.id}.v1.json`)
  const original = JSON.parse(readFileSync(path, 'utf8'))
  writeFileSync(path, JSON.stringify({ ...original, submissionHash: 'b'.repeat(64) }))
  expect(() => f.make()).toThrow('original submission or nodes')
  writeFileSync(path, JSON.stringify({ ...original, nodes: [] }))
  expect(() => f.make()).toThrow()
})
