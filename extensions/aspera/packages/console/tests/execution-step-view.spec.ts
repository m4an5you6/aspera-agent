/** Display excerpts preserve approved requirements and literal failure evidence. */
import { expect, it } from 'vitest'
import { stepTitle, stepExcerpt, displayedStepReports } from '../src/client/execution-step-view.ts'

it('extracts a heading without changing the full approved requirement', () => {
  const original = '步骤1 环境与资产勘察（只读）：调用 inspect_experiment_environment，记录 GPU UUID\n保留所有证据'
  expect(stepTitle(original)).toBe('环境与资产勘察（只读）')
  expect(original).toContain('保留所有证据')
  expect(stepTitle('Step 18: Confirm artifacts')).toBe('Confirm artifacts')
  expect(stepTitle('### 验收结果；完整要求')).toBe('验收结果')
  expect(stepTitle('02：模型数据固定与空间预算')).toBe('模型数据固定与空间预算')
  expect(stepTitle('步骤1环境勘察：完整要求')).toBe('环境勘察')
  expect(stepTitle('### Step 18: Confirm artifacts')).toBe('Confirm artifacts')
})

it('bounds long headings and retains a literal error in the result excerpt', () => {
  expect(stepTitle('A'.repeat(500))).toHaveLength(65)
  expect(stepExcerpt('TimeoutError:\n  The operation was aborted')).toBe('TimeoutError: The operation was aborted')
  expect(stepExcerpt('x'.repeat(200))).toHaveLength(161)
})

it('matches reports by approved step number and excludes stale extra steps from counts', () => {
  const reports = displayedStepReports([{ step: 3, state: 'completed', updatedAt: 1 }, { step: 2, state: 'blocked', updatedAt: 1 },
    { step: 1, state: 'completed', updatedAt: 1 }], 2, [{ step: 2, state: 'completed', detail: 'Existing evidence verified', recordedAt: 2, callId: 'review', sources: [] }])
  expect(reports.size).toBe(2); expect([...reports.values()].filter(step => step.state === 'completed')).toHaveLength(2)
  expect(reports.get(2)).toMatchObject({ detail: 'Existing evidence verified', updatedAt: 2 })
})
