/** A pending exclusive command prevents empty-log-driven model polling without losing cancellation. */
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import type { CommandWait } from '@aspera/experiments'
import { commandObservationSchema, waitExperimentCommand } from '../src/command-wait.ts'
import { finalizationPolicySchema } from '../src/finalization-policy.ts'

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000000) })
afterEach(() => { vi.useRealTimers() })
function fixture() {
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID()), signal = new AbortController()
  const status = commandObservationSchema.parse({ experimentId, serverId, result: { commandId: 'train', state: 'running', exitCode: null, released: false }, checkedAt: Date.now() })
  const submit = vi.fn(async () => status.result), read = vi.fn(async (_signal: AbortSignal): Promise<unknown> => structuredClone(status))
  const records: CommandWait[] = []
  return { status, signal, read, submit, records, options: { experimentId, serverId, commandId: 'train', startedAt: Date.now(),
    signal: signal.signal, policy: finalizationPolicySchema.parse({}), submit, read, save: (row: CommandWait) => { records.push(row) } } }
}
it('does not release the next model action during a two-minute command with no output', async () => {
  const f = fixture(), nextModelRequest = vi.fn()
  const work = waitExperimentCommand(f.options).then(value => { nextModelRequest(); return value })
  await vi.advanceTimersByTimeAsync(120000)
  expect(nextModelRequest).not.toHaveBeenCalled(); expect(f.submit).toHaveBeenCalledOnce()
  Object.assign(f.status.result, { state: 'completed', exitCode: 0 })
  await vi.advanceTimersByTimeAsync(1000); expect(nextModelRequest).not.toHaveBeenCalled()
  f.status.result.released = true; await vi.advanceTimersByTimeAsync(1000)
  expect(await work).toMatchObject({ state: 'settled', elapsedMs: 122000, result: { exitCode: 0, released: true } })
  expect(nextModelRequest).toHaveBeenCalledOnce()
})
it('recovers a lost launch response by reading the same command without submitting it twice', async () => {
  const f = fixture(); f.submit.mockRejectedValueOnce(new Error('lost launch reply')); f.read.mockRejectedValueOnce(new Error('reset'))
  const work = waitExperimentCommand(f.options); await vi.advanceTimersByTimeAsync(3000)
  Object.assign(f.status.result, { state: 'failed', exitCode: 7, released: true }); await vi.advanceTimersByTimeAsync(1000)
  expect(await work).toMatchObject({ state: 'settled', result: { state: 'failed', exitCode: 7 } }); expect(f.submit).toHaveBeenCalledOnce()
})
it('keeps the outcome unresolved after bounded connection recovery', async () => {
  const f = fixture(); f.read.mockRejectedValue(new Error('offline'))
  const work = waitExperimentCommand(f.options); await vi.advanceTimersByTimeAsync(60000)
  expect(await work).toMatchObject({ state: 'unknown', detail: expect.stringContaining('original command') })
  expect(f.submit).toHaveBeenCalledOnce()
})
it('rejects a different allocation identity even if the command name matches', async () => {
  const f = fixture(); f.status.serverId = serverIdSchema.parse(randomUUID())
  expect(await waitExperimentCommand(f.options)).toMatchObject({ state: 'unknown', detail: expect.stringContaining('another experiment') })
})
it('cancels in-flight observation without claiming that the remote process stopped', async () => {
  const f = fixture(); f.read.mockImplementation(signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true }) }))
  const work = waitExperimentCommand(f.options), assertion = expect(work).rejects.toThrow('stop waiting')
  await vi.advanceTimersByTimeAsync(0); f.signal.abort(new Error('stop waiting')); await assertion
  expect(f.records.at(-1)).toMatchObject({ state: 'cancelled', detail: expect.stringContaining('does not confirm') })
})
