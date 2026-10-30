/** A pending exclusive command prevents empty-log-driven model polling without losing cancellation. */
import { randomUUID } from 'node:crypto'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import type { CommandWait } from '@aspera/experiments'
import { commandObservationSchema, waitExperimentCommand } from '../src/command-wait.ts'
import { finalizationPolicySchema } from '../src/finalization-policy.ts'
import { CommandAdmissionRejected } from '../src/command-admission.ts'

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
it('returns an identity-bound pre-launch refusal without a status polling timeout', async () => {
  const f = fixture(), requestHash = 'a'.repeat(64)
  f.submit.mockRejectedValue(new CommandAdmissionRejected({ version: 1, formatVersion: '0.1.3', experimentId: f.options.experimentId,
    serverId: f.options.serverId, commandId: 'train', requestHash, state: 'rejected', processState: 'not-started', checkedAt: Date.now(), detail: 'storage registration changed' }))
  expect(await waitExperimentCommand({ ...f.options, requestHash })).toMatchObject({ state: 'rejected', detail: 'storage registration changed', elapsedMs: 0 })
  expect(f.read).not.toHaveBeenCalled()
})
it('retains the original refusal separately from failed reads and never resets a recovered deadline', async () => {
  const f = fixture(); f.submit.mockRejectedValue(new Error('original ambiguous response')); f.read.mockRejectedValue(new Error('read offline'))
  const first = waitExperimentCommand(f.options); await vi.advanceTimersByTimeAsync(60000)
  const prior = await first
  expect(prior).toMatchObject({ state: 'unknown', submitError: 'Error: original ambiguous response', observationError: 'Error: read offline', reconnectDeadlineAt: 1060000 })
  f.submit.mockClear(); f.read.mockClear()
  const restarted = await waitExperimentCommand({ ...f.options, prior })
  expect(restarted).toMatchObject({ state: 'unknown', reconnectDeadlineAt: prior.reconnectDeadlineAt })
  expect(f.submit).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledOnce()
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

it('does not turn a refused different command into the previous command success', async () => {
  const f = fixture(), requestHash = 'b'.repeat(64)
  f.submit.mockRejectedValue(new Error('command id is bound to different content or purpose'))
  f.read.mockResolvedValue({ ...f.status, requestHash: 'a'.repeat(64), result: { ...f.status.result, state: 'completed', exitCode: 0, released: true } })
  const result = await waitExperimentCommand({ ...f.options, requestHash, purpose: 'run' })
  expect(result).toMatchObject({ state: 'rejected', detail: expect.stringContaining('different content or purpose') })
  expect(result.result).toBeUndefined()
})

it('preserves the original wait journal when a retry changes command content', async () => {
  const f = fixture(), prior = { version: 1 as const, ...f.options, state: 'unknown' as const, requestHash: 'a'.repeat(64), checkedAt: Date.now(), elapsedMs: 0 }
  await expect(waitExperimentCommand({ ...f.options, prior, requestHash: 'b'.repeat(64) })).rejects.toThrow('different content')
  expect(f.submit).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled(); expect(f.records).toEqual([])
})

it('checks purpose even when command bytes match and no wait journal exists', async () => {
  const f = fixture(), requestHash = 'a'.repeat(64)
  f.read.mockResolvedValue({ ...f.status, requestHash, result: { ...f.status.result, purpose: 'diagnostic', state: 'completed', exitCode: 0, released: true } })
  const result = await waitExperimentCommand({ ...f.options, requestHash, purpose: 'run' })
  expect(result).toMatchObject({ state: 'rejected' }); expect(result.result).toBeUndefined()
})

it('retains the original identity for read-only waits after reconnecting', async () => {
  const f = fixture(), requestHash = 'a'.repeat(64)
  const prior = { version: 1 as const, experimentId: f.options.experimentId, serverId: f.options.serverId, commandId: 'train',
    state: 'unknown' as const, startedAt: Date.now(), checkedAt: Date.now(), elapsedMs: 0, requestHash, purpose: 'run' as const }
  f.read.mockResolvedValue({ ...f.status, requestHash, result: { ...f.status.result, state: 'completed', exitCode: 0, released: true } })
  expect(await waitExperimentCommand({ ...f.options, submit: undefined, prior })).toMatchObject({ state: 'settled', requestHash, purpose: 'run' })
  expect(f.submit).not.toHaveBeenCalled()
})

it('does not accept a cached successful exit when current identity cannot be read', async () => {
  const f = fixture(), requestHash = 'a'.repeat(64)
  const prior = { version: 1 as const, experimentId: f.options.experimentId, serverId: f.options.serverId, commandId: 'train',
    state: 'settled' as const, startedAt: Date.now(), checkedAt: Date.now(), elapsedMs: 0, requestHash,
    result: { ...f.status.result, state: 'completed' as const, exitCode: 0, released: true } }
  f.read.mockRejectedValue(new Error('offline'))
  const work = waitExperimentCommand({ ...f.options, prior, requestHash })
  await vi.advanceTimersByTimeAsync(60000)
  expect(await work).toMatchObject({ state: 'unknown' })
})

it('recovers a matching launch with independently observed command content', async () => {
  const f = fixture(), requestHash = 'a'.repeat(64)
  f.submit.mockRejectedValue(new Error('lost reply'))
  f.read.mockResolvedValue({ ...f.status, requestHash, result: { ...f.status.result, state: 'completed', exitCode: 0, released: true } })
  expect(await waitExperimentCommand({ ...f.options, requestHash, purpose: 'run' })).toMatchObject({ state: 'settled', requestHash })
  expect(f.submit).toHaveBeenCalledOnce()
})

it('does not accept a legacy observation lacking command content proof for a new request', async () => {
  const f = fixture()
  Object.assign(f.status.result, { state: 'completed', exitCode: 0, released: true })
  expect(await waitExperimentCommand({ ...f.options, requestHash: 'a'.repeat(64) })).toMatchObject({ state: 'unknown', detail: expect.stringContaining('identity is unavailable') })
})
