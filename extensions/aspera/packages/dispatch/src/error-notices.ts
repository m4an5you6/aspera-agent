/** Profile-local error acknowledgements persist independently of experiment records. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

/** Public error scope contains identities and normalized error codes, never credentials. */
export interface ErrorNoticeScope { experimentId?: string; phase?: string; serverId?: string; operation: string; identity: string }
const scopeSchema = z.object({ experimentId: z.uuid().optional(), phase: z.enum(['preparation', 'planning', 'execution']).optional(),
  serverId: z.uuid().optional(), operation: z.string().min(1).max(100), identity: z.string().min(1).max(256) }).strict()
const spec = defineDomain({ name: 'aspera_error_notices', version: 1, layout: 'per-record', tables: {
  notices: domainTable<string, { shownAt: number }>(z.object({ shownAt: z.number() }).strict()),
} })
const stores = new WeakMap<Context, Promise<Domain<typeof spec>>>()
const chains = new WeakMap<Context, Promise<void>>()

/** Claim a first notification atomically within the current management profile.
 * @param ctx - profile storage. @param raw - public error identity. @returns true exactly once per identity.
 */
export function claimErrorNotice(ctx: Context, raw: ErrorNoticeScope): Promise<boolean> {
  const scope = scopeSchema.parse(raw)
  const profile = ctx.get('profileContext')
  if (profile === undefined) throw new Error('Error notifications require a dsh management profile')
  const key = createHash('sha256').update(JSON.stringify([profile.dir, scope.experimentId, scope.phase, scope.serverId, scope.operation, scope.identity])).digest('hex')
  const claim = (chains.get(ctx) ?? Promise.resolve()).then(async () => {
    let pending = stores.get(ctx)
    if (pending === undefined) {
      const opened = ctx.storage.domain.open(spec); pending = opened; stores.set(ctx, opened)
      ctx.effect(() => async () => { await chains.get(ctx); await (await opened).close() }, 'Aspera: persistent error notifications')
    }
    const table = (await pending).table('notices')
    if (table.get(key) !== undefined) return false
    await table.put(key, { shownAt: Date.now() })
    return true
  })
  chains.set(ctx, claim.then(() => {}, () => {}))
  return claim
}
