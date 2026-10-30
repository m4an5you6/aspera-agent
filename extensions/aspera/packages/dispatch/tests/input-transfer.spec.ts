/** Submitted inputs are reused by content identity, never by size or an earlier upload result. */
import { expect, it, vi } from 'vitest'
import { fromPartial } from '@total-typescript/shoehorn'
import { transferExperimentInput } from '../src/input-transfer.ts'
import type { StoragePlacement, ClusterSubmission } from '@aspera/experiments'
import type { Target } from '../src/transport.ts'

const placement = fromPartial<StoragePlacement>({ runRoot: '/volume/server/runs/experiment' })
const target = fromPartial<Target>({ toolTimeoutMs: 7200000 })
const file = fromPartial<ClusterSubmission['inputs'][number] & { size: number }>({ name: 'package.whl', sha256: 'a'.repeat(64), size: 123 })

it('preserves already uploaded inputs only after full identity verification', async () => {
  const driver = { remote: vi.fn<typeof import('../src/transport.ts').remote>(async () => '{"complete":true}'), copy: vi.fn(async () => '') }
  await transferExperimentInput(driver, target, placement, '/local/package.whl', file, new AbortController().signal)
  expect(driver.copy).not.toHaveBeenCalled()
  expect(JSON.parse(driver.remote.mock.calls[0]![4]!)).toMatchObject({ name: 'package.whl', size: 123, sha256: file.sha256 })
})

it('replaces an incomplete input and verifies it before allowing handover', async () => {
  const driver = { remote: vi.fn().mockResolvedValueOnce('{"complete":false}').mockResolvedValueOnce('{"complete":true}'), copy: vi.fn(async () => '') }
  const signal = new AbortController().signal
  await transferExperimentInput(driver, target, placement, '/local/package.whl', file, signal, 'private-fixture')
  expect(driver.copy).toHaveBeenCalledWith(target, '/local/package.whl', '/volume/server/runs/experiment/inputs/package.whl', signal, 'private-fixture')
  expect(driver.remote).toHaveBeenCalledTimes(2)
})

it('rejects content mismatch, unsafe remote paths and transport failure without replay', async () => {
  const driver = { remote: vi.fn(async () => '{"complete":false}'), copy: vi.fn(async () => '') }
  await expect(transferExperimentInput(driver, target, placement, '/local/package.whl', file, new AbortController().signal)).rejects.toThrow('submitted digest')
  driver.remote.mockRejectedValueOnce(new Error('Input owner differs'))
  const before = driver.copy.mock.calls.length
  await expect(transferExperimentInput(driver, target, placement, '/local/package.whl', file, new AbortController().signal)).rejects.toThrow('owner differs')
  expect(driver.copy).toHaveBeenCalledTimes(before)
  driver.remote.mockResolvedValueOnce('{"complete":false}'); driver.copy.mockRejectedValueOnce(new Error('Connection reset'))
  await expect(transferExperimentInput(driver, target, placement, '/local/package.whl', file, new AbortController().signal)).rejects.toThrow('Connection reset')
  expect(driver.copy).toHaveBeenCalledTimes(before + 1)
})
