/** Material tools retain the original acquisition until independently confirmed exit. */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { materialOperationSchema } from '@aspera/experiments'
import { prepareMaterialAndWait } from '../src/material-operation.ts'
import { managedEnvironmentPolicySchema } from '../src/managed-environment.ts'
import { ClusterNodeOperationError } from '../src/cluster-runtime.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000000) })
afterEach(() => { vi.useRealTimers() })
function fixture() {
  const value = materialOperationSchema.parse({ version: 1, experimentId: randomUUID(), serverId: randomUUID(), operationId: randomUUID(),
    materialId: 'a'.repeat(64), requestHash: 'b'.repeat(64), startedAt: Date.now(), deadline: Date.now() + 7200000, updatedAt: Date.now(),
    state: 'running', downloadedBytes: 1024, reusedBytes: 2048, exitConfirmed: false, admissionReleased: false })
  const submit = vi.fn(async () => value), read = vi.fn(async (_signal: AbortSignal): Promise<unknown> => value)
  const abort = new AbortController()
  const options = { experimentId: value.experimentId, serverId: value.serverId, operationId: value.operationId,
    materialId: value.materialId,
    policy: managedEnvironmentPolicySchema.parse({}), signal: abort.signal, submit, read }
  return { value, options, submit, read, abort }
}
it('waits through download completion until process exit and admission release without another submission', async () => {
  const f = fixture(), next = vi.fn()
  const work = prepareMaterialAndWait(f.options).then(value => { next(); return value })
  await vi.advanceTimersByTimeAsync(120000)
  f.value.state = 'completed'; f.value.exitConfirmed = true
  await vi.advanceTimersByTimeAsync(1000); expect(next).not.toHaveBeenCalled()
  f.value.admissionReleased = true
  await vi.advanceTimersByTimeAsync(1000)
  expect(await work).toMatchObject({ state: 'completed', reusedBytes: 2048 }); expect(f.submit).toHaveBeenCalledOnce()
})
it('recovers a lost response by querying the original operation and retaining its deadline', async () => {
  const f = fixture()
  f.submit.mockRejectedValueOnce(new Error('lost response')); f.read.mockRejectedValueOnce(new Error('offline'))
  const work = prepareMaterialAndWait(f.options)
  await vi.advanceTimersByTimeAsync(2000)
  Object.assign(f.value, { state: 'blocked', detail: 'digest mismatch', exitConfirmed: true, admissionReleased: true, exitCode: 1 })
  await vi.advanceTimersByTimeAsync(1000)
  expect(await work).toMatchObject({ state: 'blocked', detail: 'digest mismatch', deadline: 8200000 }); expect(f.submit).toHaveBeenCalledOnce()
})
it('returns an authenticated request rejection without polling a nonexistent replacement operation', async () => {
  const f = fixture()
  f.submit.mockRejectedValueOnce(new ClusterNodeOperationError(400, 'Equivalent material verification already exists; recover original operation'))
  await expect(prepareMaterialAndWait(f.options)).rejects.toThrow('Equivalent material verification')
  expect(f.read).not.toHaveBeenCalled()
})
it('returns a confirmed settlement failure immediately instead of misreporting a verification timeout', async () => {
  const f = fixture()
  Object.assign(f.value, { state: 'completed', exitConfirmed: true, settlementError: 'Original material receipt could not be committed' })
  const result = await prepareMaterialAndWait(f.options)
  expect(result).toMatchObject({ state: 'unknown', detail: expect.stringContaining('receipt could not be committed'),
    last: { state: 'completed', admissionReleased: false, deadline: 8200000 } })
  expect(f.read).toHaveBeenCalledOnce(); expect(f.submit).toHaveBeenCalledOnce()
})
it('does not accept a different node or invent counters when connection recovery fails', async () => {
  const f = fixture(); f.read.mockResolvedValueOnce({ ...f.value, serverId: randomUUID() })
  expect(await prepareMaterialAndWait(f.options)).toMatchObject({ state: 'unknown', serverId: f.value.serverId })
  f.read.mockRejectedValue(new Error('offline'))
  const work = prepareMaterialAndWait(f.options); await vi.advanceTimersByTimeAsync(60000)
  const result = await work
  expect(result).toMatchObject({ state: 'unknown', operationId: f.value.operationId })
  expect(result).not.toHaveProperty('downloadedBytes'); expect(result).not.toHaveProperty('last')
})
it('propagates cancellation to the pending read without releasing remote admission', async () => {
  const f = fixture(); let signal: AbortSignal | undefined
  f.read.mockImplementation(async input => { signal = input; return f.value })
  const work = prepareMaterialAndWait(f.options)
  const rejected = expect(work).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(1000); f.abort.abort(new Error('cancelled'))
  await rejected; expect(signal?.aborted).toBe(true); expect(f.value.admissionReleased).toBe(false)
})

it('rejects a later response that changes the original acquisition deadline', async () => {
  const f = fixture()
  const work = prepareMaterialAndWait(f.options)
  await vi.advanceTimersByTimeAsync(1000)
  f.value = { ...f.value, deadline: f.value.deadline + 1000 }
  f.read.mockResolvedValue(f.value)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await work).toMatchObject({ state: 'unknown', detail: expect.stringContaining('deadline changed') })
  expect(f.submit).toHaveBeenCalledOnce()
})
