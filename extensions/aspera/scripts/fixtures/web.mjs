/** Test-only CPU provider: real DSH Sessions, durable scheduling, Web Remotes and profile-launched services. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, appendFileSync, copyFileSync, writeFileSync, readFileSync, existsSync, renameSync, statSync } from 'node:fs'
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
import { ObservationWriter, observationSources, readObservation } from '../../packages/runtime/lib/observations.js'
import { freemem, totalmem } from 'node:os'
import { openInferenceGateway } from '../../packages/runtime/lib/inference-gateway.js'
import { SavedReleaseUnavailable, verifyController, ControllerDiagnostic } from '../../packages/dispatch/lib/cluster-deploy.js'
import { controllerPolicyDigest, managedEnvironmentPolicySchema } from '@aspera/runtime'
import { sshPasswordRef } from '../../packages/dispatch/lib/ssh-account.js'
import { fixtureSelections } from './models.mjs'
import { createHandshakeFixture } from './ssh-handshake.mjs'
import { completionFixture } from './completion.mjs'

export const inject = ['storage', 'storageDomain', 'agents', 'agentLoop', 'goals', 'credentials', 'agentDefaultModel', 'sessionPersistence', 'subprocess', 'webServer', 'llm', 'settings']

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
  const completion = completionFixture(ctx, runPath, path)
  const spec = defineDomain({ name: 'aspera_web_fixture', version: 1, layout: 'per-record', tables: { experiments: domainTable(clusterRecordSchema) } })
  const store = await ctx.storage.domain.open(spec)
  const children = new Map()
  const events = []
  const storageCalls = []
  const environmentCalls = []
  const controllerStates = new Map(); const controllerFailures = new Set(); const controllerStops = []
  const offlineRecovered = new Set()
  const deletedTaskRecords = new Map()
  let deletedTaskPreparation
  const gpu = { gpus: [{ uuid: 'GPU-11111111-1111-1111-1111-111111111111', name: 'CPU fixture GPU', devicePath: '/dev/nvidia0' }], devicePaths: ['/dev/nvidia0'] }
  const controllerKey = (target, role) => target.host + ':' + target.remoteRoot + ':' + role
  const newController = (target, role, prepared) => {
    const policy = { backendPath: prepared.backendPath, hiddenPaths: prepared.hiddenPaths, devicePaths: prepared.devicePaths, gpu: prepared.gpu }
    return { version: 1, role, bootId: randomUUID(), deploymentId: prepared.deploymentId, root: target.remoteRoot, pid: 1000,
      processStart: '123', hostBootId: 'cpu-host-boot', policy, policyDigest: controllerPolicyDigest(policy),
      occupied: { experiments: [], allocations: [], commands: [], services: [] }, actualGpu: prepared.gpu }
  }
  const preparationCommands = []
  const preparationReceipts = new Map()
  const configuredHosts = new Set()
  const repairedSandboxes = new Set()
  let handshakeFixture
  let handshakeProbe
  ctx.effect(() => async () => { await handshakeFixture?.close() })
  const restoredPreparations = new Set()
  const installations = new Map()
  const overviewModes = new Map()
  const managedCacheCleaned = new Set()
  function overviewRecord(record) {
    const mode = overviewModes.get(record.submission.experimentId)
    if (mode === undefined) return record
    const running = ['running', 'partial', 'invalid-total', 'read-failure'].includes(mode.name)
    const state = running ? 'running' : ['blocked', 'long', 'storage-shortage'].includes(mode.name) ? 'blocked' : mode.name === 'cancelled' ? 'cancelled' : 'completed'
    const internal = { run_experiment_command_attempts: 11, run_experiment_command_successes: 0, distinct_run_ids_attempted: 11,
      goal_rounds_with_same_failure: 5, gpu_probe_completed: 0, environment_created: 0, model_downloaded: 0, dataset_prepared: 0,
      smoke_run_completed: 0, formal_training_completed: 0, adapter_saved: 0, adapter_reload_verified: 0, artifacts_created_on_node: 0,
      docs_verified_pages: 3, assigned_nodes: record.submission.nodes.length, gpus_assigned: 0, custom_fixture_metric: 7 }
    const metrics = mode.name === 'blocked' ? internal : mode.name === 'partial' ? { loss: 0.91 }
      : { step: 540, total_steps: mode.name === 'invalid-total' ? 0 : 2000, loss: 1.8452, tokens_per_second: 12400, ...internal }
    return clusterRecordSchema.parse({ ...record, state, revision: record.revision + mode.revision, resourcesReleased: !running,
      ...(mode.name === 'long' ? { plan: { ...record.plan, revision: 2, steps: Array.from({ length: 23 }, (_, index) => `步骤 ${index + 1} ${index === 17 ? '验收证据受阻' : '已批准的计划步骤'}：${index === 0 ? 'CUDA_VISIBLE_DEVICES 由已核验的 UUID 解析。' : ''}${'保留完整要求与证据。'.repeat(30)}`) } } : {}),
      detail: mode.name === 'blocked' ? 'CPU fixture dependency unavailable; inspect the retained diagnostic.\n' + 'A long retained command error with no GPU acceptance. '.repeat(120) : undefined,
      progress: { phase: mode.name === 'blocked' ? 'CPU fixture stopped while creating the isolated environment.' : 'CPU fixture executing the approved plan.', metrics, updatedAt: mode.updatedAt }, updatedAt: mode.updatedAt })
  }
  let installationGate
  let planGate; let retryGate; let hostKeyGate; let failConnection = false; let timeoutConnection = false; let failCleanup = false
  const interruptionGates = new Map(); const interruptionFailures = new Set(); const interruptionCalls = []
  ctx.effect(() => () => { for (const gate of interruptionGates.values()) gate.resolve() })
  const cleanupCalls = []
  const controlCalls = []
  let statusFailure
  let archiveRemoteOffline = false
  ctx.effect(() => () => hostKeyGate?.resolve())
  installStorageReplay(ctx, storageCalls, environmentCalls)
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
      if (config.observationHistory && role === 'plan') for (let index = 0; index < 220; index++) {
        handle.agent.session.append('user/message', createUserMessage({ source: { kind: 'aspera', experimentId: record.submission.experimentId },
          content: [{ type: 'text', text: `Planning history ${index.toString().padStart(3, '0')} · ${'Recorded CPU fixture observation. '.repeat(8)}` }] }), { surfaceOp: 'append' })
      }
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
      if (record.submission.objective === 'CPU semi experiment') await planGate?.promise
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
      if (['CPU completed experiment', 'CPU installation recovery', 'CPU overview review'].includes(record.submission.objective)) {
        const output = new ObservationWriter(runPath(id, ''), { version: 1, id: 'process-fixture-service', kind: 'process',
          experimentId: id, serverId: record.submission.nodes[0].server.id, phase: 'execution', sessionId: identity.sessionId,
          commandId: 'fixture-service', label: 'CPU recorded output', createdAt: Date.now(), streams: ['stdout', 'stderr'], complete: false })
        for (let index = 0; index < 240; index++) output.append(index % 7 === 0 ? 'stderr' : 'stdout', `CPU observation ${index}\n`)
        output.close()
        return { state: 'completed', resourcesReleased: true }
      }
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
      const observation = new ObservationWriter(runPath(id, ''), { version: 1, id: 'process-fixture-service', kind: 'process',
        experimentId: id, serverId: record.submission.nodes[0].server.id, phase: 'execution', sessionId: identity.sessionId,
        commandId: 'fixture-service', label: 'CPU service', createdAt: Date.now(), streams: ['stdout', 'stderr'], complete: false })
      handle.stdout?.on('data', chunk => observation.append('stdout', chunk))
      handle.stderr?.on('data', chunk => observation.append('stderr', chunk))
      void handle.done.finally(() => observation.close()).catch(() => {})
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
          if (config.portLease !== undefined && !existsSync(config.portLease + '.released')) {
            writeFileSync(config.portLease, '')
            while (!existsSync(config.portLease + '.released')) { signal.throwIfAborted(); await delay(50) }
          }
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
  ctx.effect(() => async () => { planGate?.resolve(); retryGate?.resolve(); installationGate?.resolve(); await queue.close(); await store.close() })
  await queue.recover()
  const driver = {
    environmentRequirements: () => ({ node: '^22.19.0 || >=24.0.0', pnpm: '11.7.0', uv: '0.13.0' }),
    installedEnvironmentRequirements: async () => ({ node: '^22.19.0 || >=24.0.0', pnpm: '11.7.0', uv: '0.13.0' }),
    inspectEnvironment: async (target, _password, signal) => {
      if (target.host === 'ssh-handshake.fixture') {
        handshakeProbe ??= handshakeFixture.probe(target, signal)
        await handshakeProbe
      }
      return {
      home: '/home/trainer', system: 'Linux', architecture: 'x86_64', identity: 'uid=1000(trainer)',
      programs: [
        { name: 'node', path: '/usr/bin/node', version: 'v24.1.0' },
        { name: 'pnpm', path: '/usr/bin/pnpm', version: '11.7.0' },
        { name: 'python3', path: '/usr/bin/python3', version: 'Python 3.12.0' },
        { name: 'uv', path: '/usr/local/bin/uv', version: 'uv 0.13.0' },
        { name: 'bwrap', path: repairedSandboxes.has(target.host) ? '/fixture/control/tools/sandbox/' + 'a'.repeat(64) + '/bin/bwrap'
          : configuredHosts.has(target.host) ? '/fixture/bwrap' : '', version: configuredHosts.has(target.host) ? 'bubblewrap fixture' : '' },
      ].map(program => configuredHosts.has(target.host) ? program : { ...program, path: '', version: '' }),
      sandboxExitCode: target.host.startsWith('sandbox-') && !repairedSandboxes.has(target.host) ? 1 : configuredHosts.has(target.host) ? 0 : 127,
      diagnostics: target.host.startsWith('sandbox-') && !repairedSandboxes.has(target.host)
        ? "bwrap: Can't mount proc on /newroot/proc: Operation not permitted"
        : target.host === 'ssh-handshake.fixture' ? 'CPU SSH handshake recovered after 3 connection attempts' : 'CPU environment fixture',
      }
    },
    remoteResult: async (target, script, _signal, _password, output) => {
      if (script.includes('function archiveCatalog(request)')) {
        if (archiveRemoteOffline) throw new Error('SSH archive read failed: ECONNREFUSED observations.test')
        const encoded = script.match(/[A-Za-z0-9+/=]{80,}/g)?.at(-1)
        const input = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
        const id = input.experimentId; const record = overviewRecord(queue.get(id))
        const physical = file => `${statSync(file).dev}:${statSync(file).ino}:${statSync(file).birthtimeMs}`
        let value
        if (script.includes('JSON.stringify(archiveRead(')) {
          const file = runPath(id, input.path); const bytes = readFileSync(file).subarray(input.offset, input.offset + input.limit)
          value = { data: bytes.toString('base64'), offset: input.offset, nextOffset: input.offset + bytes.length,
            generation: physical(file), length: statSync(file).size, eof: input.offset + bytes.length >= statSync(file).size }
        } else {
          const sources = []
          const add = (name, descriptor) => {
            const file = runPath(id, name)
            if (existsSync(file)) sources.push({ ...descriptor, path: name, generation: physical(file), size: statSync(file).size, modifiedAt: statSync(file).mtimeMs })
          }
          if (input.coordinator) for (const phase of ['planning', 'execution']) add('events.jsonl', { id: `trace-${phase}`, kind: 'trace', format: 'events', phase,
            sessionId: phase === 'planning' ? record.planningSessionId : record.sessionId ?? `aspera-execution-${id}` })
          for (const source of observationSources(runPath(id, '')).filter(source => source.serverId === input.serverId)) add(`observations-v1/${source.id}.jsonl`,
            { id: source.id, kind: 'log', format: 'observations', source, label: source.label })
          add('node.log', { id: 'legacy-node', kind: 'log', format: 'text', stream: 'mixed', label: 'Node log' })
          value = { sources, processes: [], metrics: [], truncated: false, ...completion.catalog(id), ...(input.coordinator ? { record } : {}) }
        }
        const stdout = JSON.stringify(value)
        output?.('stdout', stdout)
        return { stdout, stderr: '', exitCode: 0, signal: null, timedOut: false, cancelled: false, exitConfirmed: true }
      }
      const installed = script.includes('fixture retry installation')
      if (target.host === 'preparation-recovery.fixture' && script.includes('fixture install dependencies')) {
        const record = fleet.list().find(row => row.coordinatorTarget.host === target.host && row.state === 'preparing')
        const directory = record.preparation.environments.find(row => row.pendingCommand)?.pendingCommand.directory
        const source = observationSources(resolve(config.home, 'aspera-observations', record.request.experimentId)).find(row => directory.endsWith('/' + row.commandId))
        preparationReceipts.set(directory, { status: { version: 1, experimentId: source.experimentId, serverId: source.serverId,
          commandId: source.commandId, sessionId: source.sessionId, toolCallId: source.toolCallId, exitCode: 143,
          exitConfirmed: true, timedOut: true, cancelled: false, signal: 'SIGTERM' }, offset: 100, hasMore: false,
        lines: [{ seq: 0, time: Date.now(), stream: 'stderr', text: 'Download exceeded its shared deadline; original group exited and cache was retained.\n' }] })
        const result = { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: true, cancelled: false, exitConfirmed: false }
        preparationCommands.push({ host: target.host, ...result }); return result
      }
      const preparationTool = script.includes('ASPERA_PREPARATION_COMMAND_DIRECTORY/command.py')
      const sandboxInspection = script.replaceAll('\\"', '"').includes('"mode":"inspect"')
      const sandboxRepair = script.replaceAll('\\"', '"').includes('"mode":"repair"')
      if (sandboxRepair && target.host === 'sandbox-repair.fixture') repairedSandboxes.add(target.host)
      if (installed) configuredHosts.add(target.host)
      const launcher = { version: 1, path: '/fixture/control/tools/sandbox/' + 'a'.repeat(64) + '/bin/bwrap', digest: 'a'.repeat(64) }
      const sandbox = { version: 1, strategy: 'private-proc', state: repairedSandboxes.has(target.host) ? 'configured' : sandboxRepair ? 'unavailable' : 'available',
        reason: sandboxRepair && target.host === 'sandbox-blocked.fixture' ? 'The cloud platform must provide namespace/proc permissions' : 'CPU-only compatibility fixture',
        stdout: 'CPU-only private-proc probe', stderr: '', exitCode: 0, requiresPlatformAction: sandboxRepair && target.host === 'sandbox-blocked.fixture',
        ...(repairedSandboxes.has(target.host) ? { launcher, pathEntries: [launcher.path.slice(0, -6)] } : {}) }
      if (sandboxRepair && target.host === 'sandbox-blocked.fixture') repairedSandboxes.add('blocked-probed')
      if (sandboxInspection && target.host === 'sandbox-blocked.fixture' && repairedSandboxes.has('blocked-probed')) {
        sandbox.state = 'unavailable'; sandbox.requiresPlatformAction = true
      }
      const result = { stdout: sandboxRepair || sandboxInspection ? JSON.stringify(sandbox) : preparationTool
        ? JSON.stringify({ ready: true, reused: true, downloadBytes: 0, pathEntries: ['/usr/local/bin'] }) : installed ? 'Required tools installed' : 'Package metadata loaded',
        stderr: installed || preparationTool || sandboxRepair || sandboxInspection ? '' : 'Fixture download failed',
        exitCode: installed || preparationTool || sandboxRepair || sandboxInspection ? 0 : 1, signal: null, timedOut: false, cancelled: false, exitConfirmed: true }
      preparationCommands.push({ host: target.host, ...result })
      output?.('stdout', Buffer.from(result.stdout)); output?.('stderr', Buffer.from(result.stderr))
      return result
    },
    prepareSshHostKey: async (_target, signal) => {
      if (timeoutConnection) await new Promise((_resolve, reject) => {
        signal.throwIfAborted()
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
      await hostKeyGate?.promise
      if (failConnection) throw new Error('Timed out while waiting for handshake')
    },
    inspectServerStorage: async (target, directory) => inventory(directory ?? '/fixture/data/' + target.host),
    cleanupServerStorage: async (_target, placement, names) => { if (failCleanup) throw new Error('CPU fixture cleanup temporarily unavailable'); cleanupCalls.push({ serverId: placement.serverId, experimentId: placement.experimentId, path: placement.runRoot, names }) },
    prepareServerStorage: async (_target, placement) => placement.candidate,
    verifyServerStorage: async (_target, placement) => placement.candidate,
    resolveTrainingNetwork: async (_id, participants) => participants.map(value => value.node),
    snapshotSource: async () => {
      const archive = resolve(root, 'fixture.tar')
      writeFileSync(archive, 'CPU fixture immutable material')
      return { directory: root, archive, archiveHash: createHash('sha256').update('CPU fixture immutable material').digest('hex'), digest: 'f'.repeat(64), dispose() {} }
    },
    prepareClusterServer: async (target, _source, _password, _signal, installation) => {
      const record = fleet.list().find(row => row.preparation?.placements.some(placement => placement.workspaceRoot === target.storagePlacement?.workspaceRoot))
      if (record?.request.objective === 'CPU preparation recovery' && !restoredPreparations.has(record.request.experimentId)) {
        throw new SavedReleaseUnavailable(`CPU fixture release requirements unavailable at ${target.storagePlacement.releaseRoot}`)
      }
      if (installation) await installation()
      if (record?.request.objective === 'CPU installation recovery') await installationGate?.promise
      return { state: 'ready', deploymentId: 'f'.repeat(64), preparationId: 'f'.repeat(64), backend: 'bwrap', backendPath: '/fixture/bwrap', sandboxWriteProbe: 'passed', cudaProbe: 'passed', devicePaths: ['/dev/nvidia0'], hiddenPaths: [], workspaceRoot: '/fixture/workspace', gpu }
    },
    ensureClusterRole: async (target, prepared, role, _token, _password, _signal, recoveryId) => {
      const key = controllerKey(target, role)
      if (target.host.startsWith('controller-offline') && role === 'coordinator' && !offlineRecovered.has(key)) {
        if (recoveryId === undefined || target.host.includes('blocked')) throw new ControllerDiagnostic({ code: 'unavailable', role,
          detail: 'worker profile is bound to a different release; original controller endpoint refused connection' })
        offlineRecovered.add(key)
      }
      if (!controllerStates.has(key)) controllerStates.set(key, newController(target, role, prepared))
      const record = fleet.list().find(row => row.preparation?.placements.some(placement => placement.workspaceRoot === target.storagePlacement?.workspaceRoot))
      if (record?.request.objective === 'CPU controller recovery' && role === 'node' && !controllerFailures.has(record.request.experimentId)) {
        controllerFailures.add(record.request.experimentId)
        const state = controllerStates.get(key); state.policy = { ...state.policy, devicePaths: ['/dev/nvidia2'] }; state.policyDigest = controllerPolicyDigest(state.policy)
      }
      verifyController(controllerStates.get(key), target, prepared, role)
    },
    inspectController: async (target, role) => {
      const status = controllerStates.get(controllerKey(target, role))
      if (status === undefined) throw new Error('(SSH) Channel open failure: Connection refused')
      return structuredClone(status)
    },
    describeClusterNode: async server => ({ server, backendPath: '/fixture/bwrap', devicePaths: ['/dev/nvidia0'], hiddenPaths: [], gpuInfo: 'CPU test provider only (UUID: GPU-11111111-1111-1111-1111-111111111111)' }),
    delegateClusterLogin: async () => ({ knownHostsFile: '/fixture/private/known_hosts' }),
    installPrivateFile: async (_target, destination, content) => { const file = path(destination); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content) },
    remote: async (target, script, signal) => {
      const review = await completion.remote(script, signal)
      if (review !== undefined) return review
      const preparation = [...preparationReceipts].find(([directory]) => script.includes('/command.py') && script.includes(directory))
      if (preparation !== undefined) return JSON.stringify(preparation[1])
      if (script.includes('"mode":"')) {
        const request = JSON.parse(script.slice(script.lastIndexOf(" '{") + 2, -1))
        if (request.mode === 'discover') return JSON.stringify({ records: request.experimentIds.map(id => deletedTaskRecords.get(id) ?? queue.get(id)).filter(Boolean) })
        if (request.mode.startsWith('interrupt-')) {
          interruptionCalls.push({ experimentId: request.submission.experimentId, operationId: request.status.operationId, mode: request.mode })
          await interruptionGates.get(request.submission.experimentId)?.promise
          if (interruptionFailures.has(request.submission.experimentId)) throw new Error('CPU fixture: original process exit identity is unavailable; allocation is retained')
          const orphan = deletedTaskRecords.get(request.submission.experimentId)
          if (orphan !== undefined) {
            if (orphan.payloadHash !== request.status.submissionHash) throw new Error('Deleted task submission identity mismatch')
            const facts = { serverId: request.serverId, agentsExited: true, commandsReleased: true, servicesReleased: true,
              commandsReady: true, servicesReady: true, digest: 'a'.repeat(64), hostBootId: 'cpu-orphan-boot', blockers: [], agents: [], commands: [],
              state: orphan.state, coordinatorExited: true }
            if (['interrupt-inspect', 'interrupt-fence', 'interrupt-settle'].includes(request.mode)) return JSON.stringify(facts)
            if (request.mode === 'interrupt-stop') {
              if (!request.status.stopRequested) throw new Error('Automatic recovery must not stop an unrelated process')
              return JSON.stringify({ stopped: true, operationId: request.status.operationId })
            }
            if (request.mode === 'interrupt-complete') {
              const result = clusterRecordSchema.parse({ ...orphan, revision: orphan.revision + 1, state: request.status.stopRequested ? 'cancelled' : 'interrupted', resourcesReleased: true,
                detail: 'Original controller exited; all original task work was verified stopped', updatedAt: Date.now() })
              deletedTaskRecords.set(result.submission.experimentId, result)
              return JSON.stringify({ record: result, status: { ...request.status, phase: 'released', result } })
            }
            return JSON.stringify({ released: true })
          }
          const record = queue.get(request.submission.experimentId)
          if (record === undefined || record.payloadHash !== request.status.submissionHash) throw new Error('CPU interruption submission identity mismatch')
          const owned = children.get(request.submission.experimentId)
          const released = record.resourcesReleased && (owned === undefined || owned.service?.released === true)
          const facts = { serverId: request.serverId, agentsExited: released, commandsReleased: released, servicesReleased: released,
            commandsReady: released, servicesReady: released, digest: 'a'.repeat(64), hostBootId: 'cpu-host',
            blockers: [], agents: [], commands: [], ...(request.serverId === request.submission.coordinator.id ? { state: record.state, coordinatorExited: false } : {}) }
          if (request.mode === 'interrupt-inspect' || request.mode === 'interrupt-fence' || request.mode === 'interrupt-settle') return JSON.stringify(facts)
          if (request.mode === 'interrupt-stop') return JSON.stringify({ stopped: true, operationId: request.status.operationId })
          if (request.mode === 'interrupt-complete') return JSON.stringify({ record, status: { ...request.status, phase: 'released', result: record } })
          return JSON.stringify({ released: true })
        }
        const orphan = [...deletedTaskRecords.values()].find(record => record.submission.coordinator.id === request.serverId && !record.resourcesReleased)
        if (request.mode === 'inspect') return JSON.stringify({ version: 1, state: orphan !== undefined || target.host.includes('offline-blocked') ? 'occupied' : 'offline',
          root: target.remoteRoot, role: request.role, home: target.remoteRoot + '/state/' + request.role + '-home', hostBootId: 'cpu-host',
          digest: 'e'.repeat(64), savedPid: null, releaseBinding: '/fixture/old-fixed-release', processes: [],
          blockers: orphan !== undefined ? [{ kind: 'experiment', id: orphan.submission.experimentId, reason: 'Deleted original task still has an unreleased allocation' }]
            : target.host.includes('offline-blocked') ? [{ kind: 'command', id: 'old-command', reason: 'Original command exit is not confirmed' }] : [],
          records: orphan === undefined ? [] : [{ kind: 'allocations', id: orphan.submission.experimentId, released: false }], converged: [] })
        if (request.mode === 'begin') return JSON.stringify({ version: 1, operationId: request.operationId, phase: 'fenced',
          directory: request.directory, role: request.role, release: request.release })
        return JSON.stringify({ completed: true, operationId: request.operationId })
      }
      if (script.includes('pidfd_send_signal')) {
        const entry = [...controllerStates.entries()].find(([, state]) => state.root === target.remoteRoot && state.maintenance !== undefined)
        if (entry === undefined) throw new Error('CPU controller stop has no identity-bound maintenance owner')
        controllerStops.push({ role: entry[1].role, operationId: entry[1].maintenance }); controllerStates.delete(entry[0]); return ''
      }
      const installer = / (launch|status|probe|stop) '([^']+\/config.json)'/.exec(script)
      if (installer) {
        const [, operation, configPath] = installer
        const saved = JSON.parse(readFileSync(path(configPath), 'utf8'))
        if (operation === 'probe') return JSON.stringify({ version: '0.2.0-rc.2', available: true, bytes: 65536, elapsedMs: 100,
          detail: 'CPU SSH fixture measured the pinned npm package over HTTPS' })
        if (operation === 'launch' && !installations.has(saved.attemptId)) {
          const record = fleet.list().find(row => row.request.experimentId === saved.experimentId)
          const failed = record?.request.objective === 'CPU installation recovery' && ![...installations.values()].some(value => value.experimentId === saved.experimentId)
          installations.set(saved.attemptId, { version: 1, attemptId: saved.attemptId, experimentId: saved.experimentId, serverId: saved.serverId,
            digest: saved.digest, archiveHash: saved.archiveHash, deadline: saved.deadline, startedAt: Date.now(), updatedAt: Date.now(), lastProgressAt: Date.now(),
            state: failed ? 'running' : 'completed', phase: failed ? 'installing-dependencies' : 'installed-release', progress: { bytes: 65536, packages: 5, cpuTicks: 10, ioBytes: 0 },
            pid: 1000, startTicks: 'cpu-fixture', bootId: 'cpu-fixture', exitCode: failed ? null : 0, exitConfirmed: !failed })
        }
        const status = installations.get(saved.attemptId)
        if (operation === 'stop') { status.state = 'cancelled'; status.exitConfirmed = true; status.exitCode = 1 }
        const offset = Number(/--offset (\d+)/.exec(script)?.[1] ?? 0)
        return JSON.stringify(operation === 'status' ? { status, offset: 128, hasMore: false,
          lines: offset === 0 ? [{ seq: 0, time: status.startedAt, stream: 'stderr', text: status.state === 'running'
            ? JSON.stringify({ level: 'warn', name: 'pnpm:global', message: 'Tarball download average speed is below the package manager limit; cache retained' })
            : status.reason ?? 'Pinned dependency installation complete\n' }] : [] } : status)
      }
      return script.includes('/exited') ? String(preparationCommands.findLast(command => command.host === target.host)?.exitCode ?? 0)
        : script.includes('for role in coordinator node') ? '' : 'CPU test provider'
    },
    copy: async (_target, source, destination) => { const file = path(destination); mkdirSync(dirname(file), { recursive: true }); copyFileSync(source, file) },
    request: async (_target, _token, route, _method, body) => {
      if (archiveRemoteOffline) throw new Error('SSH control channel failed: ECONNREFUSED observations.test')
      if (route.endsWith('/maintenance-begin')) {
        const role = route.includes('/node/') ? 'node' : 'coordinator'; const state = controllerStates.get(controllerKey(_target, role))
        if (state?.bootId !== body.bootId || state.policyDigest !== body.policyDigest) throw new Error('CPU maintenance identity changed')
        state.maintenance = body.operationId
        return { status: 200, value: { maintenance: state.maintenance, bootId: state.bootId, policyDigest: state.policyDigest } }
      }
      const operation = route.split('/').at(-1)
      controlCalls.push({ operation, experimentId: body?.experimentId })
      if (operation === 'health') return { status: 200, value: { node: { allocations: queue.list().filter(row => !row.resourcesReleased).map(row => row.submission.experimentId) } } }
      const id = body.experimentId
      if (deletedTaskRecords.has(id)) throw new Error('CPU original controller endpoint is offline')
      if (operation === 'submit') {
        if (!existsSync(path(`${body.coordinator.remoteRoot}/secrets/${id}.json`))) throw new Error('private materials are missing')
        return { status: 200, value: await queue.submit(body) }
      }
      if (operation === 'status') { if (statusFailure !== undefined) throw new Error(statusFailure); return { status: 200, value: { record: overviewRecord(queue.get(id)), waitingFor: queue.waitingFor(id) } } }
      if (operation === 'processes' && completion.catalog(id) !== undefined) return { status: 200, value: completion.catalog(id).processes }
      if (operation === 'execution-progress' && completion.catalog(id) !== undefined) return { status: 200, value: { supported: true, progress: completion.catalog(id).progress } }
      if (operation === 'approve') return { status: 200, value: await queue.approve(id, body.revision) }
      if (operation === 'answer-question') { const { experimentId: _id, ...reply } = body; return { status: 200, value: await queue.answerQuestion(id, reply) } }
      if (operation === 'cancel') return { status: 200, value: await queue.cancel(id, body.submission) }
      const record = overviewRecord(queue.get(id))
      if (record === undefined) throw new Error('experiment not found')
      if (operation === 'environment-storage' || operation === 'environment-preview' || operation === 'environment-cleanup' || operation === 'storage-inspect') {
        const node = record.submission.nodes.find(node => node.server.host === _target.host) ?? record.submission.nodes[0]
        const catalog = { version: 1, serverId: node.server.id, checkedAt: 100, complete: true, entriesScanned: 176, roots: [], historicalEnvironments: [], diagnostics: [],
          volumes: [{ id: '1'.repeat(64), directory: '/', filesystem: 'overlay', source: 'CPU fixture system', capacityBytes: 30 * 1024 ** 3,
            availableBytes: 1667948544, accountWritable: true, sandboxWritable: null, measuredBytes: 1024, unattributedBytes: 10 * 1024 ** 3,
            categories: [{ kind: 'log', logicalBytes: 1024, allocatedBytes: 1024, files: 1 }] },
          { id: '2'.repeat(64), directory: '/fixture/data', filesystem: 'ext4', source: 'CPU fixture data', capacityBytes: 50 * 1024 ** 3,
            availableBytes: 20 * 1024 ** 3, accountWritable: true, sandboxWritable: false, measuredBytes: 26 * 1024 ** 3, unattributedBytes: 4 * 1024 ** 3,
            categories: [{ kind: 'environment', logicalBytes: 26 * 1024 ** 3, allocatedBytes: 26 * 1024 ** 3, files: 176 }] }] }
        if (operation === 'storage-inspect') return { status: 200, value: catalog }
        if (operation === 'environment-preview') return { status: 200, value: { serverId: node.server.id, checkedAt: 100, fingerprint: 'd'.repeat(64),
          candidates: managedCacheCleaned.has(id + '/' + node.server.id) ? [] : [{ id: 'e'.repeat(64), kind: 'package', bytes: 1048576, reason: 'CPU fixture: confirmed unused managed package' }], eligible: true } }
        if (operation === 'environment-cleanup') {
          await delay(200); managedCacheCleaned.add(id + '/' + node.server.id)
          return { status: 200, value: { serverId: node.server.id, state: 'completed', reclaimedBytes: 1048576, checkedAt: Date.now() } }
        }
        const storageMode = overviewModes.get(id)?.name
        const placement = node.server.storagePlacement
        const trainingNamespace = placement.controlRoot + '/training-storage-v1'
        const trainingWorkspace = trainingNamespace + '/runs/' + id + '/workspace'
        const fallback = storageMode === 'storage-fallback'
        const shortage = storageMode === 'storage-shortage'
        const directory = (fallback ? trainingWorkspace : placement.workspaceRoot) + '/env/python'
        return { status: 200, value: { serverId: node.server.id, name: node.server.name, checkedAt: Date.now(), source: 'remote', availableBytes: 20_000_000_000,
          capacityBytes: 40_000_000_000, workspaceBytes: 16_000_000, sharedBytes: 1048576, reclaimableBytes: managedCacheCleaned.has(id + '/' + node.server.id) ? 0 : 1048576, legacy: [], complete: true,
          catalog,
          ...(fallback ? { arrangement: { version: 1, formatVersion: '0.1.0', experimentId: id, serverId: node.server.id,
            controlRoot: placement.controlRoot, dataWorkspace: placement.workspaceRoot, environmentWorkspace: trainingWorkspace, environmentNamespace: trainingNamespace,
            appliedAt: record.submission.createdAt, eventId: id.replaceAll('-', '') + node.server.id.replaceAll('-', ''),
            estimatedPeakBytes: Math.ceil(6.4 * 1024 ** 3), reason: 'CPU display fixture: data disk was insufficient after verified reuse; system disk capacity accepted',
            volume: { directory: '/', filesystem: 'overlay', source: 'CPU fixture system', device: '1' },
            history: [{ time: record.submission.createdAt, action: 'system-fallback', reason: 'CPU display fixture; no GPU work' }] } } : {}),
          storagePlan: { version: 1, experimentId: id, serverId: node.server.id, operationId: id, requestHash: 'a'.repeat(64), checkedAt: 100,
            state: shortage ? 'insufficient' : 'ready', formatVersion: '0.1.0', peakSafetyFactor: 1.2, environmentId: 'training', requirements: ['tiny-fixture==1.0'], materialIds: ['9'.repeat(64)], detail: 'CPU fixture: per-volume budget',
            volumes: [{ directory: '/fixture/data', availableBytes: (shortage ? 4 : 20) * 1024 ** 3, reservedBytes: 4096,
              requiredBytes: 2 * 1024 ** 3 + Math.ceil((shortage ? 32 * 1024 ** 3 : 1024) * 1.2),
              newPeakBytes: Math.ceil((shortage ? 32 * 1024 ** 3 : 1024) * 1.2), shortfallBytes: shortage ? 2 * 1024 ** 3 + Math.ceil(32 * 1024 ** 3 * 1.2) + 4096 - 4 * 1024 ** 3 : 0,
              missingBytes: 0, environmentBytes: 0, outputBytes: shortage ? 32 * 1024 ** 3 : 1024, checkpointBytes: 0, safetyBytes: 2 * 1024 ** 3 }] },
          borrowings: [{ version: 1, experimentId: id, serverId: node.server.id, deploymentId: record.submission.deploymentId, environmentId: 'historical-reference',
            operationId: id, candidateId: '8'.repeat(64), mode: 'borrowed-readonly', sourceExperimentId: '00000000-0000-4000-8000-000000000004',
            sourceRunRoot: '/fixture/old-run', directory: '/fixture/old-run/workspace/pyenv', python: '/fixture/old-run/workspace/pyenv/bin/python',
            pythonVersion: '3.10.12', pythonAbi: 'cp310-fixture', sourceHash: 'b'.repeat(64), fileCount: 176, links: [],
            interpreter: { path: '/usr/bin/python3.10', hash: 'b'.repeat(64), size: 1024, mtimeNs: '1', ctimeNs: '1' },
            volume: { directory: '/fixture/data', filesystem: 'ext4', source: 'CPU fixture data' }, requirements: ['tiny-fixture==1.0'], modules: ['tiny_fixture'],
            cuda: false, verified: true, checkedAt: 100, lease: '/fixture/control/lease.json', readonlyPaths: ['/fixture/old-run/workspace/pyenv'] }],
          assets: [{ version: 1, id: '9'.repeat(64), serverId: node.server.id, kind: 'model', provider: 'huggingface', repository: 'fixture/cpu-model', revision: 'a'.repeat(40),
            fileCount: 1, directory: '/fixture/data/assets-v1/models/' + '9'.repeat(64), totalBytes: 4096, missingBytes: 0, verifiedBytes: 4096, checkedAt: 100,
            volume: { directory: '/fixture/data', filesystem: 'ext4', source: 'CPU fixture data' }, state: 'ready' },
            { version: 1, id: '7'.repeat(64), serverId: node.server.id, kind: 'model', provider: 'huggingface', repository: 'fixture/unrelated-node-cache', revision: 'a'.repeat(40),
              fileCount: 1, directory: '/fixture/data/assets-v1/models/unrelated-node-cache', totalBytes: 4096, missingBytes: 0, verifiedBytes: 4096, checkedAt: 100,
              volume: { directory: '/fixture/data', filesystem: 'ext4', source: 'CPU fixture data' }, state: 'ready' }],
          operations: [{ experimentId: id, serverId: node.server.id, operationId: id, state: record.state === 'running' ? 'running' : 'completed',
            checkedAt: record.updatedAt, elapsedMs: 120000, processState: record.state === 'running' ? 'running' : 'exited', admissionReleased: record.state !== 'running',
            runtime: { version: 1, experimentId: id, serverId: node.server.id, operationId: id, environmentId: 'training', deploymentId: record.submission.deploymentId,
              startedAt: record.updatedAt - 120000, deadline: record.updatedAt + 1680000, updatedAt: record.updatedAt, exitConfirmed: record.state !== 'running', exitCode: record.state === 'running' ? null : 0, admissionReleased: record.state !== 'running' },
            operation: { version: 1, experimentId: id, serverId: node.server.id, operationId: id, environmentId: 'training', requestHash: 'a'.repeat(64), action: 'create',
              state: 'completed', startedAt: record.updatedAt - 120000, updatedAt: record.updatedAt, commandId: 'environment-' + id, exitConfirmed: true, exitCode: 0 } }],
          reusePlans: [{ version: 1, experimentId: id, serverId: node.server.id, operationId: id, environmentId: 'training',
            requirementsHash: 'a'.repeat(64), pythonAbi: 'cpython-312-fixture', uvVersion: '0.13.0', stage: record.state === 'running' ? 'reusing' : 'completed',
            packages: [{ name: 'tiny-fixture', version: '1.0', wheelHash: 'b'.repeat(64), decision: 'shared' }], downloadBytes: 0,
            reusedBytes: 1048576, estimatedPeakBytes: 65536, addedBytes: 65536, updatedAt: record.submission.createdAt ?? 100 }],
          materials: [{ name: 'tiny-fixture', version: '1.0', wheelHash: 'b'.repeat(64), source: 'CPU fixture verified wheel', bytes: 4096, cachedAt: record.submission.createdAt ?? 100, available: true }],
          cleanups: [{ version: 1, experimentId: id, serverId: node.server.id, operationId: id, environmentId: 'training', generation: id,
            state: managedCacheCleaned.has(id + '/' + node.server.id) ? 'completed' : 'pending', paths: [node.server.storagePlacement.workspaceRoot + '/tmp/environment-' + id],
            packages: [], createdAt: 100, updatedAt: 100, detail: 'CPU fixture: verified environment retained; ordinary temporary unlink pending' }],
          environments: [{ version: 1, experimentId: id, serverId: node.server.id, deploymentId: record.submission.deploymentId,
            environmentId: 'training', generation: record.submission.experimentId, purpose: 'CPU test fixture only; no GPU acceptance', directory, python: directory + '/bin/python',
            pythonVersion: '3.12.0', pythonAbi: 'cpython-312-fixture', uv: '/usr/local/bin/uv', uvVersion: '0.13.0', state: 'ready', requirements: ['tiny-fixture==1.0'], packages: [], privateFiles: [],
            sharing: { hardlinkBytes: 1048576, cloneBytes: 0, copyBytes: 0, logicalBytes: 1048576, allocatedBytes: 65536, addedBytes: 65536, estimatedCopyBytes: 0, reasons: [] },
            verification: { verified: true, checkedAt: 100, python: directory + '/bin/python', prefix: directory, userSiteEnabled: false, dependenciesValid: true, modules: ['tiny_fixture'] }, updatedAt: 100 }] } }
      }
      if (operation === 'execution-progress') {
        const mode = overviewModes.get(id)
        if (mode?.name === 'legacy') return { status: 404, value: { error: 'cluster route not found' } }
        if (mode?.name === 'read-failure') throw new Error('CPU fixture step progress read interrupted')
        if (record.plan === undefined) return { status: 200, value: { supported: true } }
        const active = ['running', 'serving'].includes(record.state)
        const ended = record.state === 'completed'
        const updatedAt = record.progress?.updatedAt ?? record.updatedAt
        return { status: 200, value: { supported: true, progress: { version: 1, experimentId: id,
          planRevision: record.plan.revision, sessionId: record.sessionId ?? `aspera-execution-${id}`, revision: mode?.revision ?? (active || ended ? 2 : 0),
          ...(active || ended || mode !== undefined ? { updatedAt } : {}), steps: record.plan.steps.map((_text, index) => ({ step: index + 1,
            state: mode?.name === 'long' ? index < 17 ? 'completed' : index === 17 ? 'blocked' : 'pending' : ended || (active || mode !== undefined) && index === 0 ? 'completed' : mode?.name === 'blocked' && index === 1 ? 'blocked'
              : (active || mode?.name === 'cancelled') && index === 1 ? 'running' : 'pending',
            ...(active || ended || mode !== undefined ? { updatedAt, detail: 'CPU fixture Agent step report' } : {}) })) } } }
      }
      if (body.serverId !== undefined && !record.submission.nodes.some(node => node.server.id === body.serverId)) throw new Error('node is outside this experiment')
      if (operation === 'records' || operation === 'trace-records') return { status: 200, value: await readPhaseRecords(runPath(id, 'events.jsonl'), body, body.phase === 'planning' ? record.planningSessionId : record.sessionId, 65536, operation === 'trace-records') }
      if (operation === 'observation-sources') return { status: 200, value: [
        { version: 1, id: 'legacy-node', kind: 'legacy', experimentId: id, serverId: body.serverId, label: 'Node log', createdAt: record.submission.createdAt ?? 1, streams: ['mixed'], complete: false },
        ...observationSources(runPath(id, '')),
      ] }
      if (operation === 'observation-read') return { status: 200, value: readObservation(runPath(id, ''), body) }
      if (operation === 'observation-metrics') return { status: 200, value: [{ experimentId: id, serverId: body.serverId, time: Date.now(),
        memoryUsedBytes: totalmem() - freemem(), memoryTotalBytes: totalmem(), gpus: [] }] }
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
  const policy = AdapterConfig({ extensionRoot: config.release, agentCredentialRefs: [], pollIntervalMs: 100, connectionCheckTimeoutMs: 1000 })
  const fleet = await ExperimentFleet.open(ctx, server => ({ ...server, localRepo: config.release, dataRoots: [], preparationOutputChars: policy.preparationOutputChars, agentCredentialRefs: [], tokenRef: 'FIXTURE', toolTimeoutMs: 30000, controlPollIntervalMs: 100, minimumFreeBytes: policy.minimumFreeBytes }), policy.connectionCheckTimeoutMs, driver,
    undefined, undefined, undefined, undefined, undefined, undefined, managedEnvironmentPolicySchema.parse({ storageIntervalMs: 1000 }))
  const retry = fleet.retry.bind(fleet)
  fleet.retry = async id => { await retryGate?.promise; return retry(id) }
  new AsperaRemote(ctx, fleet, new ExperimentDownloads(ctx, fleet, 60000), policy)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/aspera-test', handler: async (req, res) => {
    try {
    const url = new URL(req.url, 'http://localhost')
    const id = url.searchParams.get('id')
    const kind = url.pathname.split('/').at(-1)
    if (kind.startsWith('completion-')) {
      await completion.seed(queue.get(id), record => store.table('experiments').put(id, record), kind.slice('completion-'.length))
      await fleet.refresh(id)
    }
    if (kind.startsWith('overview-')) {
      const name = kind.slice('overview-'.length)
      if (!['running', 'blocked', 'cancelled', 'completed', 'legacy', 'partial', 'invalid-total', 'read-failure', 'long', 'storage-fallback', 'storage-shortage'].includes(name)
        || queue.get(id)?.submission.objective !== 'CPU overview review') throw new Error('Unknown overview fixture or experiment')
      await fleet.archives.settled(id)
      overviewModes.set(id, { name, revision: (overviewModes.get(id)?.revision ?? 2) + 1, updatedAt: Date.now() })
      await fleet.refresh(id)
      fleet.syncArchive(id); await fleet.archives.settled(id)
    }
    if (kind === 'fail-status') statusFailure = 'SSH connection failed: ECONNREFUSED observations.test'
    if (kind === 'timeout-status') statusFailure = 'The operation was aborted due to timeout'
    if (kind === 'restore-status') statusFailure = undefined
    if (kind === 'archive-offline') { archiveRemoteOffline = true; statusFailure = 'SSH control channel failed: ECONNREFUSED observations.test'; fleet.syncArchive(id) }
    if (kind === 'archive-online') { archiveRemoteOffline = false; statusFailure = undefined; fleet.syncArchive(id) }
    if (kind === 'sync-runtime') { fleet.syncArchive(id); await fleet.archives.settled(id) }
    if (kind === 'archive-sync') fleet.syncArchive(id)
    if (kind === 'archive-gap') fleet.archives.store(id).gap('Earlier metric samples are unavailable; only the retained remote window was recovered')
    if (kind === 'archive-state') {
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(fleet.archiveStatus(id))); return
    }
    if (kind === 'deleted-task-recovery' || kind === 'deleted-task-ui') {
      const original = structuredClone(queue.get(id))
      if (original === undefined || original.submission.nodes.length !== 1) throw new Error('Deleted-task replay requires one original CPU node')
      await queue.cancel(id, original.submission)
      await fleet.deleteExperiments({ operationId: randomUUID(), experimentIds: [id], cleanupRemote: false, allowUnconfirmed: true })
      // Seed the legacy corpus in this fixture's existing domains, without adding production test hooks.
      const removals = fleet.removals
      const tasks = fleet.remoteTasks
      const deadline = Date.now() + 30000
      while (removals.table('removals').get(id)?.localCleanup !== 'complete') {
        if (Date.now() > deadline) throw new Error('Deleted-task fixture local cleanup did not finish')
        await delay(20)
      }
      deletedTaskRecords.set(id, clusterRecordSchema.parse({ ...original, state: 'running', resourcesReleased: false, services: [] }))
      if (kind === 'deleted-task-recovery') {
        await tasks.table('tasks').delete(id)
        const { work: _work, ...legacy } = removals.table('removals').get(id)
        await removals.table('removals').put(id, legacy)
        interruptionGates.set(id, Promise.withResolvers())
        const registered = fleet.servers().servers.find(server => server.id === original.submission.coordinator.id)
        const server = { ...registered, name: 'CPU controller-offline-deleted', host: 'controller-offline-deleted.fixture' }
        await ctx.credentials.set(sshPasswordRef(server), 'cpu-only-deleted-task-password')
        configuredHosts.add(server.host); await fleet.saveServer(server)
        deletedTaskPreparation = randomUUID()
        await fleet.create({ experimentId: deletedTaskPreparation, name: 'CPU deleted task recovery', objective: 'CPU deleted task recovery',
          serverIds: [server.id], coordinatorId: server.id, models: fixtureSelections, mode: 'semi' })
      } else interruptionFailures.add(id)
    }
    if (kind === 'controller-recovery') {
      const base = fleet.servers().servers[0]
      const { storagePlacement: _placement, remoteRoot: _root, ...connection } = base
      const server = { ...connection, id: randomUUID(), name: 'CPU maintenance', host: 'cpu-maintenance' }
      await ctx.credentials.set(sshPasswordRef(server), 'cpu-only-controller-password')
      await fleet.saveServer(server)
      await fleet.create({ experimentId: randomUUID(), name: 'CPU controller recovery', objective: 'CPU controller recovery', serverIds: [server.id], coordinatorId: server.id, models: fixtureSelections, mode: 'semi' })
    }
    if (kind === 'controller-offline' || kind === 'controller-offline-blocked') {
      const base = fleet.servers().servers[0]
      const { storagePlacement: _placement, remoteRoot: _root, ...connection } = base
      const server = { ...connection, id: randomUUID(), name: 'CPU ' + kind, host: kind + '.fixture' }
      await ctx.credentials.set(sshPasswordRef(server), 'cpu-only-offline-password')
      configuredHosts.add(server.host)
      await fleet.saveServer(server)
      await fleet.create({ experimentId: randomUUID(), name: 'CPU ' + kind, objective: 'CPU ' + kind,
        serverIds: [server.id], coordinatorId: server.id, models: fixtureSelections, mode: 'semi' })
    }
    if (kind === 'ssh-handshake-recovery') {
      handshakeFixture = await createHandshakeFixture(root)
      const base = fleet.servers().servers[0]
      const { storagePlacement: _placement, remoteRoot: _root, ...connection } = base
      const server = { ...connection, id: randomUUID(), name: 'CPU SSH recovery', host: 'ssh-handshake.fixture' }
      configuredHosts.add(server.host)
      await ctx.credentials.set(sshPasswordRef(server), 'cpu-only-handshake-password')
      await fleet.saveServer(server)
      await fleet.create({ experimentId: randomUUID(), name: 'CPU SSH handshake recovery', objective: 'CPU SSH handshake recovery', serverIds: [server.id], coordinatorId: server.id, models: fixtureSelections, mode: 'semi' })
    }
    if (kind.startsWith('sandbox-')) {
      const scenario = kind.slice('sandbox-'.length)
      if (!['repair', 'blocked', 'claim'].includes(scenario)) throw new Error('Unknown sandbox fixture')
      const base = fleet.servers().servers[0]
      const { storagePlacement: _placement, remoteRoot: _root, ...connection } = base
      const server = { ...connection, id: randomUUID(), name: 'CPU sandbox ' + scenario, host: kind + '.fixture' }
      await ctx.credentials.set(sshPasswordRef(server), 'cpu-only-sandbox-password')
      configuredHosts.add(server.host)
      await fleet.saveServer(server)
      await fleet.create({ experimentId: randomUUID(), name: 'CPU sandbox ' + scenario, objective: 'CPU sandbox ' + scenario,
        serverIds: [server.id], coordinatorId: server.id, models: fixtureSelections, mode: 'semi' })
    }
    if (kind === 'unconfirm-release') {
      const record = store.table('experiments').get(id)
      await store.table('experiments').put(id, { ...record, revision: record.revision + 1, state: 'failed', resourcesReleased: false, detail: 'CPU fixture remote cleanup unconfirmed' })
      await fleet.refresh(id)
    }
    if (kind === 'append') appendFileSync(runPath(id, 'node.log'), '断线后继续\n')
    if (kind === 'rotate') writeFileSync(runPath(id, 'node.log'), '轮转后日志\n')
    if (kind === 'observation-append') {
      const source = observationSources(runPath(id, '')).find(source => source.id === 'process-fixture-service')
      const output = new ObservationWriter(runPath(id, ''), { ...source, complete: false })
      output.append('stdout', 'CPU newly received output\n'); output.close()
    }
    if (kind === 'crash') children.get(id)?.handle.terminate()
    if (kind === 'restore-release') restoredPreparations.add(id)
    if (kind === 'hold-installation') installationGate = Promise.withResolvers()
    if (kind === 'release-installation') installationGate?.resolve()
    if (kind === 'hold-plan') planGate = Promise.withResolvers()
    if (kind === 'release-plan') planGate?.resolve()
    if (kind === 'hold-host-key') hostKeyGate = Promise.withResolvers()
    if (kind === 'release-host-key') hostKeyGate?.resolve()
    if (kind === 'fail-connection') failConnection = true
    if (kind === 'timeout-connection') timeoutConnection = true
    if (kind === 'restore-connection') { failConnection = false; timeoutConnection = false }
    if (kind === 'fail-cleanup') failCleanup = true
    if (kind === 'restore-cleanup') failCleanup = false
    if (kind === 'hold-retry') retryGate = Promise.withResolvers()
    if (kind === 'release-retry') retryGate?.resolve()
    if (kind === 'hold-interruption') interruptionGates.set(id, Promise.withResolvers())
    if (kind === 'fail-interruption') { interruptionFailures.add(id); interruptionGates.get(id)?.resolve(); interruptionGates.delete(id) }
    if (kind === 'release-interruption') { interruptionFailures.delete(id); interruptionGates.get(id)?.resolve(); interruptionGates.delete(id) }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ...fleet.snapshot(), queue: queue.list(), cleanupCalls, controlCalls, events, storageCalls, environmentCalls, preparationCommands, controllerStops, interruptionCalls,
      sshHandshakeRecovery: handshakeFixture?.facts(), deletedTaskPreparation, deletedTaskRecords: [...deletedTaskRecords.values()] }))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(error) }))
    }
  } }))
}

function assertHealth(response) { if (!response.ok) throw new Error('CPU service health failed') }
