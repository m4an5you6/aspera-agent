/** Native badges accept a count, never unvalidated renderer commands or paths. */
import { expect, it } from 'vitest'
import { attentionCountSchema, attentionArtwork } from '../src/attention.ts'

it('clears at zero and caps display at 99+ without capping the underlying count', () => {
  expect([0, 1, 99, 100, 2000].map(count => attentionArtwork(attentionCountSchema.parse(count)))).toEqual(['', '1', '99', '99+', '99+'])
})

it('rejects negative, fractional, nonfinite and nonnumeric IPC payloads', () => {
  for (const count of [-1, 0.5, NaN, Infinity, '12', {}, Number.MAX_SAFE_INTEGER + 1]) expect(attentionCountSchema.safeParse(count).success).toBe(false)
})
