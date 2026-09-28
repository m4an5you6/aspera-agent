/** Authenticated coordinator and node roles of the experiment-worker profile. */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { clusterRecordSchema, clusterSubmissionSchema, experimentIdSchema, serverIdSchema } from './cluster-protocol.ts'
import type { ClusterRecord, ExperimentId } from './cluster-protocol.ts'
import { ClusterQueue } from './cluster-queue.ts'
import { createClusterNode } from './cluster-node.ts'
import { runClusterAgent } from './cluster-agent.ts'
import { readClusterChunk } from './cluster-files.ts'
import { clusterNodeRequest, readClusterPrivate, RemoteClusterExecutor, validateClusterAdmission } from './cluster-runtime.ts'
import type { ClusterRuntimeConfig } from './cluster-runtime.ts'

const storeSpec = defineDomain({ name: 'experiment_cluster_queue', version: 1, layout: 'per-record',
  tables: { experiments: domainTable<ExperimentId, ClusterRecord>(clusterRecordSchema) } })

/** Worker-profile role settings. */
export interface ClusterRoleConfig extends ClusterRuntimeConfig {
  role: 'coordinator' | 'node' | 'agent'
  tokenFile: string
  deploymentId: string
  devicePaths: readonly string[]
  experimentId?: string
}

/**
 * Mount one control or execution role under the worker profile.
 * @param ctx - profile services.
 * @param config - role, private paths, and explicit operation bounds.
 */
export async function applyClusterRole(ctx: Context, config: ClusterRoleConfig): Promise<void> {
  if (!isAbsolute(config.root) || !isAbsolute(config.tokenFile)) throw new Error('cluster root and token file must be absolute')
  mkdirSync(resolve(config.root, 'runs'), { recursive: true, mode: 0o700 })
  if (config.role === 'agent') {
    await runClusterAgent(ctx, config, experimentIdSchema.parse(config.experimentId))
    return
  }
  const token = readFileSync(config.tokenFile, 'utf8').trim()
  if (token.length < 32) throw new Error('cluster token must contain at least 32 characters')
  const node = config.role === 'node' ? await createClusterNode(ctx, { ...config, bootId: randomUUID() }) : undefined
  const store = config.role === 'coordinator' ? await ctx.storageDomain.open(storeSpec) : undefined
  const queue = store === undefined ? undefined : new ClusterQueue(store.table('experiments'), new RemoteClusterExecutor(ctx, config),
    (error) => { ctx.logger.error(`experiment coordinator: ${String(error)}`) })
  if (queue !== undefined && store !== undefined) {
    mkdirSync(resolve(config.root, 'state'), { recursive: true, mode: 0o700 })
    writeFileSync(resolve(config.root, 'state', 'coordinator.generation'), randomUUID(), { mode: 0o600 })
    ctx.effect(() => async () => { await queue.close(); await store.close() }, 'experiment coordinator: queue')
    await queue.recover()
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/experiment/v2', handler: async (req, res) => {
    const respond = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const actual = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { respond(401, { error: 'unauthorized' }); return }
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      if (req.method === 'GET' && path === '/experiment/v2/health') {
        respond(200, { protocol: 2, role: config.role, deploymentId: config.deploymentId,
          ...(node === undefined ? {} : { node: await node('health', {}) }) })
        return
      }
      if (req.method !== 'POST') { respond(405, { error: 'POST required' }); return }
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of req) {
        const bytes = Buffer.from(chunk as Uint8Array)
        size += bytes.length
        if (size > 1_048_576) throw new Error('cluster request exceeds 1 MiB')
        chunks.push(bytes)
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (node !== undefined) {
        if (!path.startsWith('/experiment/v2/node/')) { respond(404, { error: 'node route not found' }); return }
        respond(200, await node(path.slice('/experiment/v2/node/'.length), body))
        return
      }
      if (queue === undefined) throw new Error('coordinator is unavailable')
      if (path === '/experiment/v2/submit') {
        const submission = clusterSubmissionSchema.parse(body)
        await validateClusterAdmission(config, submission)
        respond(200, await queue.submit(submission))
        return
      }
      if (path === '/experiment/v2/list') { respond(200, queue.list()); return }
      const input = z.object({ experimentId: experimentIdSchema }).loose().parse(body)
      if (path === '/experiment/v2/cancel') {
        const submission = input.submission === undefined ? undefined : clusterSubmissionSchema.parse(input.submission)
        if (queue.get(input.experimentId) === undefined && submission !== undefined) await validateClusterAdmission(config, submission)
        respond(200, await queue.cancel(input.experimentId, submission))
        return
      }
      const record = queue.get(input.experimentId)
      if (record === undefined) { respond(404, { error: 'experiment not found' }); return }
      if (path === '/experiment/v2/status') { respond(200, { record, waitingFor: queue.waitingFor(input.experimentId) }); return }
      const operation = path.slice('/experiment/v2/'.length)
      if (operation === 'events' || operation === 'agent-log') {
        const cursor = z.object({ offset: z.number().int().nonnegative(), generation: z.string().optional() }).parse(body)
        respond(200, readClusterChunk(resolve(config.root, 'runs', input.experimentId,
          operation === 'events' ? 'events.jsonl' : 'agent.log'),
        cursor.offset, cursor.generation, config.chunkBytes))
        return
      }
      if (operation === 'files' || operation === 'file' || operation === 'log') {
        const target = z.object({ serverId: serverIdSchema }).parse(body)
        respond(200, await clusterNodeRequest(readClusterPrivate(config.root, input.experimentId), target.serverId, operation, input))
        return
      }
      respond(404, { error: 'cluster route not found' })
    } catch (error) { respond(400, { error: error instanceof Error ? error.message : String(error) }) }
  } }), 'experiment cluster: authenticated control routes')
}
