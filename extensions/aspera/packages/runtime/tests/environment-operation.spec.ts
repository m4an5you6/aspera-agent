/** The exclusive installer tool waits through receipt publication, exit verification and bounded reconnects. */
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { environmentOperationStatusSchema } from '@aspera/experiments'
import { prepareEnvironmentAndWait } from '../src/environment-operation.ts'
import { managedEnvironmentPolicySchema } from '../src/managed-environment.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000000) })
afterEach(() => { vi.useRealTimers() })
function fixture() {
  const experimentId = randomUUID(); const serverId = randomUUID(); const operationId = randomUUID(); const startedAt = Date.now()
  const status = environmentOperationStatusSchema.parse({ experimentId, serverId, operationId, state: 'running',
    operation: { version: 1, experimentId, serverId, operationId, environmentId: 'training', requestHash: 'a'.repeat(64), action: 'create',
      state: 'running', commandId: 'environment-' + operationId, startedAt, updatedAt: startedAt, exitConfirmed: false, exitCode: null },
    runtime: { version: 1, experimentId, serverId, operationId, environmentId: 'training', deploymentId: 'b'.repeat(64),
      startedAt, deadline: startedAt + 1800000, updatedAt: startedAt, exitConfirmed: false, exitCode: null, admissionReleased: false },
    checkedAt: startedAt, elapsedMs: 0, processState: 'running', admissionReleased: false })
  const submit = vi.fn(async () => status.operation)
  const read = vi.fn(async (_signal: AbortSignal): Promise<unknown> => status)
  const controller = new AbortController()
  const options = { experimentId: status.experimentId, serverId: status.serverId, operationId: status.operationId,
    signal: controller.signal, policy: managedEnvironmentPolicySchema.parse({}), transport: { submit, read } }
  const finish = (failed = false) => {
    status.state = failed ? 'failed' : 'completed'; status.processState = 'exited'; status.admissionReleased = true
    Object.assign(status.operation!, { state: failed ? 'blocked' : 'completed', exitConfirmed: true, exitCode: failed ? 1 : 0 })
    Object.assign(status.runtime!, { exitConfirmed: true, exitCode: failed ? 1 : 0, admissionReleased: true, updatedAt: Date.now() })
    status.elapsedMs = Date.now() - startedAt
  }
  return { options, submit, read, status, controller, finish }
}
it('holds the next serial action for two minutes and waits past the installer receipt until process exit', async () => {
  const f = fixture(); const next = vi.fn()
  const work = prepareEnvironmentAndWait(f.options).then(result => { next(); return result })
  await vi.advanceTimersByTimeAsync(120000)
  expect(next).not.toHaveBeenCalled(); expect(f.submit).toHaveBeenCalledTimes(1)
  Object.assign(f.status.operation!, { state: 'completed', exitConfirmed: true, exitCode: 0 })
  await vi.advanceTimersByTimeAsync(2000); expect(next).not.toHaveBeenCalled()
  f.finish(); await vi.advanceTimersByTimeAsync(1000)
  expect((await work).state).toBe('completed'); expect(next).toHaveBeenCalledOnce()
})
it('returns a confirmed failure with its real elapsed time', async () => {
  const f = fixture(); const work = prepareEnvironmentAndWait(f.options)
  await vi.advanceTimersByTimeAsync(130000); f.finish(true); f.status.detail = 'defusedxml tag rejected'
  await vi.advanceTimersByTimeAsync(1000)
  expect(await work).toMatchObject({ state: 'failed', detail: 'defusedxml tag rejected', elapsedMs: 130000 })
})
it('reconnects a lost submission reply by reading the same operation without resubmission', async () => {
  const f = fixture(); f.submit.mockRejectedValueOnce(new Error('lost reply'))
  f.read.mockRejectedValueOnce(new Error('connection reset')).mockRejectedValueOnce(new Error('offline'))
  const work = prepareEnvironmentAndWait(f.options)
  await vi.advanceTimersByTimeAsync(3000); f.finish(); await vi.advanceTimersByTimeAsync(1000)
  expect((await work).state).toBe('completed'); expect(f.submit).toHaveBeenCalledTimes(1)
  expect(f.status.runtime!.deadline).toBe(2800000)
})
it('returns unresolved after the connection recovery budget without releasing admission', async () => {
  const f = fixture(); f.read.mockRejectedValue(new Error('offline'))
  const work = prepareEnvironmentAndWait(f.options)
  await vi.advanceTimersByTimeAsync(60000)
  expect(await work).toMatchObject({ state: 'unknown', admissionReleased: false, detail: expect.stringContaining('recovery budget') })
  expect(f.submit).toHaveBeenCalledOnce()
})
it('retains protection when the persisted deadline and stop grace expire', async () => {
  const f = fixture(); f.status.runtime!.deadline = Date.now() - 31000
  expect(await prepareEnvironmentAndWait(f.options)).toMatchObject({ state: 'unknown', admissionReleased: false })
})
it('refuses a final receipt without exit or admission proof and cross-operation replies', async () => {
  const f = fixture(); f.status.state = 'completed'
  expect((await prepareEnvironmentAndWait(f.options)).state).toBe('unknown')
  f.finish(); f.status.operationId = environmentOperationStatusSchema.shape.operationId.parse(randomUUID())
  expect((await prepareEnvironmentAndWait(f.options)).detail).toContain('another experiment')
})
it('propagates cancellation into an in-flight read and starts no replacement operation', async () => {
  const f = fixture()
  f.read.mockImplementation(signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true }) }))
  const work = prepareEnvironmentAndWait(f.options)
  const assertion = expect(work).rejects.toThrow('cancelled')
  await vi.advanceTimersByTimeAsync(0); f.controller.abort(new Error('cancelled')); await assertion
  expect(f.submit).toHaveBeenCalledOnce()
})
it('refuses mismatched receipt identity even when the outer status names the requested operation', async () => {
  const f = fixture(); f.finish(); f.status.operation!.operationId = environmentOperationStatusSchema.shape.operationId.parse(randomUUID())
  expect(await prepareEnvironmentAndWait(f.options)).toMatchObject({ state: 'unknown', detail: expect.stringContaining('evidence belongs to another') })
})
