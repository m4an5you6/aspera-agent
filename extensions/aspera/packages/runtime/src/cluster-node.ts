/** A node owns one experiment allocation and confined process ranges independently of SSH connections. */
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer, connect } from 'node:net'
import type { AddressInfo, Server } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-sandbox'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { budgetSchema, clusterCommandResultSchema, clusterCommandSchema, clusterNodeSchema, legacyClusterNodeSchema, deploymentIdSchema, experimentIdSchema, serviceSchema, serviceIdSchema } from '@aspera/experiments'
import type { ClusterCommandResult, ClusterNode, ExperimentId, InferenceService } from '@aspera/experiments'
import { clusterFiles, clusterPath, readClusterChunk } from '@aspera/experiments'
import { clusterFileHash } from './cluster-runtime.ts'
import { serverRunRoot } from './storage.ts'
import { verifyStorage } from '../scripts/storage.mjs'
import { NetworkProbes } from './network-probes.ts'
import { openInferenceGateway } from './inference-gateway.ts'
import type { InferenceGateway } from './inference-gateway.ts'
import { processLogRequestSchema } from '@aspera/experiments'

const allocationObject = z.object({ experimentId: experimentIdSchema, deploymentId: deploymentIdSchema,
  node: z.union([clusterNodeSchema, legacyClusterNodeSchema]).transform((node): ClusterNode => node), protocol: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(), budget: budgetSchema.optional(), deadline: z.number().int().optional(), released: z.boolean(), releasing: z.boolean().default(false), bootId: z.string() }).strict()
const allocationPolicy = (value: Pick<z.infer<typeof allocationObject>, 'protocol' | 'budget' | 'deadline'>) =>
  value.protocol === 2 || value.protocol === 3 || value.protocol === 4 ? value.budget === undefined && value.deadline === undefined : value.budget !== undefined && value.deadline !== undefined
const allocationSchema = allocationObject.refine(allocationPolicy, 'allocation execution policy is incomplete')
const allocationRequestSchema = allocationObject.omit({ released: true, releasing: true, bootId: true }).refine(allocationPolicy, 'allocation execution policy is incomplete')
const commandSchema = clusterCommandResultSchema.extend({ experimentId: experimentIdSchema, command: z.string() })
function commandView(row: z.infer<typeof commandSchema>): ClusterCommandResult {
  return { commandId: row.commandId, state: row.state, exitCode: row.exitCode, released: row.released,
    ...(row.detail === undefined ? {} : { detail: row.detail }) }
}
const storeSpec = defineDomain({ name: 'aspera_node', version: 4, compatibleVersions: [1, 2, 3], layout: 'per-record', tables: {
  allocations: domainTable<ExperimentId, z.infer<typeof allocationSchema>>(allocationSchema),
  commands: domainTable<string, z.infer<typeof commandSchema>>(commandSchema),
  services: domainTable<string, InferenceService>(serviceSchema),
} })

/** Configured bounds for a node control process. */
export interface ClusterNodeConfig {
  root: string
  bootId: string
  backendPath: string
  hiddenPaths: string[]
  chunkBytes: number
  fileLimit: number
  cleanupTimeoutMs: number
  serviceRequestTimeoutMs: number
  serviceRequestBytes: number
  devicePaths: readonly string[]
  networkProbeLifetimeMs?: number
}

/**
 * Own durable node allocations and confined managed processes.
 * @param ctx - confined subprocess provider.
 * @param config - node-owned paths and limits.
 * @returns effect-owned node request handler.
 */
export async function createClusterNode(ctx: Context, config: ClusterNodeConfig): Promise<(operation: string,
  raw: unknown) => Promise<unknown>> {
  const store = await ctx.storage.domain.open(storeSpec)
  const allocations = store.table('allocations')
  const commands = store.table('commands')
  const services = store.table('services')
  const gateways = new Map<string, InferenceGateway>()
  const stopGateway = async (id: string) => {
    const gateway = gateways.get(id)
    if (gateway !== undefined) { await gateway.close(); gateways.delete(id) }
  }
  const stoppedExposure = (service: InferenceService) => service.external === undefined ? {} : {
    external: { ...service.external, state: 'stopped' as const, checkedAt: Date.now(), detail: undefined },
  }
  const handles = new Map<string, SubprocessHandle>()
  const settlements = new Map<string, Promise<void>>()
  let chain: Promise<void> = Promise.resolve()
  let closing = false
  const netServers = new Map<ExperimentId, Server>()
  const network = new NetworkProbes(config.networkProbeLifetimeMs ?? config.cleanupTimeoutMs, config.cleanupTimeoutMs)
  const deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  const serial = <T>(operation: () => Promise<T>): Promise<T> => {
    const pending = chain.then(operation)
    chain = pending.then(() => {}, () => {})
    return pending
  }
  const runRoot = (id: ExperimentId) => {
    const saved = allocations.get(id)
    if (saved === undefined) throw new Error('Experiment has no saved directory assignment')
    return serverRunRoot(saved.node.server, id)
  }
  const workspace = (id: ExperimentId) => resolve(runRoot(id), 'workspace')
  const logPath = (id: ExperimentId) => resolve(runRoot(id), 'node.log')
  const processLogPath = (id: ExperimentId, commandId: string, stream: 'stdout' | 'stderr') => resolve(runRoot(id), 'process-logs', commandId, `${stream}.log`)
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
      for (const [serviceId, service] of services.entries()) {
        if (`${service.experimentId}/${service.commandId}` !== key) continue
        await stopGateway(serviceId)
        await services.put(serviceId, { ...service, updatedAt: Date.now(), released: patch.released === true,
          ...stoppedExposure(service),
          state: service.state === 'stopping' && patch.released ? 'stopped' : 'failed',
          detail: service.state === 'stopping' && patch.released ? undefined : 'Inference process exited; it is not restarted automatically.' })
      }
      if (patch.released) handles.delete(key)
    })
    if (patch.released) { clearTimeout(deadlines.get(key)); deadlines.delete(key) }
  }
  ctx.effect(() => async () => {
    closing = true
    await network.close()
    await chain
    await Promise.all([...gateways.keys()].map(stopGateway))
    for (const handle of handles.values()) handle.terminate()
    for (const timer of deadlines.values()) clearTimeout(timer)
    await Promise.all([...netServers.values()].map(server => new Promise<void>((done) => { server.close(() => { done() }) })))
    await Promise.all(settlements.values())
    await chain
    await store.close()
  }, 'experiment node: processes and allocation records')

  return async (operation: string, raw: unknown): Promise<unknown> => {
    if (operation.startsWith('probe-network-')) return network.request(operation, raw)
    if (operation === 'health') return { allocations: [...allocations.entries()].filter(([, row]) => !row.released).map(([id]) => id) }
    const input = z.object({ experimentId: experimentIdSchema }).loose().parse(raw)
    const id = input.experimentId
    if (operation === 'allocate') return serial(async () => {
      if (closing) throw new Error('node is stopping')

      const request = allocationRequestSchema.parse(raw)
      if (request.protocol === 3 || request.protocol === 4) {
        const placement = request.node.server.storagePlacement
        if (placement === undefined) throw new Error('Protocol 3 requires a saved storage assignment')
        if (placement.serverId !== request.node.server.id || placement.experimentId !== id || !placement.releaseRoot.endsWith('/' + request.deploymentId)) {
          throw new Error('Storage assignment belongs to another node, experiment or release')
        }
        verifyStorage(placement)
      }
      const previous = allocations.get(id)
      if (previous !== undefined) {
        if (previous.deploymentId !== request.deploymentId || JSON.stringify(previous.node) !== JSON.stringify(request.node)
          || previous.protocol !== request.protocol || JSON.stringify(previous.budget) !== JSON.stringify(request.budget) || previous.deadline !== request.deadline) throw new Error('allocation content conflict')
        allocation(id)
        return { allocated: true }
      }
      if ([...allocations.entries()].some(([, row]) => !row.released)) throw new Error('node already belongs to another experiment')
      if (request.node.server.remoteRoot !== config.root) throw new Error('node root does not match the configured deployment')
      if (request.node.backendPath !== config.backendPath) throw new Error('sandbox backend differs from node policy')
      if (config.hiddenPaths.some(path => !request.node.hiddenPaths.includes(path))) throw new Error('private directories differ from node policy')
      mkdirSync(resolve(serverRunRoot(request.node.server, id), 'workspace'), { recursive: true, mode: 0o700 })
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
        for (const [serviceId, service] of services.entries()) {
          if (service.experimentId === id && !service.released) {
            await stopGateway(serviceId)
            await services.put(serviceId, { ...service, ...stoppedExposure(service), state: 'stopping', updatedAt: Date.now() })
          }
        }
        return next
      })
      if (saved === undefined || saved.released) return { released: true }
      const owned = [...commands.entries()].filter(([, row]) => row.experimentId === id)
      if (saved.bootId !== config.bootId) return serial(async () => {
        if (owned.some(([, command]) => !command.released)) return { released: false,
          detail: 'node restarted; process cleanup requires operator verification' }
        await allocations.put(id, { ...saved, released: true })
        return { released: true }
      })
      for (const [key] of owned) handles.get(key)?.terminate()
      await Promise.all(owned.flatMap(([key]) => {
        const pending = settlements.get(key)
        return pending === undefined ? [] : [pending]
      }))
      await Promise.all(owned.map(([key]) => verifyCleanup(key)))
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
    if (operation === 'processes') {
      const saved = allocations.get(id)
      if (saved === undefined) return []
      return [...commands.entries()].filter(([, row]) => row.experimentId === id).map(([, row]) => ({
        ...commandView(row), experimentId: id, serverId: saved.node.server.id, command: row.command,
        streams: (['stdout', 'stderr'] as const).filter(stream => existsSync(processLogPath(id, row.commandId, stream))) }))
    }
    if (operation === 'process-log') {
      const request = processLogRequestSchema.parse(raw)
      const saved = allocations.get(id)
      if (saved?.node.server.id !== request.serverId || commands.get(`${id}/${request.commandId}`) === undefined) throw new Error('Process log belongs to another experiment or node')
      const cursor = request.cursor
      if (cursor !== undefined && (cursor.experimentId !== id || cursor.serverId !== request.serverId || cursor.commandId !== request.commandId || cursor.stream !== request.stream)) throw new Error('Log cursor belongs to another experiment, node, process or stream')
      const path = processLogPath(id, request.commandId, request.stream)
      const chunk = readClusterChunk(path, cursor?.offset ?? 0, cursor?.generation, config.chunkBytes)
      return { chunk, missing: chunk.generation === '', cursor: { experimentId: id, serverId: request.serverId,
        commandId: request.commandId, stream: request.stream, generation: chunk.generation, offset: chunk.nextOffset } }
    }
    if (operation === 'log' || operation === 'file') {
      const request = z.object({ offset: z.number().int().nonnegative(), generation: z.string().optional(),
        path: z.string().optional() }).parse(raw)
      const path = operation === 'log' ? logPath(id) : clusterPath(workspace(id), request.path ?? '')
      return readClusterChunk(path, request.offset, request.generation, config.chunkBytes, operation === 'file' ? workspace(id) : undefined)
    }
    if (operation === 'services') {
      const rows = [...services.entries()].filter(([, row]) => row.experimentId === id)
      for (const [key, service] of rows) {
        if (service.released || ['failed', 'interrupted', 'stopped'].includes(service.state)) continue
        const saved = allocations.get(id)
        if (saved?.bootId !== config.bootId || !handles.has(`${id}/${service.commandId}`)) {
          await serial(async () => {
            const current = services.get(key)
            if (current === undefined || current.released || !['starting', 'healthy', 'unhealthy'].includes(current.state)) return
            await services.put(key, { ...current, ...stoppedExposure(current), state: 'interrupted', detail: 'Service process identity cannot be verified after node restart.', updatedAt: Date.now() })
          })
          continue
        }
        if (service.deadline !== undefined && service.deadline <= Date.now()) {
          await stopService(service)
          continue
        }
        let state: InferenceService['state'] = 'unhealthy'
        try {
          const response = await fetch(`http://127.0.0.1:${service.port}${service.healthPath}`, { signal: AbortSignal.timeout(config.cleanupTimeoutMs), redirect: 'error' })
          state = response.ok ? 'healthy' : 'unhealthy'
          await response.body?.cancel()
        } catch (error) { ctx.logger.debug(`Aspera service health: ${String(error)}`) }
        const gateway = gateways.get(key)
        const external = gateway === undefined ? service.external : await gateway.probe()
        await serial(async () => {
          const current = services.get(key)
          if (current === undefined || current.released || !['starting', 'healthy', 'unhealthy'].includes(current.state)
            || !handles.has(`${id}/${current.commandId}`) || allocations.get(id)?.releasing) return
          await services.put(key, { ...current, state, ...(external === undefined ? {} : { external }), updatedAt: Date.now() })
        })
      }
      return [...services.entries()].filter(([, row]) => row.experimentId === id).map(([, row]) => row)
    }
    if (operation === 'service-access-info') {
      const request = z.object({ serviceId: serviceIdSchema }).parse(raw)
      const service = services.get(request.serviceId)
      const gateway = gateways.get(request.serviceId)
      allocation(id)
      if (service?.experimentId !== id || service.released || gateway === undefined) throw new Error('Public service is not active in this experiment')
      return gateway.access()
    }
    if (operation === 'stop-service') {
      const request = z.object({ serviceId: serviceIdSchema }).parse(raw)
      const service = services.get(request.serviceId)
      if (service?.experimentId !== id) throw new Error('service is outside this experiment')
      return stopService(service)
    }
    if (operation === 'access-service') {
      const request = z.object({ serviceId: serviceIdSchema, path: z.string().max(2048), method: z.enum(['GET', 'POST']), body: z.string().max(65536).optional() }).parse(raw)
      const service = services.get(request.serviceId)
      if (service?.experimentId !== id || service.state !== 'healthy' || service.released) throw new Error('service is not healthy in this experiment')
      if (!request.path.startsWith('/') || request.path.startsWith('//') || /[\\\\\r\n]/.test(request.path)) throw new Error('service path must be a relative HTTP path')
      allocation(id)
      const response = await fetch(`http://127.0.0.1:${service.port}${request.path}`, { method: request.method, body: request.body,
        headers: request.body === undefined ? {} : { 'content-type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(config.cleanupTimeoutMs) })
      let bytes = 0
      const chunks: Buffer[] = []
      try {
        if (response.body !== null) for await (const chunk of response.body) {
          bytes += chunk.length
          if (bytes > config.chunkBytes) throw new Error('service response exceeds the configured byte limit')
          chunks.push(Buffer.from(chunk))
        }
      } finally { if (response.body !== null && !response.body.locked) await response.body.cancel() }
      return { status: response.status, contentType: response.headers.get('content-type'), body: Buffer.concat(chunks).toString('utf8') }
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
      const placement = allocation(id).node.server.storagePlacement
      if (placement !== undefined) verifyStorage(placement, bytes.length)
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
    if (operation === 'register-service') return serial(async () => {
      const { publish, ...request } = serviceSchema.omit({ serverId: true, commandId: true, state: true, createdAt: true, updatedAt: true, released: true, detail: true, deadline: true, external: true })
        .extend({ publish: z.boolean().optional() }).parse(raw)
      const current = allocation(id)
      if (request.healthPath.startsWith('//') || /[\\\r\n#]/.test(request.healthPath)) throw new Error('Health check requires a relative HTTP path')
      const mapping = publish === true ? current.node.server.inferenceMapping : undefined
      if (publish === true && mapping === undefined) throw new Error('This experiment has no saved external inference mapping for the node')
      if (mapping !== undefined && [request.port, current.node.server.remotePort, current.node.server.remotePort + 1, current.node.server.sshPort].includes(mapping.port)) {
        throw new Error('Mapped inference port must differ from the model, SSH and control ports')
      }
      clusterPath(workspace(id), request.modelPath)
      const previous = services.get(request.id)
      if (previous !== undefined) {
        if (previous.experimentId !== id || previous.command !== request.command || previous.port !== request.port
          || previous.modelPath !== request.modelPath || previous.healthPath !== request.healthPath || previous.modelName !== request.modelName
          || (previous.external !== undefined) !== (mapping !== undefined)) throw new Error('service id is bound to different content')
        return previous
      }
      if ([...services.entries()].some(([, service]) => !service.released && service.port === request.port)) throw new Error('service port belongs to another managed process')
      const probe = createServer()
      await new Promise<void>((ready, reject) => {
        probe.once('error', reject)
        probe.listen({ port: request.port, host: '127.0.0.1', exclusive: true }, ready)
      }).catch((error: unknown) => { throw new Error('service port is already occupied; select an unused loopback port', { cause: error }) })
      await new Promise<void>((done, reject) => { probe.close(error => { if (error !== undefined) reject(error); else done() }) })
      const service: InferenceService = { ...request, experimentId: id, serverId: current.node.server.id, commandId: `service-${request.id}`,
        state: 'starting', createdAt: Date.now(), updatedAt: Date.now(),
        ...(mapping === undefined ? {} : { external: { ...mapping, state: 'unchecked' } }),
        ...(current.budget === undefined ? {} : { deadline: Date.now() + current.budget.maxServiceSeconds * 1000 }), released: false }
      await services.put(service.id, service)
      try {
        if (mapping !== undefined) gateways.set(service.id, await openInferenceGateway(service, {
          root: config.root, healthTimeoutMs: config.cleanupTimeoutMs, requestTimeoutMs: config.serviceRequestTimeoutMs, requestBytes: config.serviceRequestBytes,
        }, () => !closing && handles.has(`${id}/${service.commandId}`) && allocations.get(id)?.releasing === false))
        await launchOwned(id, { commandId: service.commandId, command: service.command }, service.deadline)
      } catch (error) {
        await stopGateway(service.id)
        await services.put(service.id, { ...service, ...stoppedExposure(service), state: 'failed', released: commands.get(`${id}/${service.commandId}`)?.released ?? true, detail: String(error) }); throw error
      }
      return service
    })
    if (operation === 'run') return launch(id, { commandId: input.commandId, command: input.command })
    throw new Error('unknown node operation')
  }

  async function stopService(service: InferenceService): Promise<InferenceService> {
    const key = `${service.experimentId}/${service.commandId}`
    const pending = await serial(async () => {
      const current = services.get(service.id)
      if (current === undefined) throw new Error('managed service record is missing')
      if (current.released || allocations.get(current.experimentId)?.bootId !== config.bootId) return { done: undefined }
      const handle = handles.get(key)
      if (handle === undefined) return { done: undefined }
      if (current.state !== 'stopping') {
        await stopGateway(current.id)
        await services.put(current.id, { ...current, ...stoppedExposure(current), state: 'stopping', updatedAt: Date.now() })
        handle.terminate()
      }
      return { done: settlements.get(key) }
    })
    await pending.done
    await verifyCleanup(key)
    const current = services.get(service.id)
    if (current === undefined) throw new Error('managed service record is missing')
    return current
  }

  async function verifyCleanup(key: string): Promise<void> {
    const handle = handles.get(key)
    if (handle === undefined || commands.get(key)?.released) return
    if (!await handle.waitForExit(AbortSignal.timeout(config.cleanupTimeoutMs))) return
    await serial(async () => {
      const command = commands.get(key)
      if (command === undefined) throw new Error('managed cleanup record is missing')
      await commands.put(key, { ...command, released: true })
      for (const [id, service] of services.entries()) if (`${service.experimentId}/${service.commandId}` === key) {
        await services.put(id, { ...service, released: true, updatedAt: Date.now(), state: service.state === 'stopping' ? 'stopped' : 'failed' })
      }
      handles.delete(key); clearTimeout(deadlines.get(key)); deadlines.delete(key)
    })
  }

  function launch(id: ExperimentId, raw: unknown, serviceDeadline?: number): Promise<ClusterCommandResult> {
    return serial(() => launchOwned(id, raw, serviceDeadline))
  }

  async function launchOwned(id: ExperimentId, raw: unknown, serviceDeadline?: number): Promise<ClusterCommandResult> {
      const current = allocation(id)
      const request = clusterCommandSchema.parse(raw)
      const key = `${id}/${request.commandId}`
      const previous = commands.get(key)
      if (previous !== undefined) {
        if (previous.command !== request.command) throw new Error('command id is bound to different content')
        return commandView(previous)
      }
      if (closing) throw new Error('node is stopping')
      if (current.deadline !== undefined && current.deadline <= Date.now() && serviceDeadline === undefined) throw new Error('experiment runtime budget expired')
      if (current.budget !== undefined && [...commands.entries()].filter(([, row]) => row.experimentId === id).length >= current.budget.maxCommands) throw new Error('node command budget exhausted')
      if (current.node.server.storagePlacement !== undefined) verifyStorage(current.node.server.storagePlacement)
      const row = { ...request, experimentId: id, state: 'starting' as const, exitCode: null, released: false }
      await commands.put(key, row)
      let handle: SubprocessHandle
      try {
        mkdirSync(resolve(runRoot(id), 'process-logs', request.commandId), { recursive: true, mode: 0o700 })
        for (const stream of ['stdout', 'stderr'] as const) appendFileSync(processLogPath(id, request.commandId, stream), '', { mode: 0o600 })
        const argv = [current.node.backendPath, '--ro-bind', '/', '/', '--unshare-user', '--unshare-pid', '--unshare-ipc',
          '--unshare-uts', '--die-with-parent', '--new-session', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--clearenv',
          '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin', '--setenv', 'HOME', workspace(id), '--setenv', 'PYTHONUNBUFFERED', '1']
        for (const path of current.node.devicePaths) argv.push('--dev-bind', path, path)
        const hidden = [...config.hiddenPaths, ...current.node.hiddenPaths, config.root]
        const storageRoots = resolve(config.root, 'state', 'storage-roots')
        if (existsSync(storageRoots)) for (const name of readdirSync(storageRoots)) {
          const owner = z.object({ namespaceRoot: z.string() }).parse(JSON.parse(readFileSync(resolve(storageRoots, name, '.aspera-owner.json'), 'utf8')))
          hidden.push(owner.namespaceRoot)
        }
        const roots = [...new Set(hidden)].sort((a, b) => a.length - b.length)
        for (const path of roots.filter(path => !roots.some(parent => path !== parent && path.startsWith(parent + '/')))) argv.push('--tmpfs', path)
        for (const [name, value] of Object.entries({ XDG_CACHE_HOME: resolve(workspace(id), 'cache'), HF_HOME: resolve(workspace(id), 'cache', 'huggingface'),
          PIP_CACHE_DIR: resolve(workspace(id), 'cache', 'pip'), UV_CACHE_DIR: resolve(workspace(id), 'cache', 'uv'),
          TORCH_HOME: resolve(workspace(id), 'cache', 'torch'), UV_PROJECT_ENVIRONMENT: resolve(workspace(id), 'env'),
          CONDA_PKGS_DIRS: resolve(workspace(id), 'cache', 'conda'), CONDA_ENVS_PATH: resolve(workspace(id), 'envs'), TMPDIR: resolve(workspace(id), 'tmp') })) argv.push('--setenv', name, value)
        argv.push('--bind', workspace(id), workspace(id), '--chdir', workspace(id), '--', 'bash', '-c', request.command)
        handle = ctx.subprocess.spawn({ argv, cwd: workspace(id),
          env: { HOME: workspace(id), PYTHONUNBUFFERED: '1' }, graceMs: config.cleanupTimeoutMs,
          stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
      } catch (error) {
        await commands.put(key, { ...row, state: 'failed', released: true, detail: String(error) })
        throw error
      }
      handles.set(key, handle)
      const deadline = serviceDeadline ?? current.deadline
      if (deadline !== undefined) deadlines.set(key, setTimeout(() => { handle.terminate() }, Math.min(Math.max(1, deadline - Date.now()), 2_147_483_647)))
      const append = (chunk: Buffer | string, stream?: 'stdout' | 'stderr') => {
        try {
          appendFileSync(logPath(id), chunk, { mode: 0o600 })
          if (stream !== undefined) appendFileSync(processLogPath(id, request.commandId, stream), chunk, { mode: 0o600 })
        }
        catch (error) { ctx.logger.error(`experiment log failed: ${String(error)}`); handle.terminate() }
      }
      append(`\n[${request.commandId}]\n`)
      handle.stdout?.on('data', (chunk: Buffer) => { append(chunk, 'stdout') })
      handle.stderr?.on('data', (chunk: Buffer) => { append(chunk, 'stderr') })
      const settled = finish(key, handle).catch((error: unknown) => { ctx.logger.error(`experiment node: ${String(error)}`) })
        .finally(() => { settlements.delete(key) })
      settlements.set(key, settled)
      try { await commands.put(key, { ...row, state: 'running' }) }
      catch (error) { handle.terminate(); throw error }
      return commandView({ ...row, state: 'running' })
  }
}
