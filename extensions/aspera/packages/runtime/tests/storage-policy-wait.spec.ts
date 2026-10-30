/** Human confirmation stays inside one tool call and preserves the original proposal. */
import { describe, expect, it, vi, afterEach } from 'vitest'
import { storagePolicyRecordSchema } from '@aspera/experiments'
import { waitForStoragePolicy } from '../src/storage-policy-wait.ts'
import { managedEnvironmentPolicySchema } from '../src/managed-environment.ts'

const proposal = storagePolicyRecordSchema.parse({ version: 1, experimentId: '10000000-0000-4000-8000-000000000001', serverId: '10000000-0000-4000-8000-000000000002',
  proposalId: '10000000-0000-4000-8000-000000000003', planRevision: 1, expectedRevision: 1, revision: 1, requestHash: 'a'.repeat(64),
  state: 'pending', createdAt: 1, updatedAt: 1, reason: 'One recovery file', policy: { artifact: 'adapter', checkpointCount: 1,
    optimizerState: true, schedulerState: true, recoveryPoints: [], outputMinimumBytes: 0, checkpointMinimumBytes: 0, basis: 'Original plan' } })
afterEach(() => { vi.useRealTimers() })
describe('retention decision waiting', () => {
  it('keeps one call pending through transient reads until the operator approves', async () => {
    vi.useFakeTimers()
    const read = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(proposal)
      .mockResolvedValue({ ...proposal, state: 'approved', revision: 2 })
    let returned = false
    const waiting = waitForStoragePolicy({ proposal, policy: managedEnvironmentPolicySchema.parse({ operationPollIntervalMs: 100 }), signal: new AbortController().signal, read })
      .then(value => { returned = true; return value })
    await vi.advanceTimersByTimeAsync(200)
    expect(returned).toBe(false)
    await vi.advanceTimersByTimeAsync(100)
    expect((await waiting).state).toBe('approved')
    expect(read).toHaveBeenCalledTimes(3)
  })
  it('rejects a decision for a replaced proposal', async () => {
    vi.useFakeTimers()
    const waiting = waitForStoragePolicy({ proposal, policy: managedEnvironmentPolicySchema.parse({ operationPollIntervalMs: 100 }),
      signal: new AbortController().signal, read: async () => ({ ...proposal, requestHash: 'b'.repeat(64) }) })
    const rejected = expect(waiting).rejects.toThrow('identity changed')
    await vi.advanceTimersByTimeAsync(100); await rejected
  })
  it('cancels confirmation without submitting or approving another proposal', async () => {
    const controller = new AbortController(), read = vi.fn()
    const waiting = waitForStoragePolicy({ proposal, policy: managedEnvironmentPolicySchema.parse({}), signal: controller.signal, read })
    controller.abort(new Error('Experiment interrupted'))
    await expect(waiting).rejects.toThrow('aborted')
    expect(read).not.toHaveBeenCalled()
  })
})
