/** A service-only authenticated listener forwards HTTP and streaming output to its private model process. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer, request } from 'node:http'
import type { ClientRequest, IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { InferenceService, ServiceAccessInfo } from '@aspera/experiments'

/** Bounds inherited from the node profile, independent from the experiment lifetime. */
export interface InferenceGatewayConfig {
  root: string
  healthTimeoutMs: number
  requestTimeoutMs: number
  requestBytes: number
}

/** Effect-owned public listener; closing drains its sockets and upstream requests. */
export interface InferenceGateway {
  /** @returns service-specific calling information for an explicit operator action. */
  access(): ServiceAccessInfo
  /** @returns health through the saved external URL, including target identity. */
  probe(): Promise<NonNullable<InferenceService['external']>>
  /** Stop accepting calls and await socket teardown. */
  close(): Promise<void>
}

/**
 * Open the mapped port while the model itself stays bound to loopback.
 * @param service - durable service with an explicitly authorized external mapping.
 * @param config - private credential directory and HTTP limits.
 * @param live - whether the owning command and allocation remain active.
 * @returns listener and private operator access information.
 */
export async function openInferenceGateway(service: InferenceService, config: InferenceGatewayConfig,
  live: () => boolean): Promise<InferenceGateway> {
  const external = service.external
  if (external === undefined) throw new Error('Inference gateway requires a saved external mapping')
  const directory = resolve(config.root, 'secrets', 'inference')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = resolve(directory, service.id + '.token')
  try { writeFileSync(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('Service credential must be a private regular file')
  const token = readFileSync(file, 'utf8')
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Service credential is invalid')
  const expected = Buffer.from('Bearer ' + token)
  const lifetime = new AbortController()
  const sockets = new Set<Socket>()
  const requests = new Set<ClientRequest>()
  const base = new URL(external.url)
  const prefix = base.pathname.replace(/\/$/, '')
  const healthy = async () => {
    if (!live() || lifetime.signal.aborted) return false
    const response = await fetch(`http://127.0.0.1:${service.port}${service.healthPath}`, {
      redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.healthTimeoutMs)]),
    })
    await response.body?.cancel()
    return response.ok && live() && !lifetime.signal.aborted
  }
  const reply = (res: ServerResponse, status: number, value: object) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  const serve = async (req: IncomingMessage, res: ServerResponse) => {
    const actual = Buffer.from(req.headers.authorization ?? '')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { reply(res, 401, { error: 'Service Bearer token required' }); return }
    if (!live() || lifetime.signal.aborted) { reply(res, 503, { error: 'Inference process is unavailable' }); return }
    const raw = req.url ?? '/'
    if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) { reply(res, 400, { error: 'Relative service path required' }); return }
    // Platforms may preserve the configured base path or remove it before forwarding.
    const path = prefix && (raw === prefix || raw.startsWith(prefix + '/')) ? raw.slice(prefix.length) || '/' : raw
    const url = new URL(path, 'http://localhost')
    if (url.pathname === '/_aspera/health') {
      if (req.method !== 'GET') { reply(res, 405, { error: 'GET required' }); return }
      if (!await healthy()) { reply(res, 503, { error: 'Inference HTTP health check failed' }); return }
      reply(res, 200, { serviceId: service.id, experimentId: service.experimentId, nonce: url.searchParams.get('nonce') })
      return
    }
    if (!['GET', 'HEAD', 'POST'].includes(req.method ?? '')) { reply(res, 405, { error: 'GET, HEAD or POST required' }); return }
    const headers: Record<string, string> = {}
    for (const name of ['content-type', 'accept']) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    const upstream = request({ hostname: '127.0.0.1', port: service.port, path, method: req.method, headers,
      signal: lifetime.signal }, response => {
      const output: Record<string, string> = { 'cache-control': 'no-store' }
      for (const name of ['content-type', 'content-encoding']) {
        const value = response.headers[name]
        if (typeof value === 'string') output[name] = value
      }
      res.writeHead(response.statusCode ?? 502, output)
      response.on('error', error => { res.destroy(error) })
      response.pipe(res)
    })
    requests.add(upstream)
    upstream.once('close', () => { requests.delete(upstream) })
    upstream.setTimeout(config.requestTimeoutMs, () => { upstream.destroy(new Error('Inference response timed out')) })
    upstream.once('error', () => { if (!res.headersSent) reply(res, 502, { error: 'Inference request failed' }); else res.destroy() })
    let bytes = 0
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > config.requestBytes) {
        if (!res.headersSent) reply(res, 413, { error: 'Inference request exceeds the configured size' })
        req.unpipe(upstream); upstream.destroy()
      }
    })
    req.once('aborted', () => { upstream.destroy() })
    res.once('close', () => { upstream.destroy() })
    req.pipe(upstream)
  }
  const server = createServer((req, res) => {
    void serve(req, res).catch(() => { if (!res.headersSent) reply(res, 503, { error: 'Inference service unavailable' }); else res.destroy() })
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => { sockets.delete(socket) }) })
  await new Promise<void>((ready, reject) => {
    server.once('error', reject)
    server.listen({ host: '0.0.0.0', port: external.port, exclusive: true }, ready)
  })
  let closing: Promise<void> | undefined
  return {
    access: () => ({ url: external.url, token, ...(service.modelName === undefined ? {} : { modelName: service.modelName }) }),
    probe: async () => {
      const checkedAt = Date.now()
      try {
        const nonce = randomBytes(16).toString('hex')
        const url = new URL(external.url.replace(/\/$/, '') + '/_aspera/health')
        url.searchParams.set('nonce', nonce)
        const response = await fetch(url, { headers: { authorization: 'Bearer ' + token }, redirect: 'error',
          signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(config.healthTimeoutMs)]) })
        if (!response.ok) { await response.body?.cancel(); throw new Error(`External address returned HTTP ${response.status}`) }
        let text = ''
        if (response.body !== null) for await (const chunk of response.body) {
          text += Buffer.from(chunk).toString('utf8')
          if (text.length > 4096) throw new Error('External health response exceeds 4096 bytes')
        }
        const value: unknown = JSON.parse(text)
        if (typeof value !== 'object' || value === null || !('serviceId' in value) || value.serviceId !== service.id
          || !('experimentId' in value) || value.experimentId !== service.experimentId || !('nonce' in value) || value.nonce !== nonce) {
          throw new Error('External address reached a different service; check the platform port mapping')
        }
        return { ...external, state: 'reachable', checkedAt, detail: undefined }
      } catch (error) { return { ...external, state: 'unreachable', checkedAt, detail: error instanceof Error ? error.message : String(error) } }
    },
    close: () => {
      if (closing === undefined) {
        lifetime.abort(new Error('Inference service stopped'))
        for (const req of requests) req.destroy()
        closing = new Promise<void>((done, reject) => { server.close(error => { if (error) reject(error); else done() }) })
        for (const socket of sockets) socket.destroy()
      }
      return closing
    },
  }
}
