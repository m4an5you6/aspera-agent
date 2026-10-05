/** Durable notification claims survive renderer/profile lifetimes and concurrent polling. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { fromAny } from '@total-typescript/shoehorn'
import { expect, it } from 'vitest'
import { claimErrorNotice } from '../src/error-notices.ts'

it('claims an error once across concurrent requests and restart, while isolating nodes and profiles', async () => {
  const create = (records: Map<string, object>, profile = '/fixture/aspera') => {
    const disposers: (() => Promise<void>)[] = []
    const ctx = fromAny<Context, object>({ get: () => ({ dir: profile }), storage: { domain: { open: async () => ({ table: () => ({
      get: (key: string) => records.get(key), put: async (key: string, value: object) => { records.set(key, value) },
    }), close: async () => {} }) } }, effect: (setup: () => () => Promise<void>) => disposers.push(setup()) })
    return { ctx, close: async () => { for (const dispose of disposers) await dispose() } }
  }
  const records = new Map<string, object>(); const first = create(records)
  const scope = { experimentId: randomUUID(), serverId: randomUUID(), phase: 'execution', operation: 'logs', identity: 'timeout' }
  expect(await Promise.all([claimErrorNotice(first.ctx, scope), claimErrorNotice(first.ctx, scope)])).toEqual([true, false])
  await first.close()
  const restarted = create(records), separate = create(records, '/fixture/other-profile')
  try {
    expect(await claimErrorNotice(restarted.ctx, scope)).toBe(false)
    expect(await claimErrorNotice(restarted.ctx, { ...scope, serverId: randomUUID() })).toBe(true)
    expect(await claimErrorNotice(restarted.ctx, { ...scope, identity: 'ECONNREFUSED' })).toBe(true)
    expect(await claimErrorNotice(separate.ctx, scope)).toBe(true)
    expect([...records.values()]).toEqual(expect.arrayContaining([expect.objectContaining({ shownAt: expect.any(Number) })]))
    expect(JSON.stringify([...records])).not.toContain(scope.experimentId)
  } finally { await restarted.close(); await separate.close() }
})
