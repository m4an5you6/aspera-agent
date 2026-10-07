import type {} from '@deepseek-ai/cordis-plugin-loader'
/** Authenticated coordinator and node roles of the experiment-worker profile. */
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
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
import { readPhaseRecords } from './records.ts'
import { agentRecordRequestSchema, traceEventReadSchema } from '@aspera/experiments'
import { observationReadSchema, observationSourceSchema, metricReadSchema, metricSampleSchema } from '@aspera/experiments'
import { observationSources, readObservation } from './observations.ts'
import { readMetricSamples } from './metrics.ts'
import { readTraceAttachment } from './trace-attachments.ts'
import { executionStepReportSchema } from '@aspera/experiments'
import { ExecutionProgressStore } from './execution-progress.ts'

const storeSpec = defineDomain({ name: 'aspera_queue', version: 4, compatibleVersions: [1, 2, 3], layout: 'per-record',
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
        writeFileSync(resolve(clusterRunRoot(config.root, id), config.role === 'planner' ? 'planning-outcome.json' : 'outcome.json'), JSON.stringify({ state: 'failed', detail: `${config.role === 'planner' ? 'planning' : 'execution'}: ${String(error)}` }), { mode: 0o600 })
        process.kill(process.pid, 'SIGTERM')
      })
    return
  }
  const token = readFileSync(config.tokenFile, 'utf8').trim()
  const executionProgress = new ExecutionProgressStore(config.root)
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
      if (!/^\/aspera\/v[1234]\//.test(requestedPath)) { respond(404, { error: 'unsupported control protocol' }); return }
      const path = requestedPath.replace(/^\/aspera\/v[234]\//, '/aspera/v1/')
      if (req.method === 'GET' && path === '/aspera/v1/health') {
        respond(200, { protocol: 4, role: config.role, deploymentId: config.deploymentId, features: ['public-inference-v1'],
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
      if (path === '/aspera/v1/execution-progress') {
        const progress = executionProgress.read(record)
        respond(200, { supported: true, ...(progress === undefined ? {} : { progress }) }); return
      }
      if (path === '/aspera/v1/report-execution-step') {
        respond(200, executionProgress.report(record, executionStepReportSchema.parse(body))); return
      }
      const operation = path.slice('/aspera/v1/'.length)
      if (operation === 'observation-capabilities') { respond(200, { version: 1, completeEvents: true, logs: true, metrics: true }); return }
      if (operation === 'observation-sources') {
        const target = z.object({ serverId: serverIdSchema }).parse(body)
        const runtime = readClusterPrivate(config.root, input.experimentId)
        if (!runtime.submission.nodes.some(node => node.server.id === target.serverId)) throw new Error('Observation node is outside the experiment')
        const local = target.serverId === runtime.submission.coordinator.id ? observationSources(serverRunRoot(runtime.submission.coordinator, input.experimentId)).filter(source => source.kind === 'agent') : []
        const remote = z.array(observationSourceSchema).parse(await clusterNodeRequest(runtime, target.serverId, operation, input))
        respond(200, [...new Map([...local, ...remote].map(source => [source.id, source])).values()]); return
      }
      if (operation === 'observation-read') {
        const query = observationReadSchema.parse(body)
        const runtime = readClusterPrivate(config.root, input.experimentId)
        if (query.sourceId.startsWith('agent-') && query.serverId === runtime.submission.coordinator.id) {
          respond(200, readObservation(serverRunRoot(runtime.submission.coordinator, input.experimentId), query)); return
        }
        respond(200, await clusterNodeRequest(runtime, query.serverId, operation, input)); return
      }
      if (operation === 'observation-metrics') {
        const query = metricReadSchema.parse(body)
        const runtime = readClusterPrivate(config.root, input.experimentId)
        const samples = z.array(metricSampleSchema).parse(await clusterNodeRequest(runtime, query.serverId, operation, input))
        const training = query.serverId === runtime.submission.coordinator.id ? readMetricSamples(serverRunRoot(runtime.submission.coordinator, input.experimentId), query, 'training') : []
        respond(200, [...samples, ...training].sort((a, b) => a.time - b.time)); return
      }
      if (operation === 'trace-event' || operation === 'trace-attachment') {
        const attachment = operation === 'trace-attachment' ? z.object({ attachmentId: z.string(), offset: z.number().int().nonnegative() }).parse(body) : undefined
        const query = traceEventReadSchema.parse(operation === 'trace-attachment' ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'attachmentId')) : body)
        const sessionId = query.phase === 'planning' ? record.planningSessionId : record.sessionId
        const sourceId = sessionId ?? `aspera-${query.phase === 'planning' ? 'plan' : 'execution'}-${input.experimentId}`
        if (query.phase === 'preparation' || query.sessionId !== sourceId) throw new Error('Event belongs to another phase or Session')
        const page = await readPhaseRecords(resolve(serverRunRoot(record.submission.coordinator, input.experimentId), 'events.jsonl'),
          { experimentId: query.experimentId, phase: query.phase, beforeSeq: query.seq + 1, limit: 1 }, sourceId, config.chunkBytes, true)
        const event = page.records.find(event => event.seq === query.seq)
        if (event === undefined) throw new Error('The recorded event is unavailable')
        if (query.generation !== undefined && query.generation !== page.cursor?.generation) throw new Error('The phase log changed during reading')
        if (attachment !== undefined) {
          respond(200, await readTraceAttachment(resolve(serverRunRoot(record.submission.coordinator, input.experimentId), 'agent-homes', query.phase === 'planning' ? 'plan' : 'execution'),
            JSON.parse(event.data), attachment.attachmentId, attachment.offset, config.chunkBytes)); return
        }
        const digest = createHash('sha256').update(event.data).digest('hex')
        if (query.digest !== undefined && query.digest !== digest) throw new Error('The recorded event changed during reading')
        if (query.offset > event.data.length) throw new Error('Event offset exceeds its payload')
        const data = event.data.slice(query.offset, query.offset + config.chunkBytes)
        respond(200, { data, nextOffset: query.offset + data.length, length: event.data.length, digest }); return
      }
      if (operation === 'records' || operation === 'trace-records') {
        const request = agentRecordRequestSchema.parse(body)
        if (request.phase === 'preparation') throw new Error('Preparation records belong to the dispatch Host')
        const sessionId = request.phase === 'planning' ? record.planningSessionId : record.sessionId
        const sourceId = sessionId ?? (record.submission.protocol === 4 ? `aspera-${request.phase === 'planning' ? 'plan' : 'execution'}-${input.experimentId}` : undefined)
        respond(200, sourceId === undefined ? { records: [], hasMore: false, missing: true, reset: false }
          : await readPhaseRecords(resolve(serverRunRoot(record.submission.coordinator, input.experimentId), 'events.jsonl'), request, sourceId, config.chunkBytes, operation === 'trace-records', config.chunkBytes))
        return
      }
      if (operation === 'events' || operation === 'agent-log') {
        const cursor = z.object({ offset: z.number().int().nonnegative(), generation: z.string().optional() }).parse(body)
        respond(200, readClusterChunk(resolve(serverRunRoot(record.submission.coordinator, input.experimentId),
          operation === 'events' ? 'events.jsonl' : 'agent.log'),
        cursor.offset, cursor.generation, config.chunkBytes))
        return
      }
      if (operation === 'files' || operation === 'file' || operation === 'log' || operation === 'processes' || operation === 'process-log') {
        const target = z.object({ serverId: serverIdSchema }).parse(body)
        respond(200, await clusterNodeRequest(readClusterPrivate(config.root, input.experimentId), target.serverId, operation, input))
        return
      }
      respond(404, { error: 'cluster route not found' })
    } catch (error) { respond(400, { error: error instanceof Error ? error.message : String(error) }) }
  } }), 'experiment cluster: authenticated control routes')
}
