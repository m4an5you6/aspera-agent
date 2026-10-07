/** Missing measurements and Agent status flags cannot create overview progress. */
import { expect, it } from 'vitest'
import { overviewMetrics, overviewSummary } from '../src/client/overview-data.ts'

it('keeps only three known measurements and preserves a measured zero without inventing missing fields', () => {
  expect(overviewMetrics({ gpu_probe_completed: 1, formal_training_completed: 0 })).toEqual([])
  expect(overviewMetrics({ step: 0, total_steps: 2000, loss: 1.82, throughput: 70, tokens_per_second: 80, internal_count: 11 })).toEqual([
    { label: 'trainingSteps', value: 0, total: 2000 }, { label: 'trainingLoss', value: 1.82 }, { label: 'trainingTokenRate', value: 80 },
  ])
})

it('does not estimate training completion from an absent, invalid or exceeded total', () => {
  const invalidTotals: Record<string, number>[] = [{ step: 3 }, { step: 3, total_steps: 0 }, { step: 3, total_steps: -10 },
    { step: 3, total_steps: 2 }, { step: 1.5, total_steps: 10 }]
  for (const metrics of invalidTotals) expect(overviewMetrics(metrics)[0]).not.toHaveProperty('total')
  expect(overviewMetrics({ step: -1, throughput: -1 })).toEqual([])
})

it('keeps long diagnostics out of the work summary while preserving the first recorded reason', () => {
  expect(overviewSummary('  Dependency unavailable\r\nFull command diagnostics  ')).toBe('Dependency unavailable')
  const retained = 'A long command failure '.repeat(100)
  expect(overviewSummary(retained).length).toBe(180)
  expect(overviewSummary(retained)).toMatch(/^A long command failure /)
  expect(overviewSummary(retained)).toMatch(/…$/)
})
