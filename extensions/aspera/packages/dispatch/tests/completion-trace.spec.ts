/** Review pages use the original persisted Session and close every read handle. */
import { randomUUID } from 'node:crypto'
import { fromAny } from '@total-typescript/shoehorn'
import { expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence, SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import { experimentIdSchema } from '@aspera/experiments'
import type { CompletionReview } from '@aspera/experiments'
import { readCompletionTrace } from '../src/completion-trace.ts'

function fixture(metadataCount = true) {
  const id = experimentIdSchema.parse(randomUUID()), sessionId = 'review-' + randomUUID()
  const review = fromAny<CompletionReview, object>({ experimentId: id, sessionId })
  const events = Array.from({ length: 150 }, (_, seq) => fromAny<SessionEvent, object>({ seq, time: seq + 1000,
    type: 'assistant/message', data: { message: { content: [{ type: 'text', text: JSON.stringify({ max_steps: 57, hub_token: null }) }] } } }))
  const read = vi.fn(async (start = 0, length = events.length) => ({ events: events.slice(start, start + length), eventState: 'owned' as const }))
  const close = vi.fn(async () => {})
  const handle = fromAny<SessionHandle, object>({ read, close })
  const persistence = fromAny<Pick<SessionPersistence, 'stat' | 'open'>, object>({ stat: vi.fn(async () => metadataCount ? { eventCount: events.length } : {}), open: vi.fn(async () => handle) })
  return { id, review, events, read, close, persistence }
}
it('reads bounded original pages including large Unicode events without scanning a supplementary copy', async () => {
  const f = fixture()
  f.events[145] = fromAny<SessionEvent, object>({ ...f.events[145], data: { text: '核验'.repeat(40000), password: 'private-password' } })
  const page = await readCompletionTrace(f.persistence, f.review, { experimentId: f.id, phase: 'execution', limit: 50 }, ['private-password'])
  expect(page?.records).toHaveLength(50); expect(page?.records[0]?.seq).toBe(100)
  expect(f.read).toHaveBeenCalledExactlyOnceWith(100, 51); expect(f.close).toHaveBeenCalledOnce()
  expect(JSON.parse(page!.records.find(row => row.seq === 145)!.data)).toEqual({ text: '核验'.repeat(40000), password: '[redacted]' })
  const older = await readCompletionTrace(f.persistence, f.review, { experimentId: f.id, phase: 'execution', beforeSeq: 100, limit: 50 }, [])
  expect(older?.records.map(row => row.seq)).toEqual(Array.from({ length: 50 }, (_, index) => index + 50))
  const current = await readCompletionTrace(f.persistence, f.review, { experimentId: f.id, phase: 'execution', cursor: page!.cursor, limit: 50 }, [])
  expect(current?.records).toEqual([]); expect(current?.cursor?.nextSeq).toBe(150)
})
it('refuses an unrelated Session cursor before opening persistence', async () => {
  const f = fixture()
  await expect(readCompletionTrace(f.persistence, f.review, { experimentId: f.id, phase: 'execution', cursor: {
    experimentId: f.id, phase: 'execution', sessionId: 'other-session', nextSeq: 0 } }, [])).rejects.toThrow('another operation')
  expect(f.persistence.open).not.toHaveBeenCalled()
})
it('returns the latest review events when persistence metadata omits the optional event count', async () => {
  const f = fixture(false)
  f.events[149] = fromAny<SessionEvent, object>({ seq: 149, time: 1149, type: 'goal/change', data: { goal: { id: 'retained-review-goal', phase: 'complete' } } })
  const page = await readCompletionTrace(f.persistence, f.review, { experimentId: f.id, phase: 'execution', limit: 50 }, [])
  expect(page?.records[0]?.seq).toBe(100)
  expect(JSON.parse(page!.records.at(-1)!.data).goal.phase).toBe('complete')
  expect(page?.hasMore).toBe(true); expect(page?.cursor?.nextSeq).toBe(150)
  expect(f.read.mock.calls.every(call => call[1] === 1 || call[1] === 51)).toBe(true)
  expect(f.read.mock.calls.length).toBeLessThan(25)
  expect(f.close).toHaveBeenCalledOnce()
})
it.each([0, 1, 50])('reads a count-free Session containing %s events without inventing older pages', async count => {
  const f = fixture(false); f.events.splice(count)
  const page = await readCompletionTrace(f.persistence, f.review, { experimentId: f.id, phase: 'execution', limit: 50 }, [])
  expect(page?.records).toHaveLength(count)
  expect(page?.cursor?.nextSeq).toBe(count); expect(page?.hasMore).toBe(false)
  expect(f.close).toHaveBeenCalledOnce()
})
it('uses a continuation cursor directly when count metadata is unavailable', async () => {
  const f = fixture(false)
  const page = await readCompletionTrace(f.persistence, f.review, { experimentId: f.id, phase: 'execution', limit: 50,
    cursor: { experimentId: f.id, phase: 'execution', sessionId: f.review.sessionId, nextSeq: 100 } }, [])
  expect(page?.records[0]?.seq).toBe(100)
  expect(f.read).toHaveBeenCalledExactlyOnceWith(100, 51)
})
it('rejects a logical range beyond supported event indices and closes its read handle', async () => {
  const f = fixture(false)
  f.read.mockImplementation(async (start = 0) => ({ events: [fromAny<SessionEvent, object>({ ...f.events[0], seq: start })], eventState: 'owned' as const }))
  await expect(readCompletionTrace(f.persistence, f.review, { experimentId: f.id, phase: 'execution', limit: 50 }, [])).rejects.toThrow('logical event range')
  expect(f.read.mock.calls.length).toBeLessThan(60)
  expect(f.close).toHaveBeenCalledOnce()
})
it('allows a validated supplementary copy only when the original Session is absent', async () => {
  const f = fixture(); f.persistence.stat = vi.fn(async () => undefined)
  expect(await readCompletionTrace(f.persistence, f.review, { experimentId: f.id, phase: 'execution' }, [])).toBeUndefined()
  expect(f.persistence.open).not.toHaveBeenCalled()
})
it('closes the original read handle on a failed read without hiding its error', async () => {
  const f = fixture(); f.read.mockRejectedValueOnce(new Error('Session read failed'))
  await expect(readCompletionTrace(f.persistence, f.review, { experimentId: f.id, phase: 'execution' }, [])).rejects.toThrow('Session read failed')
  expect(f.close).toHaveBeenCalledOnce()
})
