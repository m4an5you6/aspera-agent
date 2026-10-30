/** Version-specific documentation reads have durable deadlines and immutable pages. */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { documentationReadSchema, planningPolicySchema, documentationRequestIdSchema, documentationSnapshotIdSchema } from '@aspera/experiments'
import type { DocumentationRead, DocumentationRequestId, DocumentationSnapshotId, PlanningOwner, PlanningPolicy } from '@aspera/experiments'
import { PlanningStore, planningDigest, planningTextPage } from './planning-store.ts'

const policySchema = planningPolicySchema.extend({ documentationBytes: z.number().int().positive(), documentationHosts: z.array(z.string()) }).strict()
type DocumentationPolicy = z.infer<typeof policySchema>
const failureSchema = z.object({ kind: z.enum(['timeout', 'cancelled', 'http', 'too-large', 'network', 'interrupted']), detail: z.string() }).strict()
const requestSchema = z.object({ version: z.literal(1), formatVersion: z.literal('0.1.0'), requestId: documentationRequestIdSchema, url: z.string(),
  state: z.enum(['pending', 'complete', 'failed']), startedAt: z.number(), deadline: z.number(), finishedAt: z.number().optional(),
  pid: z.number().int().positive(), receivedBytes: z.number().int().nonnegative(), snapshotId: documentationSnapshotIdSchema.optional(), error: failureSchema.optional() }).strict()
type SavedRequest = z.infer<typeof requestSchema>
const snapshotSchema = z.object({ version: z.literal(1), formatVersion: z.literal('0.1.0'), snapshotId: documentationSnapshotIdSchema,
  url: z.string(), requestId: documentationRequestIdSchema, readAt: z.number(), sha256: z.string(), text: z.string() }).strict()
/** Complete document pages and explicit failures use distinct states. */
export interface DocumentationResult {
  state: 'pending' | 'complete' | 'failed'; complete: boolean; requestId: DocumentationRequestId; url: string; elapsedMs: number; receivedBytes: number;
  cached?: boolean; snapshotId?: DocumentationSnapshotId; readAt?: number; sha256?: string; text?: string; next?: DocumentationRead;
  error?: z.infer<typeof failureSchema>; totalCharacters?: number; queryFound?: boolean;
}

/** Resolve a submitted experiment's limits before considering resident controller defaults.
 * @param saved - immutable private deployment snapshot, absent in older releases. @param configured - resident profile limits.
 * @returns complete documentation limits for this experiment.
 */
export function resolveDocumentationPolicy(saved: PlanningPolicy | undefined,
  configured: { documentationReadTimeoutMs?: number; documentationPageBytes?: number }): PlanningPolicy {
  if (saved !== undefined) return saved
  return planningPolicySchema.parse({ documentationReadTimeoutMs: configured.documentationReadTimeoutMs, documentationPageBytes: configured.documentationPageBytes })
}

/** A Session's documents never depend on the shared command timeout. */
export class FrameworkDocumentation {
  private readonly store: PlanningStore
  private readonly inFlight = new Map<string, Promise<DocumentationResult>>()
  /** @param runRoot - private experiment directory. @param owner - immutable worker identity. @param policy - validated deployment limits.
   * @param fetcher - HTTP implementation; production uses native fetch and tests inject owned requests.
   */
  constructor(runRoot: string, owner: PlanningOwner, private readonly policy: DocumentationPolicy, private readonly fetcher: typeof fetch = fetch) {
    this.store = new PlanningStore(runRoot, owner, 'documentation-v1/' + planningDigest(owner.sessionId))
  }
  private async effectivePolicy(): Promise<DocumentationPolicy> {
    await this.store.initialize()
    return withFileLock(this.store.path('policy.json'), async () => {
      const file = this.store.path('policy.json')
      if (existsSync(file)) return policySchema.parse(JSON.parse(readFileSync(file, 'utf8')))
      const policy = policySchema.parse(this.policy); await this.store.write(['policy.json'], policy); return policy
    })
  }
  private result(request: SavedRequest): DocumentationResult {
    return { state: request.state, complete: request.state === 'complete', requestId: request.requestId, url: request.url,
      elapsedMs: (request.finishedAt ?? Date.now()) - request.startedAt, receivedBytes: request.receivedBytes,
      ...(request.error === undefined ? {} : { error: request.error }) }
  }
  private page(request: SavedRequest, query: DocumentationRead, policy: DocumentationPolicy, cached: boolean): DocumentationResult {
    const snapshotId = query.snapshotId ?? request.snapshotId
    if (snapshotId === undefined) throw new Error('Complete documentation has no saved snapshot')
    const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(this.store.path('snapshots', snapshotId + '.json'), 'utf8')))
    if (snapshot.url !== query.url || snapshot.snapshotId !== snapshotId || snapshot.snapshotId !== planningDigest({ url: snapshot.url, sha256: snapshot.sha256, requestId: snapshot.requestId })
      || snapshot.sha256 !== planningDigest(snapshot.text)) throw new Error('Documentation cursor differs from its saved source or digest')
    let offset = query.offset ?? 0
    const match = query.query === undefined ? undefined : snapshot.text.toLocaleLowerCase('en-US').indexOf(query.query.toLocaleLowerCase('en-US'), offset)
    if (match !== undefined && match >= 0) offset = match
    const page = planningTextPage(snapshot.text, offset, policy.documentationPageBytes)
    return { ...this.result(request), state: 'complete', complete: true, cached, snapshotId, readAt: snapshot.readAt, sha256: snapshot.sha256,
      text: page.text, totalCharacters: page.totalCharacters, ...(match === undefined ? {} : { queryFound: match >= 0 }),
      ...(page.nextOffset < page.totalCharacters ? { next: { url: query.url, snapshotId, offset: page.nextOffset } } : {}) }
  }
  /** Read or explicitly retry a source, or continue one immutable saved snapshot.
   * @param input - allowed public URL, explicit refresh/retry or snapshot cursor. @param signal - calling tool lifetime.
   * @returns bounded original content or a durable structured failure.
   */
  async read(input: z.input<typeof documentationReadSchema>, signal: AbortSignal): Promise<DocumentationResult> {
    const query = documentationReadSchema.parse(input), policy = await this.effectivePolicy(), url = new URL(query.url)
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !policy.documentationHosts.includes(url.hostname)) throw new Error('documentation host is outside the configured public documentation list')
    url.hash = ''; query.url = url.href
    const key = planningDigest(query.url)
    if (query.snapshotId !== undefined) {
      const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(this.store.path('snapshots', query.snapshotId + '.json'), 'utf8')))
      const request = requestSchema.parse(JSON.parse(readFileSync(this.store.path('attempts', snapshot.requestId + '.json'), 'utf8')))
      return this.page(request, query, policy, true)
    }
    const pending = this.inFlight.get(key)
    if (pending !== undefined) {
      const result = await pending
      if (result.state !== 'complete') return { ...result, cached: true }
      const request = requestSchema.parse(JSON.parse(readFileSync(this.store.path('attempts', result.requestId + '.json'), 'utf8')))
      return this.page(request, query, policy, true)
    }
    const operation = this.obtain(query, policy, key, signal)
    this.inFlight.set(key, operation)
    try { return await operation } finally { if (this.inFlight.get(key) === operation) this.inFlight.delete(key) }
  }
  private async obtain(query: DocumentationRead, policy: DocumentationPolicy, key: string, signal: AbortSignal): Promise<DocumentationResult> {
    const request = await withFileLock(this.store.path(key), async () => {
      const index = this.store.path('sources', key + '.json')
      let previous: SavedRequest | undefined
      if (existsSync(index)) {
        const pointer = z.object({ requestId: documentationRequestIdSchema }).strict().parse(JSON.parse(readFileSync(index, 'utf8')))
        previous = requestSchema.parse(JSON.parse(readFileSync(this.store.path('attempts', pointer.requestId + '.json'), 'utf8')))
        if (previous.url !== query.url) throw new Error('Documentation source identity differs')
        if (previous.state === 'pending') {
          if (previous.pid === process.pid && Date.now() < previous.deadline) return previous
          previous = { ...previous, state: 'failed', finishedAt: Date.now(), error: { kind: Date.now() >= previous.deadline ? 'timeout' : 'interrupted', detail: 'The original documentation read did not finish; retry explicitly to start another attempt' } }
          await this.store.write(['attempts', previous.requestId + '.json'], previous)
        }
        if (previous.state === 'complete' && !query.refresh || previous.state === 'failed' && !query.retry && !query.refresh) return previous
      }
      const startedAt = Date.now()
      const created: SavedRequest = { version: 1, formatVersion: '0.1.0', requestId: documentationRequestIdSchema.parse(randomUUID()), url: query.url, state: 'pending',
        startedAt, deadline: startedAt + policy.documentationReadTimeoutMs, pid: process.pid, receivedBytes: 0 }
      await this.store.write(['attempts', created.requestId + '.json'], created)
      await this.store.write(['sources', key + '.json'], { requestId: created.requestId })
      return created
    })
    if (request.state === 'complete') return this.page(request, query, policy, true)
    if (request.state === 'failed') return { ...this.result(request), cached: true }
    if (request.pid !== process.pid) return this.result(request)
    // Another store in this process observes the original persisted request rather than starting a second fetch.
    const activeFile = this.store.path('attempts', request.requestId + '.active')
    const { open, unlink } = await import('node:fs/promises')
    let active: import('node:fs/promises').FileHandle
    try { active = await open(activeFile, 'wx', 0o600) }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return this.result(request); throw error }
    await active.close()
    const deadline = AbortSignal.timeout(Math.max(0, request.deadline - Date.now())), lifetime = AbortSignal.any([signal, deadline])
    const stop = new AbortController(), combined = AbortSignal.any([lifetime, stop.signal]), chunks: Buffer[] = []
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined, cancellation: Promise<void> | undefined
    const cancelBody = () => { cancellation = reader?.cancel(combined.reason).catch(error => { if (!combined.aborted) throw error }) }
    combined.addEventListener('abort', cancelBody, { once: true })
    let state: SavedRequest = request
    try {
      combined.throwIfAborted()
      const response = await this.fetcher(query.url, { signal: combined, redirect: 'error', credentials: 'omit' })
      if (!response.ok) {
        await response.body?.cancel()
        state = { ...state, state: 'failed', error: { kind: 'http', detail: `Documentation returned HTTP ${response.status}` } }
      } else {
        reader = response.body?.getReader()
        if (combined.aborted) cancelBody()
        combined.throwIfAborted()
        if (reader !== undefined) for (;;) {
          const chunk = await reader.read(); combined.throwIfAborted(); if (chunk.done) break
          state.receivedBytes += chunk.value.byteLength
          if (state.receivedBytes > policy.documentationBytes) { state = { ...state, state: 'failed', error: { kind: 'too-large', detail: 'Documentation exceeds the configured download limit; choose a smaller document' } }; stop.abort(new Error('Documentation size limit')); break }
          chunks.push(Buffer.from(chunk.value))
        }
        if (state.state !== 'failed') {
          combined.throwIfAborted()
          const text = Buffer.concat(chunks).toString('utf8'), sha256 = planningDigest(text)
          const snapshotId = documentationSnapshotIdSchema.parse(planningDigest({ url: query.url, sha256, requestId: request.requestId }))
          await this.store.write(['snapshots', snapshotId + '.json'], { version: 1, formatVersion: '0.1.0', snapshotId, url: query.url,
            requestId: request.requestId, readAt: Date.now(), sha256, text })
          state = { ...state, state: 'complete', snapshotId }
        }
      }
    } catch (error) {
      state = { ...state, state: 'failed', error: { kind: signal.aborted ? 'cancelled' : deadline.aborted ? 'timeout' : 'network', detail: String(error).slice(0, 2000) } }
    } finally {
      combined.removeEventListener('abort', cancelBody)
      await cancellation
      reader?.releaseLock()
    }
    try {
      state.finishedAt = Date.now()
      if (state.state !== 'complete' && chunks.length > 0) await this.store.write(['partial', state.requestId + '.json'], { complete: false, text: Buffer.concat(chunks).toString('utf8') })
      await this.store.write(['attempts', state.requestId + '.json'], state)
    } finally { await unlink(activeFile) }
    return state.state === 'complete' ? this.page(state, query, policy, false) : { ...this.result(state), cached: false }
  }
}
