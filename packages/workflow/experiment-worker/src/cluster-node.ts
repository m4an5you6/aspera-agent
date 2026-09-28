/** A node owns one experiment allocation and confined process ranges independently of SSH connections. */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer, connect } from 'node:net'
import type { AddressInfo, Server } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { clusterCommandResultSchema, clusterCommandSchema, clusterNodeSchema, deploymentIdSchema, experimentIdSchema } from './cluster-protocol.ts'
import type { ClusterCommandResult, ExperimentId } from './cluster-protocol.ts'
import { clusterFiles, clusterPath, readClusterChunk } from './cluster-files.ts'
import { clusterFileHash } from './cluster-runtime.ts'

const allocationSchema = z.object({ experimentId: experimentIdSchema, deploymentId: deploymentIdSchema,
  node: clusterNodeSchema, released: z.boolean(), releasing: z.boolean().default(false), bootId: z.string() }).strict()
const commandSchema = clusterCommandResultSchema.extend({ experimentId: experimentIdSchema, command: z.string() })
function commandView(row: z.infer<typeof commandSchema>): ClusterCommandResult {
  return { commandId: row.commandId, state: row.state, exitCode: row.exitCode, released: row.released,
    ...(row.detail === undefined ? {} : { detail: row.detail }) }
}
const storeSpec = defineDomain({ name: 'experiment_cluster_node', version: 1, layout: 'per-record', tables: {
  allocations: domainTable<ExperimentId, z.infer<typeof allocationSchema>>(allocationSchema),
  commands: domainTable<string, z.infer<typeof commandSchema>>(commandSchema),
} })

/** Configured bounds for a node control process. */
export interface ClusterNodeConfig {
  root: string
  bootId: string
  chunkBytes: number
  fileLimit: number
  cleanupTimeoutMs: number
  devicePaths: readonly string[]
}

/**
 * Own durable node allocations and confined managed processes.
 * @param ctx - confined subprocess provider.
 * @param config - node-owned paths and limits.
 * @returns effect-owned node request handler.
 */
export async function createClusterNode(ctx: Context, config: ClusterNodeConfig): Promise<(operation: string,
  raw: unknown) => Promise<unknown>> {
  const store = await ctx.storageDomain.open(storeSpec)
  const allocations = store.table('allocations')
  const commands = store.table('commands')
  const handles = new Map<string, SubprocessHandle>()
  const settlements = new Map<string, Promise<void>>()
  let chain: Promise<void> = Promise.resolve()
  let closing = false
  const netServers = new Map<ExperimentId, Server>()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = chain.then(operation)
    chain = pending.then(() => {}, () => {})
    return pending
  }
  const workspace = (id: ExperimentId) => resolve(config.root, 'runs', id, 'workspace')
  const logPath = (id: ExperimentId) => resolve(config.root, 'runs', id, 'node.log')
  const allocation = (id: ExperimentId) => {
    const saved = allocations.get(id)
    if (saved === undefined || saved.released || saved.releasing || saved.bootId !== config.bootId) throw new Error('node allocation is unavailable or interrupted')
    return saved
  }
  const finish = async (key: string, handle: SubprocessHandle): Promise<void> => {
    let patch: Partial<ClusterCommandResult>
    try {
      const outcome = await handle.done
      const released = await handle.waitForExit(AbortSignal.timeout(config.cleanupTimeoutMs))
      patch = { exitCode: outcome.exitCode, released, state: outcome.exitCode === 0 && released ? 'completed' : 'failed' }
    } catch (error) { patch = { state: 'failed', released: false, detail: String(error) } }
    await serial(async () => {
      const current = commands.get(key)
      if (current === undefined) throw new Error('managed command record is missing')
      await commands.put(key, { ...current, ...patch })
    })
    handles.delete(key)
  }
  ctx.effect(() => async () => {
    closing = true
    await chain
    for (const handle of handles.values()) handle.terminate()
    await Promise.all([...netServers.values()].map(server => new Promise<void>((done) => { server.close(() => { done() }) })))
    await Promise.all(settlements.values())
    await chain
    await store.close()
  }, 'experiment node: processes and allocation records')

  return async (operation: string, raw: unknown): Promise<unknown> => {
    if (operation === 'health') return { allocations: [...allocations.entries()].filter(([, row]) => !row.released).map(([id]) => id) }
    const input = z.object({ experimentId: experimentIdSchema }).loose().parse(raw)
    const id = input.experimentId
    if (operation === 'allocate') return serial(async () => {
      if (closing) throw new Error('node is stopping')
      const request = allocationSchema.omit({ released: true, releasing: true, bootId: true }).parse(raw)
      const previous = allocations.get(id)
      if (previous !== undefined) {
        if (previous.deploymentId !== request.deploymentId || JSON.stringify(previous.node) !== JSON.stringify(request.node)) throw new Error('allocation content conflict')
        allocation(id)
        return { allocated: true }
      }
      if ([...allocations.entries()].some(([, row]) => !row.released)) throw new Error('node already belongs to another experiment')
      if (request.node.server.remoteRoot !== config.root) throw new Error('node root does not match the configured deployment')
      mkdirSync(workspace(id), { recursive: true, mode: 0o700 })
      if (request.node.devicePaths.some(path => !config.devicePaths.includes(path))) throw new Error('node request exceeds its granted GPU devices')
      await allocations.put(id, { ...request, released: false, releasing: false, bootId: config.bootId })
      return { allocated: true }
    })
    if (operation === 'release') {
      const saved = await serial(async () => {
        const current = allocations.get(id)
        if (current === undefined || current.released) return current
        const next = { ...current, releasing: true }
        await allocations.put(id, next)
        return next
      })
      if (saved === undefined || saved.released) return { released: true }
      if (saved.bootId !== config.bootId) return { released: false,
        detail: 'node restarted; process cleanup requires operator verification' }
      const owned = [...commands.entries()].filter(([, row]) => row.experimentId === id)
      for (const [key] of owned) handles.get(key)?.terminate()
      await Promise.all(owned.flatMap(([key]) => {
        const pending = settlements.get(key)
        return pending === undefined ? [] : [pending]
      }))
      return serial(async () => {
        const released = owned.every(([key]) => commands.get(key)?.released === true)
        if (released) {
          const server = netServers.get(id)
          if (server !== undefined) await new Promise<void>(resolveClose => server.close(() => { resolveClose() }))
          netServers.delete(id)
          await allocations.put(id, { ...saved, released: true })
        }
        return { released }
      })
    }
    if (operation === 'files') {
      const saved = allocations.get(id)
      return saved === undefined ? { files: [], truncated: false } : clusterFiles(workspace(id), saved.node.server.id, config.fileLimit)
    }
    if (operation === 'log' || operation === 'file') {
      const request = z.object({ offset: z.number().int().nonnegative(), generation: z.string().optional(),
        path: z.string().optional() }).parse(raw)
      const path = operation === 'log' ? logPath(id) : clusterPath(workspace(id), request.path ?? '')
      return readClusterChunk(path, request.offset, request.generation, config.chunkBytes, operation === 'file' ? workspace(id) : undefined)
    }
    if (operation === 'status') return [...commands.entries()].filter(([, row]) => row.experimentId === id).map(([,
      row]) => commandView(row))
    allocation(id)
    if (operation === 'verify-input') {
      const request = z.object({ name: z.string(), sha256: deploymentIdSchema }).parse(raw)
      const path = clusterPath(workspace(id), `inputs/${request.name}`)
      if (await clusterFileHash(path) !== request.sha256) throw new Error(`staged input digest mismatch: ${request.name}`)
      return { verified: true }
    }
    if (operation === 'input') {
      const request = z.object({ path: z.string(), data: z.string(), offset: z.number().int().nonnegative() }).parse(raw)
      const bytes = Buffer.from(request.data, 'base64')
      if (bytes.length > config.chunkBytes) throw new Error('input chunk exceeds the configured limit')
      mkdirSync(resolve(workspace(id), 'inputs'), { recursive: true })
      if (!request.path.startsWith('inputs/')) throw new Error('inputs must be stored under inputs/')
      const path = clusterPath(workspace(id), request.path)
      {
        const size = existsSync(path) ? statSync(path).size : 0
        if (size === request.offset) appendFileSync(path, bytes, { mode: 0o600 })
        else if (size >= request.offset + bytes.length) {
          const previous = Buffer.alloc(bytes.length)
          const fd = openSync(path, 'r')
          try { readSync(fd, previous, 0, previous.length, request.offset) } finally { closeSync(fd) }
          if (!previous.equals(bytes)) throw new Error('input retry contains different bytes')
        } else throw new Error('input offset does not match the staged file')
      }
      return { nextOffset: request.offset + bytes.length }
    }
    if (operation === 'listen') return serial(async () => {
      allocation(id)
      let server = netServers.get(id)
      if (server === undefined) {
        server = createServer((socket) => {
          socket.on('error', (error) => { ctx.logger.debug(`experiment network probe: ${String(error)}`) })
          socket.setTimeout(config.cleanupTimeoutMs, () => { socket.destroy() })
          socket.end(id)
        })
        await new Promise<void>((resolveReady, reject) => {
          const listener = server
          if (listener === undefined) throw new Error('network probe listener is missing')
          listener.once('error', reject)
          listener.listen(0, '0.0.0.0', resolveReady)
        })
        netServers.set(id, server)
      }
      return { port: (server.address() as AddressInfo).port }
    })
    if (operation === 'connect') {
      const peer = z.object({ host: z.string(), port: z.number().int().min(1).max(65535) }).parse(raw)
      await new Promise<void>((resolveConnected, reject) => {
        const socket = connect(peer.port, peer.host)
        socket.setTimeout(config.cleanupTimeoutMs, () => { socket.destroy(new Error('training network probe timed out')) })
        socket.once('error', reject)
        let reply = ''
        socket.on('data', (data) => { reply += String(data) })
        socket.once('end', () => { if (reply === id) resolveConnected(); else reject(new Error('training network probe reached a different experiment')) })
      })
      return { connected: true }
    }
    if (operation === 'run') return serial(async () => {
      const current = allocation(id)
      const request = clusterCommandSchema.parse({ commandId: input.commandId, command: input.command })
      const key = `${id}/${request.commandId}`
      const previous = commands.get(key)
      if (previous !== undefined) {
        if (previous.command !== request.command) throw new Error('command id is bound to different content')
        return commandView(previous)
      }
      if (closing) throw new Error('node is stopping')
      const row = { ...request, experimentId: id, state: 'starting' as const, exitCode: null, released: false }
      await commands.put(key, row)
      let handle: SubprocessHandle
      try {
        const confined = await ctx.sandbox.confine(['bash', '-c', request.command], {
          mode: 'workspace-write', workspaceRoot: workspace(id), devicePaths: current.node.devicePaths,
          hiddenPaths: [...new Set([...current.node.hiddenPaths, resolve(config.root, 'runs'), resolve(config.root,
            'secrets'), resolve(config.root, 'state')])],
        })
        handle = ctx.subprocess.spawn({ argv: confined.argv, cwd: workspace(id),
          env: { HOME: workspace(id), PYTHONUNBUFFERED: '1' }, graceMs: config.cleanupTimeoutMs,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
      } catch (error) {
        await commands.put(key, { ...row, state: 'failed', released: true, detail: String(error) })
        throw error
      }
      handles.set(key, handle)
      const append = (chunk: Buffer | string) => {
        try { appendFileSync(logPath(id), chunk, { mode: 0o600 }) }
        catch (error) { ctx.logger.error(`experiment log failed: ${String(error)}`); handle.terminate() }
      }
      append(`\n[${request.commandId}]\n`)
      handle.stdout?.on('data', append)
      handle.stderr?.on('data', append)
      const settled = finish(key, handle).catch((error: unknown) => { ctx.logger.error(`experiment node: ${String(error)}`) })
        .finally(() => { settlements.delete(key) })
      settlements.set(key, settled)
      try { await commands.put(key, { ...row, state: 'running' }) }
      catch (error) { handle.terminate(); throw error }
      return commandView({ ...row, state: 'running' })
    })
    throw new Error('unknown node operation')
  }
}
