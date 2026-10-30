/** The Host verifies the user-configured public service with a fixed harmless prompt and private credentials. */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { Agent, fetch as directFetch } from 'undici'
import { serviceVerificationSchema, serviceAccessInfoSchema, serviceVerificationResultSchema } from '@aspera/experiments'
import type { ExperimentId, ServiceAccessInfo, ServiceVerification, ServiceVerificationResult } from '@aspera/experiments'

/** Host-only routing for the explicitly registered service; no global transport is changed. */
export const publicServiceVerificationRouteSchema = z.enum(['direct', 'inherit']).default('direct')
/** A verification either owns its direct dispatcher or inherits the existing HTTP policy. */
export type PublicServiceVerificationRoute = z.infer<typeof publicServiceVerificationRouteSchema>

function failureDetail(error: unknown): string {
  const rows: string[] = [String(error)]
  let cause = error instanceof Error ? error.cause : undefined
  for (let depth = 0; depth < 3 && cause instanceof Error; depth++) {
    if ('code' in cause && typeof cause.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code)) rows.push('cause=' + cause.code)
    cause = cause.cause
  }
  return rows.join('; ')
}

/** @param operation - original Agent request and service identity. @param access - credential for this registered service.
 * @param signal - Host lifetime. @param responseBytes - configured response limit. @param route - resolved Host-only routing.
 * @returns HTTP observations without credentials or user prompts.
 */
export async function verifyPublicInference(operation: ServiceVerification, access: ServiceAccessInfo, signal: AbortSignal,
  responseBytes: number, route: PublicServiceVerificationRoute): Promise<ServiceVerificationResult> {
  if (access.url !== operation.url || access.modelName !== operation.modelName) throw new Error('Public verification calling information differs from the registered service')
  const lifetime = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, operation.deadline - Date.now()))])
  const checks: ServiceVerificationResult['checks'] = []
  const clean = (value: string) => value.replaceAll(access.token, '[redacted]').slice(0, 32768)
  let generating = false
  const dispatcher = route === 'direct' ? new Agent() : undefined
  const read = async (path: string, authorization: string | undefined, body?: object) => {
    lifetime.throwIfAborted()
    const url = access.url.replace(/\/$/, '') + path
    const request = { method: body === undefined ? 'GET' : 'POST', redirect: 'error' as const, signal: lifetime,
      headers: { ...(authorization === undefined ? {} : { authorization }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }
    const response = dispatcher === undefined ? await fetch(url, request) : await directFetch(url, { ...request, dispatcher })
    const chunks: Buffer[] = []; let bytes = 0
    try {
      if (response.body !== null) for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > responseBytes) throw new Error('Public inference response exceeds the configured byte limit')
        chunks.push(Buffer.from(chunk))
      }
    } finally { if (response.body !== null && !response.body.locked) await response.body.cancel() }
    return { status: response.status, text: clean(Buffer.concat(chunks).toString('utf8')) }
  }
  const observe = (name: ServiceVerificationResult['checks'][number]['name'], response: { status: number; text: string }, passed: boolean) => {
    checks.push({ name, status: response.status, passed, checkedAt: Date.now(), detail: response.text })
    if (!passed) throw new Error('Public inference check failed: ' + name + ' (HTTP ' + response.status + ')')
  }
  try {
    const auth = 'Bearer ' + access.token, nonce = randomUUID()
    const identity = await read('/_aspera/health?nonce=' + nonce, auth)
    const value = z.object({ experimentId: z.literal(operation.experimentId), serviceId: z.literal(operation.input.serviceId), nonce: z.literal(nonce) })
      .safeParse(JSON.parse(identity.text))
    observe('identity', identity, identity.status === 200 && value.success)
    const unauthenticated = await read('/v1/models', undefined)
    observe('unauthenticated', unauthenticated, unauthenticated.status === 401)
    const invalid = await read('/v1/models', 'Bearer invalid-' + nonce)
    observe('invalid-credential', invalid, invalid.status === 401)
    const models = await read('/v1/models', auth)
    const listing = z.object({ data: z.array(z.object({ id: z.string() })) }).safeParse(JSON.parse(models.text))
    observe('models', models, models.status === 200 && listing.success && listing.data.data.some(model => model.id === operation.modelName))
    generating = true
    const generation = await read('/v1/chat/completions', auth, { model: operation.modelName, stream: false, temperature: 0,
      max_tokens: operation.input.maxTokens, messages: [{ role: 'user', content: 'Reply with one short sentence confirming this LoRA inference service is available.' }] })
    generating = false
    const output = z.object({ model: z.literal(operation.modelName), choices: z.array(z.object({ message: z.object({ content: z.string().trim().min(1) }) })).min(1) })
      .safeParse(JSON.parse(generation.text))
    observe('generation', generation, generation.status === 200 && output.success)
    return { state: 'passed', checks, detail: `Host verified public service identity, Bearer enforcement, model listing and an actual response to the fixed standard test prompt; route=${route}`, finishedAt: Date.now() }
  } catch (error) {
    return { state: generating ? 'unknown' : 'failed', checks, detail: `route=${route}; ` + clean(failureDetail(error)) + (generating ? '; generation transport outcome is unknown; this operation must not be replayed' : ''), finishedAt: Date.now() }
  } finally { await dispatcher?.close() }
}

/** The Host owns experiment visibility and authenticated transport; credentials never enter Agent results. */
export interface PublicServiceCheckOwner {
  alive(id: ExperimentId): boolean
  call(id: ExperimentId, operation: string, input: object, signal: AbortSignal): Promise<unknown>
  report(error: unknown): void
}
/** Archive/status refreshes schedule bounded checks independently of the visible page. */
export class PublicServiceChecks {
  private readonly work = new Map<ExperimentId, { abort: AbortController; done: Promise<void> }>()
  private readonly unsupported = new Set<ExperimentId>()
  private readonly stopped = new Set<ExperimentId>()
  private closed = false
  /** @param owner - experiment visibility and authenticated coordinator. @param responseBytes - response limit. @param readTimeoutMs - one control read budget. @param route - resolved Host-only routing. */
  constructor(private readonly root: string, private readonly owner: PublicServiceCheckOwner, private readonly responseBytes: number, private readonly readTimeoutMs: number, private readonly route: PublicServiceVerificationRoute) {}
  /** @param id - remotely accepted experiment. Schedule an Agent-requested check without another model request. */
  changed(id: ExperimentId): void {
    if (this.closed || this.stopped.has(id) || !this.owner.alive(id) || this.work.has(id) || this.unsupported.has(id)) return
    const abort = new AbortController()
    const done = Promise.resolve().then(() => this.run(id, abort.signal)).catch(error => {
      if (!abort.signal.aborted) this.owner.report(error)
    }).finally(() => { this.work.delete(id) })
    this.work.set(id, { abort, done })
  }
  private async run(id: ExperimentId, signal: AbortSignal): Promise<void> {
    const call = (operation: string, input: object) => this.owner.call(id, operation, input,
      AbortSignal.any([signal, AbortSignal.timeout(this.readTimeoutMs)]))
    const pending = z.object({ supported: z.boolean(), operations: z.array(serviceVerificationSchema) }).parse(await call('service-verification-pending', {}))
    if (!pending.supported) { this.unsupported.add(id); return }
    for (const operation of pending.operations) {
      signal.throwIfAborted()
      if (!this.owner.alive(id)) return
      const path = resolve(this.root, id, operation.input.operationId + '.json')
      if (existsSync(path)) {
        const saved = z.object({ operation: serviceVerificationSchema, result: serviceVerificationResultSchema }).parse(JSON.parse(readFileSync(path, 'utf8')))
        if (saved.operation.experimentId !== id || JSON.stringify(saved.operation) !== JSON.stringify(operation)) throw new Error('Saved public verification belongs to another operation or service')
        await call('service-verification-result', { serverId: operation.serverId, operationId: operation.input.operationId, claimId: operation.claimId, result: saved.result })
        continue
      }
      if (operation.state !== 'requested') continue
      const claimId = randomUUID()
      const claimed = z.object({ operation: serviceVerificationSchema, access: serviceAccessInfoSchema.optional() }).parse(await call('service-verification-claim',
        { serverId: operation.serverId, operationId: operation.input.operationId, claimId }))
      if (claimed.operation.state !== 'claimed' || claimed.operation.claimId !== claimId || claimed.access === undefined) continue
      const result = serviceVerificationResultSchema.parse(await verifyPublicInference(claimed.operation, claimed.access, signal, this.responseBytes, this.route))
      await writeFileAtomic(path, JSON.stringify({ operation: claimed.operation, result }) + '\n', { mode: 0o600 })
      if (!this.owner.alive(id)) return
      await this.owner.call(id, 'service-verification-result', { serverId: operation.serverId, operationId: operation.input.operationId, claimId, result },
        AbortSignal.timeout(this.readTimeoutMs))
    }
  }
  /** @param id - removed or interrupted experiment. Abort and await pending reads and result commits. */
  async stop(id: ExperimentId): Promise<void> {
    this.stopped.add(id)
    const pending = this.work.get(id)
    pending?.abort.abort(new Error('Public verification owner stopped')); await pending?.done
  }
  /** Stop all local checks before the Host closes transport. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.all([...this.work.keys()].map(id => this.stop(id)))
  }
}
