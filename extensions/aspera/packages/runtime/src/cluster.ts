import type {} from '@deepseek-ai/cordis-plugin-loader'
/** Authenticated coordinator and node roles of the experiment-worker profile. */
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'
import { clusterRecordSchema, clusterSubmissionSchema, experimentIdSchema, serverIdSchema, questionIdSchema } from '@aspera/experiments'
import type { ClusterRecord, ExperimentId } from '@aspera/experiments'
import { ClusterQueue } from '@aspera/experiments'
import { createClusterNode } from './cluster-node.ts'
import { runClusterAgent } from './cluster-agent.ts'
import { readClusterChunk } from '@aspera/experiments'
import { clusterNodeRequest, readClusterPrivate, RemoteClusterExecutor, validateClusterAdmission, clusterRunRoot } from './cluster-runtime.ts'
import { serverRunRoot } from './storage.ts'
import type { ClusterRuntimeConfig } from './cluster-runtime.ts'

const storeSpec = defineDomain({ name: 'aspera_queue', version: 3, compatibleVersions: [1, 2], layout: 'per-record',
  tables: { experiments: domainTable<ExperimentId, ClusterRecord>(clusterRecordSchema) } })

/** Worker-profile role settings. */
export interface ClusterRoleConfig extends ClusterRuntimeConfig {
  role: 'coordinator' | 'node' | 'agent' | 'planner'
  tokenFile: string
  deploymentId: string
  backendPath: string
  hiddenPaths: string[]
  devicePaths: string[]
  experimentId?: string
  networkProbeLifetimeMs: number
  serviceRequestTimeoutMs: number
  serviceRequestBytes: number
}

/**
 * Mount one control or execution role under the worker profile.
 * @param ctx - profile services.
 * @param config - role, private paths, and explicit operation bounds.
 */
export async function applyClusterRole(ctx: Context, config: ClusterRoleConfig): Promise<void> {
  if (!isAbsolute(config.root) || !isAbsolute(config.tokenFile)) throw new Error('cluster root and token file must be absolute')
  mkdirSync(resolve(config.root, 'runs'), { recursive: true, mode: 0o700 })
  if (config.role === 'agent' || config.role === 'planner') {
    const id = experimentIdSchema.parse(config.experimentId)
    void (async () => {
      await ctx.get('loader')?.await()
      await runClusterAgent(ctx, config, id, config.role === 'planner')
    })().catch((error: unknown) => {
        ctx.logger.error(String(error))
        writeFileSync(resolve(clusterRunRoot(config.root, id), config.role === 'planner' ? 'planning-outcome.json' : 'outcome.json'), JSON.stringify({ state: 'failed', detail: String(error) }), { mode: 0o600 })
        process.kill(process.pid, 'SIGTERM')
      })
    return
  }
  const token = readFileSync(config.tokenFile, 'utf8').trim()
  if (token.length < 32) throw new Error('cluster token must contain at least 32 characters')
  const node = config.role === 'node' ? await createClusterNode(ctx, { ...config, bootId: randomUUID() }) : undefined
  const store = config.role === 'coordinator' ? await ctx.storage.domain.open(storeSpec) : undefined
  const queue = store === undefined ? undefined : new ClusterQueue(store.table('experiments'), new RemoteClusterExecutor(ctx, config),
    (error) => { ctx.logger.error(`experiment coordinator: ${String(error)}`) })
  if (queue !== undefined && store !== undefined) {
    mkdirSync(resolve(config.root, 'state'), { recursive: true, mode: 0o700 })
    writeFileSync(resolve(config.root, 'state', 'coordinator.generation'), randomUUID(), { mode: 0o600 })
    ctx.effect(() => async () => { await queue.close(); await store.close() }, 'experiment coordinator: queue')
    await queue.recover()
  }
  const refuseOrphan = (id: ExperimentId) => {
    const run = clusterRunRoot(config.root, id)
    if (['started.json', 'outcome.json', 'execution.json', 'planning-started.json'].some(name => existsSync(resolve(run, name)))) throw new Error('experiment execution evidence exists without its queue record; it requires operator reconciliation')
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/aspera', handler: async (req, res) => {
    const respond = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    const actual = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) { respond(401, { error: 'unauthorized' }); return }
    try {
      const requestedPath = new URL(req.url ?? '/', 'http://localhost').pathname
      if (!/^\/aspera\/v[123]\//.test(requestedPath)) { respond(404, { error: 'unsupported control protocol' }); return }
      const path = requestedPath.replace(/^\/aspera\/v[23]\//, '/aspera/v1/')
      if (req.method === 'GET' && path === '/aspera/v1/health') {
        respond(200, { protocol: 3, role: config.role, deploymentId: config.deploymentId, features: ['public-inference-v1'],
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
        if (!path.startsWith('/aspera/v1/node/')) { respond(404, { error: 'node route not found' }); return }
        respond(200, await node(path.slice('/aspera/v1/node/'.length), body))
        return
      }
      if (queue === undefined) throw new Error('coordinator is unavailable')
      if (path === '/aspera/v1/submit') {
        const submission = clusterSubmissionSchema.parse(body)
        if (queue.get(submission.experimentId) === undefined) {
          refuseOrphan(submission.experimentId)
          await validateClusterAdmission(config, submission)
        }
        respond(200, await queue.submit(submission))
        return
      }
      if (path === '/aspera/v1/list') { respond(200, queue.list()); return }
      const input = z.object({ experimentId: experimentIdSchema }).loose().parse(body)
      if (path === '/aspera/v1/cancel') {
        const submission = input.submission === undefined ? undefined : clusterSubmissionSchema.parse(input.submission)
        if (queue.get(input.experimentId) === undefined && submission !== undefined) {
          refuseOrphan(input.experimentId)
          await validateClusterAdmission(config, submission)
        }
        respond(200, await queue.cancel(input.experimentId, submission))
        return
      }
      const record = queue.get(input.experimentId)
      if (record === undefined) { respond(404, { error: 'experiment not found' }); return }
      if (path === '/aspera/v1/open-question') { respond(200, await queue.openQuestion(input.experimentId, input.question)); return }
      if (path === '/aspera/v1/answer-question') {
        const { experimentId: _id, ...reply } = input
        respond(200, await queue.answerQuestion(input.experimentId, reply)); return
      }
      if (path === '/aspera/v1/consume-question') {
        const { experimentId: _id, ...binding } = input
        respond(200, await queue.consumeQuestion(input.experimentId, binding)); return
      }
      if (path === '/aspera/v1/question') {
        const questionId = questionIdSchema.parse(input.questionId)
        const question = record.questions?.find(item => item.questionId === questionId)
        if (question === undefined) throw new Error('question does not belong to this experiment')
        respond(200, question); return
      }
      if (path === '/aspera/v1/approve') {
        const approved = z.object({ revision: z.number().int().positive() }).parse(body)
        respond(200, await queue.approve(input.experimentId, approved.revision)); return
      }
      if (path === '/aspera/v1/stop-service' || path === '/aspera/v1/access-service' || path === '/aspera/v1/service-access-info') {
        const request = z.object({ serviceId: z.string().uuid() }).parse(body)
        const service = record.services.find(service => service.id === request.serviceId)
        if (service === undefined) throw new Error('service does not belong to this experiment')
        respond(200, await clusterNodeRequest(readClusterPrivate(config.root, input.experimentId), service.serverId,
          path.slice('/aspera/v1/'.length), input)); return
      }
      if (path === '/aspera/v1/status') { respond(200, { record, waitingFor: queue.waitingFor(input.experimentId) }); return }
      const operation = path.slice('/aspera/v1/'.length)
      if (operation === 'events' || operation === 'agent-log') {
        const cursor = z.object({ offset: z.number().int().nonnegative(), generation: z.string().optional() }).parse(body)
        respond(200, readClusterChunk(resolve(serverRunRoot(record.submission.coordinator, input.experimentId),
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
