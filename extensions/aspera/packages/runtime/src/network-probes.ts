/** Short-lived authenticated connectivity probes do not allocate training resources. */
import { randomUUID } from 'node:crypto'
import { createServer, connect } from 'node:net'
import type { AddressInfo, Server, Socket } from 'node:net'
import { z } from 'zod'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import type { ExperimentId } from '@aspera/experiments'

/** Identity proof validated on control and peer connections. */
export const networkProofSchema = z.object({ experimentId: experimentIdSchema, serverId: serverIdSchema, nonce: z.uuid(), port: z.number().int().min(1).max(65535) }).strict()
/** Receiver identity returned by an ephemeral network listener. */
export type NetworkProof = z.infer<typeof networkProofSchema>

/** Each listener owns a deadline, all accepted sockets, and a joined close operation. */
export class NetworkProbes {
  private readonly listeners = new Map<ExperimentId, { proof: NetworkProof; server: Server; sockets: Set<Socket>; timer: ReturnType<typeof setTimeout> }>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly clients = new Set<Socket>()
  private mutations: Promise<void> = Promise.resolve()
  private closePromise: Promise<void> | undefined
  private closing = false
  constructor(private readonly lifetimeMs: number, private readonly connectTimeoutMs: number) {}

  /** Dispatch one authenticated preparation request.
   * @param operation - probe operation. @param raw - untrusted control JSON. @returns proof or connectivity result.
   */
  async request(operation: string, raw: unknown): Promise<unknown> {
    if (this.closing) throw new Error('Network preparation is stopping')
    const work = operation === 'probe-network-connect' ? this.perform(operation, raw)
      : this.serial(() => this.perform(operation, raw))
    this.pending.add(work)
    try { return await work } finally { this.pending.delete(work) }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const work = this.mutations.then(operation)
    this.mutations = work.then(() => {}, () => {})
    return work
  }

  private async perform(operation: string, raw: unknown): Promise<unknown> {
    if (operation === 'probe-network-connect') {
      const request = z.object({ experimentId: experimentIdSchema, host: z.string().min(1).max(255), proof: networkProofSchema }).strict().parse(raw)
      if (request.proof.experimentId !== request.experimentId) throw new Error('Peer proof belongs to another experiment')
      await new Promise<void>((resolve, reject) => {
        const socket = connect(request.proof.port, request.host)
        this.clients.add(socket)
        let reply = ''
        socket.setTimeout(this.connectTimeoutMs, () => socket.destroy(new Error('Node-to-node connection timed out')))
        socket.once('error', reject)
        socket.once('close', () => { this.clients.delete(socket); reject(new Error('Network connection closed before identity verification')) })
        socket.on('data', chunk => { reply += String(chunk); if (reply.length > 2048) socket.destroy(new Error('Network proof exceeds its limit')) })
        socket.once('end', () => {
          if (reply !== JSON.stringify(request.proof)) reject(new Error('Network probe reached a different node or experiment'))
          else resolve()
        })
      })
      return { connected: true }
    }
    const input = z.object({ experimentId: experimentIdSchema, serverId: serverIdSchema.optional() }).strict().parse(raw)
    if (operation === 'probe-network-stop') { await this.stop(input.experimentId); return { stopped: true } }
    if (operation !== 'probe-network-start' || input.serverId === undefined) throw new Error('Invalid network preparation request')
    const previous = this.listeners.get(input.experimentId)
    if (previous !== undefined) {
      if (previous.proof.serverId !== input.serverId) throw new Error('Network probe identity conflicts with the existing listener')
      return previous.proof
    }
    const sockets = new Set<Socket>()
    const proof: NetworkProof = { experimentId: input.experimentId, serverId: input.serverId, nonce: randomUUID(), port: 1 }
    const server = createServer(socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      socket.on('error', error => { void error })
      socket.setTimeout(this.connectTimeoutMs, () => socket.destroy())
      socket.end(JSON.stringify(proof))
    })
    const listen = (host: string) => new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => { server.off('listening', ready); reject(error) }
      const ready = () => { server.off('error', failed); resolve() }
      server.once('error', failed); server.once('listening', ready); server.listen({ port: 0, host })
    })
    try { await listen('::') } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || !['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(String(error.code))) throw error
      await listen('0.0.0.0')
    }
    proof.port = (server.address() as AddressInfo).port
    const timer = setTimeout(() => { void this.serial(() => this.stop(input.experimentId)).catch(error => {
      // A failed close retains the listener for the controller's joined teardown.
      void error
    }) }, this.lifetimeMs)
    this.listeners.set(input.experimentId, { proof, server, sockets, timer })
    if (this.closing) await this.stop(input.experimentId)
    return proof
  }

  private async stop(id: ExperimentId): Promise<void> {
    const owned = this.listeners.get(id)
    if (owned === undefined) return
    clearTimeout(owned.timer)
    for (const socket of owned.sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => owned.server.close(error => error === undefined ? resolve() : reject(error)))
    this.listeners.delete(id)
  }

  /** Close listeners and join outstanding requests before the role stops. */
  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise
    this.closing = true
    for (const socket of this.clients) socket.destroy(new Error('Network preparation is stopping'))
    this.closePromise = (async () => {
      await Promise.allSettled([...this.pending])
      await this.serial(() => Promise.all([...this.listeners.keys()].map(id => this.stop(id))))
    })()
    return this.closePromise
  }
}
