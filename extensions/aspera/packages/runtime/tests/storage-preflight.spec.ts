/** Automatic confirmation preserves semantic retention requirements, regardless of estimated bytes. */
import { describe, expect, it } from 'vitest'
import { experimentStoragePolicySchema, storagePolicyPreserves, planInputSchema, prepareExperimentEnvironmentSchema } from '@aspera/experiments'

const policy = experimentStoragePolicySchema.parse({ artifact: 'adapter', checkpointCount: 2, optimizerState: true, schedulerState: true,
  recoveryPoints: ['checkpoint-30', 'checkpoint-230'], outputMinimumBytes: 100, checkpointMinimumBytes: 200, basis: 'Approved two-stage recovery' })

describe('storage retention confirmation', () => {
  it('rejects content reductions even when an Agent supplies a smaller byte estimate', () => {
    for (const change of [{ checkpointCount: 1 }, { optimizerState: false }, { schedulerState: false }, { recoveryPoints: ['checkpoint-230'] }, { outputMinimumBytes: 99 }, { artifact: 'full-model' as const }]) {
      expect(storagePolicyPreserves(policy, { ...policy, ...change })).toBe(false)
    }
    expect(storagePolicyPreserves(policy, { ...policy, checkpointCount: 3, basis: 'A more precise explanation does not remove retained contents' })).toBe(true)
  })

  it('retains approved policy through planning and exposes readonly verification without a repair plan', () => {
    const plan = planInputSchema.parse({ summary: 'Storage validation', steps: ['Verify source'], frameworks: [], storagePolicy: policy })
    expect(plan.storagePolicy).toEqual(policy)
    expect(prepareExperimentEnvironmentSchema.parse({ environmentId: 'training', operationId: '10000000-0000-4000-8000-000000000001', action: 'verify-reuse' }).action).toBe('verify-reuse')
  })
})
