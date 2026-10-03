/** Test-only CPU provider: real DSH Sessions, durable scheduling, Web Remotes and profile-launched services. */
import { randomUUID } from 'node:crypto'
import { mkdirSync, appendFileSync, copyFileSync, writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { ClusterQueue, clusterRecordSchema, clusterFiles, clusterPath, readClusterChunk, processLogRequestSchema } from '@aspera/experiments'
import { AsperaRemote, Config as AdapterConfig } from '@aspera/dispatch'
import { ExperimentFleet } from '@aspera/dispatch/fleet'
import { ExperimentDownloads } from '@aspera/dispatch/downloads'
import { inventory, installStorageReplay } from './storage.mjs'
import { readPhaseRecords } from '../../packages/runtime/lib/records.js'
import { openInferenceGateway } from '../../packages/runtime/lib/inference-gateway.js'

export const inject = ['storage', 'storageDomain', 'agents', 'goals', 'credentials', 'agentDefaultModel', 'sessionPersistence', 'subprocess', 'webServer', 'llm', 'settings']

export async function apply(ctx, config) {
  if (config.role === 'service') {
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/health', handler: (_req, res) => { res.end('healthy') } }))
    ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/', handler: (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ prediction: 'CPU fixture response' })) } }))
    writeFileSync(config.ready + '.incoming', JSON.stringify({ port: ctx.webServer.port }))
    renameSync(config.ready + '.incoming', config.ready)
    process.stdout.write('CPU fixture service ready\n')
    process.stderr.write('CPU fixture diagnostic stream\n')
    return
  }
  await ctx.credentials.set('ASPERA_FIXTURE_API_KEY', 'cpu-only-fixture-key')
  const root = config.root
  mkdirSync(root, { recursive: true })
  const path = remote => resolve(root, remote.replace(/^\/+/, ''))
  const runPath = (id, file) => resolve(root, 'experiments', id, file)
  const spec = defineDomain({ name: 'aspera_web_fixture', version: 1, layout: 'per-record', tables: { experiments: domainTable(clusterRecordSchema) } })
  const store = await ctx.storage.domain.open(spec)
  const children = new Map()
  const events = []
  const storageCalls = []
  installStorageReplay(ctx, storageCalls)
  ctx.on('session/event', (session, event) => {
    const match = /^aspera-(dispatch|fixture-plan|fixture-execution)-(.+)$/.exec(session.id)
    if (match === null) return
    const id = match[2]; const source = match[1] === 'fixture-plan' ? 'plan' : match[1] === 'fixture-execution' ? 'execution' : match[1]
    const envelope = { sessionId: session.id, source, event }
    events.push(envelope)
    mkdirSync(runPath(id, ''), { recursive: true })
    if (source !== 'dispatch') appendFileSync(runPath(id, 'events.jsonl'), JSON.stringify(envelope) + '\n')
  }, { global: true })

  async function session(record, role, text) {
    const sessionId = SessionId(`aspera-fixture-${role}-${record.submission.experimentId}`)
    const handle = await ctx.agents.create({ sessionId, meta: { cwd: root } })
    try {
      const goal = ctx.goals.create(handle.agent, { objective: record.submission.objective })
      ctx.goals.disarm(handle.agent)
      handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'aspera', experimentId: record.submission.experimentId }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
      if (role === 'execution') handle.agent.session.append('tool/call', { turn: 0, step: 0, callId: 'cpu-service-call', name: 'run_experiment_command', arguments: JSON.stringify({ server_id: record.submission.nodes[0].server.id, run_id: 'fixture-service', command: 'dsh --profile cpu-service' }) })
      ctx.goals.complete(handle.agent, { id: goal.id, revision: goal.revision })
      await ctx.sessionPersistence.flush()
      return { sessionId, goalId: goal.id }
    } finally { await handle.dispose() }
  }

  async function stop(id) {
    const owned = children.get(id)
    if (owned === undefined) return true
    owned.stopping = true; await owned.gateway?.close(); owned.handle.terminate()
    await owned.handle.done.catch(() => {})
    const released = await owned.handle.waitForExit(AbortSignal.timeout(10000))
    owned.service = { ...owned.service, state: released ? 'stopped' : 'interrupted', released, updatedAt: Date.now(),
      ...(owned.service?.external === undefined ? {} : { external: { ...owned.service.external, state: 'stopped' } }) }
    return released
  }

  const executor = {
    prepare: async record => {
      const identity = await session(record, 'plan', 'Prepare a CPU fixture service in the experiment directory.')
      return { plan: { revision: 1, summary: 'Local CPU service plan', steps: ['Write an output file', 'Start a managed loopback service', 'Check health'], frameworks: [], createdAt: 1 }, sessionId: identity.sessionId }
    },
    run: async (record, signal, started, update) => {
      const id = record.submission.experimentId
      const identity = await session(record, 'execution', 'Run the approved CPU fixture plan.')
      await started(identity.sessionId, identity.goalId)
      if (record.submission.objective.includes('operator question')) {
        const question = await queue.openQuestion(id, { version: 1, questionId: randomUUID(), revision: 1,
          experimentId: id, sessionId: identity.sessionId, callId: 'fixture-question-' + id, stage: 'running', state: 'open', createdAt: Date.now(),
          questions: [{ id: 'trial', question: 'Which evaluation split should the trial use?', options: [{ label: 'Use the held-out split' }, { label: 'Stop for revised inputs' }] }] })
        while (!signal.aborted && queue.get(id).questions.find(item => item.questionId === question.questionId).state === 'open') await delay(50)
        signal.throwIfAborted()
        await queue.consumeQuestion(id, { questionId: question.questionId, revision: question.revision, sessionId: question.sessionId, callId: question.callId })
      }
      const workspace = runPath(id, 'workspace'); mkdirSync(workspace, { recursive: true })
      writeFileSync(resolve(workspace, 'result.txt'), 'local output\n')
      appendFileSync(runPath(id, 'node.log'), '训练准备完成\n')
      if (record.submission.objective.includes('failure')) return { state: 'failed', detail: 'CPU fixture dependency failed', resourcesReleased: true }
      const home = resolve(root, 'service-homes', id)
      const profile = resolve(home, 'profiles/cpu-service')
      mkdirSync(profile, { recursive: true })
      writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ name: 'aspera-cpu-fixture-profile', private: true, dependencies: { '@deepseek-ai/dsh-base': '0.2.0-rc.2' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
      const ready = resolve(profile, 'ready.json')
      writeFileSync(resolve(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [
        { id: 'fixture-http', name: '@deepseek-ai/dsh-host-webserver', config: { host: '127.0.0.1', port: 0 } },
        { id: 'fixture-service', name: import.meta.url, config: { role: 'service', ready } },
      ] }]))
      const handle = ctx.subprocess.spawn({ argv: [process.execPath, resolve(config.release, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', 'cpu-service'],
        cwd: config.release, env: { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, graceMs: 3000, stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' } })
      for (const stream of ['stdout', 'stderr']) writeFileSync(runPath(id, `process-${stream}.log`), '')
      handle.stdout?.on('data', bytes => { appendFileSync(runPath(id, 'agent.log'), bytes); appendFileSync(runPath(id, 'process-stdout.log'), bytes) })
      handle.stderr?.on('data', bytes => { appendFileSync(runPath(id, 'agent.log'), bytes); appendFileSync(runPath(id, 'process-stderr.log'), bytes) })
      const owned = { handle, stopping: false, service: undefined }
      children.set(id, owned)
      const cancelled = () => { handle.terminate() }
      signal.addEventListener('abort', cancelled, { once: true })
      let exited = false
      void handle.done.then(() => { exited = true }, () => { exited = true })
      try {
        const startedAt = Date.now()
        const deadline = startedAt + config.profileStartupMs
        while (!existsSync(ready) && !exited && !signal.aborted && Date.now() < deadline) await delay(50)
        if (!existsSync(ready)) throw new Error('CPU profile did not start: ' + (existsSync(runPath(id, 'agent.log')) ? readFileSync(runPath(id, 'agent.log'), 'utf8') : 'no output'))
        ctx.logger.info(`CPU fixture profile ready after ${Date.now() - startedAt} ms`)
        const port = JSON.parse(readFileSync(ready, 'utf8')).port
        owned.service = { id: randomUUID(), experimentId: id, serverId: record.submission.nodes[0].server.id,
          commandId: 'fixture-service', command: 'dsh --profile cpu-service', modelPath: 'result.txt', port, healthPath: '/health',
          state: 'healthy', createdAt: Date.now(), updatedAt: Date.now(), released: false }
        assertHealth(await fetch(`http://127.0.0.1:${port}/health`))
        const mapping = record.submission.nodes[0].server.inferenceMapping
        if (mapping !== undefined) {
          owned.service = { ...owned.service, modelName: 'cpu-fixture', external: { ...mapping, state: 'unchecked' } }
          owned.gateway = await openInferenceGateway(owned.service, { root, healthTimeoutMs: 3000, requestTimeoutMs: 5000, requestBytes: 65536 }, () => !exited && !owned.stopping)
          owned.service.external = await owned.gateway.probe()
        }
        await update({ state: 'serving', services: [owned.service], progress: { phase: 'serving', metrics: { checks: 1 }, updatedAt: 1 } })
        appendFileSync(runPath(id, 'node.log'), '服务健康\n')
        while (!exited && !signal.aborted) await delay(50)
        await handle.done.catch(() => {})
        const released = await handle.waitForExit(AbortSignal.timeout(10000))
        await owned.gateway?.close()
        owned.service = { ...owned.service, state: owned.stopping ? 'stopped' : 'failed', released, updatedAt: Date.now(), ...(owned.stopping ? {} : { detail: 'CPU fixture exited unexpectedly' }),
          ...(owned.service.external === undefined ? {} : { external: { ...owned.service.external, state: 'stopped' } }) }
        await update({ services: [owned.service] })
        return { state: signal.aborted ? 'cancelled' : owned.stopping ? 'completed' : 'failed', resourcesReleased: released }
      } finally {
        signal.removeEventListener('abort', cancelled)
        if (!exited) await stop(id)
      }
    },
    reconcile: record => stop(record.submission.experimentId),
  }
  const queue = new ClusterQueue(store.table('experiments'), executor, error => ctx.logger.error(String(error)))
  ctx.effect(() => async () => { await queue.close(); await store.close() })
  await queue.recover()
  const driver = {
    inspectServerStorage: async (target, directory) => inventory(directory ?? '/fixture/data/' + target.host),
    prepareServerStorage: async (_target, placement) => placement.candidate,
    verifyServerStorage: async (_target, placement) => placement.candidate,
    resolveTrainingNetwork: async (_id, participants) => participants.map(value => value.node),
    snapshotSource: async () => ({ directory: root, archive: 'fixture.tar', archiveHash: 'f'.repeat(64), digest: 'f'.repeat(64), dispose() {} }),
    prepareClusterServer: async () => ({ state: 'ready', deploymentId: 'f'.repeat(64), preparationId: 'f'.repeat(64), backend: 'bwrap', backendPath: '/fixture/bwrap', sandboxWriteProbe: 'passed', cudaProbe: 'passed', devicePaths: ['/dev/nvidia_fixture'], hiddenPaths: [], workspaceRoot: '/fixture/workspace' }),
    ensureClusterRole: async () => {},
    describeClusterNode: async server => ({ server, backendPath: '/fixture/bwrap', devicePaths: ['/dev/nvidia_fixture'], hiddenPaths: [], gpuInfo: 'CPU test provider; GPU validation is separate' }),
    delegateClusterLogin: async () => ({ knownHostsFile: '/fixture/private/known_hosts' }),
    installPrivateFile: async (_target, destination, content) => { const file = path(destination); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content) },
    remote: async () => 'CPU test provider',
    copy: async (_target, source, destination) => { const file = path(destination); mkdirSync(dirname(file), { recursive: true }); copyFileSync(source, file) },
    request: async (_target, _token, route, _method, body) => {
      const operation = route.split('/').at(-1)
      if (operation === 'health') return { status: 200, value: { node: { allocations: queue.list().filter(row => !row.resourcesReleased).map(row => row.submission.experimentId) } } }
      const id = body.experimentId
      if (operation === 'submit') {
        if (!existsSync(path(`${body.coordinator.remoteRoot}/secrets/${id}.json`))) throw new Error('private materials are missing')
        return { status: 200, value: await queue.submit(body) }
      }
      if (operation === 'status') return { status: 200, value: { record: queue.get(id), waitingFor: queue.waitingFor(id) } }
      if (operation === 'approve') return { status: 200, value: await queue.approve(id, body.revision) }
      if (operation === 'answer-question') { const { experimentId: _id, ...reply } = body; return { status: 200, value: await queue.answerQuestion(id, reply) } }
      if (operation === 'cancel') return { status: 200, value: await queue.cancel(id, body.submission) }
      const record = queue.get(id)
      if (record === undefined) throw new Error('experiment not found')
      if (body.serverId !== undefined && !record.submission.nodes.some(node => node.server.id === body.serverId)) throw new Error('node is outside this experiment')
      if (operation === 'records') return { status: 200, value: await readPhaseRecords(runPath(id, 'events.jsonl'), body, body.phase === 'planning' ? record.planningSessionId : record.sessionId, 65536) }
      if (operation === 'processes') return { status: 200, value: children.get(id)?.service === undefined ? [] : [{ experimentId: id, serverId: body.serverId, commandId: 'fixture-service', command: 'dsh --profile cpu-service', state: 'running', released: false, exitCode: null, streams: ['stdout', 'stderr'] }] }
      if (operation === 'process-log') {
        const request = processLogRequestSchema.parse(body); const cursor = request.cursor
        if (request.commandId !== 'fixture-service' || (cursor !== undefined && ['experimentId', 'serverId', 'commandId', 'stream'].some(key => cursor[key] !== request[key]))) throw new Error('CPU log source mismatch')
        const chunk = readClusterChunk(runPath(id, `process-${request.stream}.log`), cursor?.offset ?? 0, cursor?.generation, 65536)
        return { status: 200, value: { chunk, missing: chunk.generation === '', cursor: { experimentId: id, serverId: request.serverId, commandId: request.commandId, stream: request.stream, generation: chunk.generation, offset: chunk.nextOffset } } }
      }
      if (operation === 'files') return { status: 200, value: clusterFiles(runPath(id, 'workspace'), body.serverId, 100) }
      if (['events', 'log', 'agent-log', 'file'].includes(operation)) {
        const file = operation === 'file' ? clusterPath(runPath(id, 'workspace'), body.path) : runPath(id, operation === 'events' ? 'events.jsonl' : operation === 'agent-log' ? 'agent.log' : 'node.log')
        return { status: 200, value: readClusterChunk(file, body.offset, body.generation, operation === 'log' ? 5 : 65536, operation === 'file' ? runPath(id, 'workspace') : undefined) }
      }
      const owned = children.get(id)
      if (owned?.service?.id !== body.serviceId) throw new Error('service is outside this experiment')
      if (operation === 'stop-service') { await stop(id); return { status: 200, value: owned.service } }
      if (operation === 'service-access-info') {
        if (owned.stopping || owned.gateway === undefined) throw new Error('Public service is not active')
        return { status: 200, value: owned.gateway.access() }
      }
      if (operation === 'access-service') {
        const response = await fetch(`http://127.0.0.1:${owned.service.port}${body.path}`)
        return { status: 200, value: { status: response.status, body: await response.text() } }
      }
      throw new Error('Unknown CPU fixture operation: ' + operation)
    },
  }
  const policy = AdapterConfig({ extensionRoot: config.release, agentCredentialRefs: [], pollIntervalMs: 100 })
  const fleet = await ExperimentFleet.open(ctx, server => ({ ...server, localRepo: config.release, dataRoots: [], allowedSystemPackages: [], agentCredentialRefs: [], tokenRef: 'FIXTURE', toolTimeoutMs: 30000, controlPollIntervalMs: 100, minimumFreeBytes: policy.minimumFreeBytes }), driver)
  new AsperaRemote(ctx, fleet, new ExperimentDownloads(ctx, fleet, 60000), policy)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/aspera-test', handler: async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const id = url.searchParams.get('id')
    const kind = url.pathname.split('/').at(-1)
    if (kind === 'append') appendFileSync(runPath(id, 'node.log'), '断线后继续\n')
    if (kind === 'rotate') writeFileSync(runPath(id, 'node.log'), '轮转后日志\n')
    if (kind === 'crash') children.get(id)?.handle.terminate()
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ experiments: fleet.list(), queue: queue.list(), events, storageCalls }))
  } }))
}

function assertHealth(response) { if (!response.ok) throw new Error('CPU service health failed') }
