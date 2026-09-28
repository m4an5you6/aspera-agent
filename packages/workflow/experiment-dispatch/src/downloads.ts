/** Stream experiment artifacts to the browser through single-use private URLs. */
import { randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { ExperimentId, ExperimentServerId } from '@deepseek-ai/dsh-experiment-worker'
import type { ExperimentFleet } from './fleet.ts'

/** Ticket issuer and effect-owned HTTP stream handler. */
export class ExperimentDownloads {
  private readonly tickets = new Map<string, { id: ExperimentId; serverId: ExperimentServerId; path: string; expires: number }>()
  private ready = false

  constructor(ctx: Context, private readonly fleet: ExperimentFleet, private readonly ttlMs: number) {
    ctx.inject(['webServer'], (web) => {
      web.effect(() => {
        this.ready = true
        const active = new Set<AbortController>()
        const pending = new Set<Promise<void>>()
        const remove = web.webServer.register({ kind: 'prefix', path: '/experiment-download', handler: async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const token = url.pathname.slice('/experiment-download/'.length)
          const ticket = this.tickets.get(token)
          if (req.method !== 'GET' || ticket === undefined || ticket.expires < Date.now()) { res.writeHead(404); res.end(); return }
          this.tickets.delete(token)
          const { id, serverId, path } = ticket
          const abort = new AbortController()
          active.add(abort)
          const read = this.fleet.read.bind(this.fleet)
          async function* bytes() {
            let offset = 0
            let generation: string | undefined
            do {
              abort.signal.throwIfAborted()
              const chunk = await read(id, 'file', offset, serverId, path, generation, abort.signal)
              if (chunk.reset || chunk.generation === '' || (generation !== undefined && generation !== chunk.generation)) throw new Error('artifact changed or disappeared during download')
              generation = chunk.generation
              offset = chunk.nextOffset
              yield Buffer.from(chunk.data, 'base64')
              if (chunk.eof) return
            } while (true)
          }
          const close = () => { abort.abort(new Error('download connection closed')) }
          res.once('close', close)
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store',
            'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.slice(path.lastIndexOf('/') + 1))}` })
          const transfer = pipeline(Readable.from(bytes()), res, { signal: abort.signal }).catch((error: unknown) => {
            if (!abort.signal.aborted) ctx.logger.warn(`experiment download failed: ${String(error)}`)
          }).finally(() => { res.off('close', close); active.delete(abort); pending.delete(transfer) })
          pending.add(transfer)
          await transfer
        } })
        return async () => {
          this.ready = false
          remove()
          this.tickets.clear()
          for (const abort of active) abort.abort(new Error('download service stopped'))
          await Promise.all(pending)
        }
      }, 'experiment downloads: private streams')
    })
  }

  /**
   * Issue a private one-use artifact download address.
   * @param id - submitted experiment.
   * @param serverId - allocated node.
   * @param path - relative artifact.
   * @returns single-use URL, valid for the configured lifetime.
   */
  async issue(id: ExperimentId, serverId: ExperimentServerId, path: string): Promise<string> {
    if (!this.ready) throw new Error('experiment downloads require the Web profile')
    const first = await this.fleet.read(id, 'file', 0, serverId, path)
    if (first.generation === '') throw new Error('artifact is missing')
    for (const [token, ticket] of this.tickets) if (ticket.expires < Date.now()) this.tickets.delete(token)
    const token = randomBytes(32).toString('hex')
    this.tickets.set(token, { id, serverId, path, expires: Date.now() + this.ttlMs })
    return `/experiment-download/${token}`
  }
}
