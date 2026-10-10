/** Test-only CPU provider: real DSH Sessions, durable scheduling, Web Remotes and profile-launched services. */
import { createHash, randomUUID } from 'node:crypto'
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
import { ObservationWriter, observationSources, readObservation } from '../../packages/runtime/lib/observations.js'
import { freemem, totalmem } from 'node:os'
import { openInferenceGateway } from '../../packages/runtime/lib/inference-gateway.js'
import { SavedReleaseUnavailable, verifyController } from '../../packages/dispatch/lib/cluster-deploy.js'
import { controllerPolicyDigest } from '@aspera/runtime'
import { sshPasswordRef } from '../../packages/dispatch/lib/ssh-account.js'
import { fixtureSelections } from './models.mjs'
import { createHandshakeFixture } from './ssh-handshake.mjs'

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
  const spec = defineDomain({ name: 'aspera_web_fixture', version: 1, layout: 'per-record', tables: { experiments: domainTable(clusterRecordSchema) } })
  const store = await ctx.storage.domain.open(spec)
  const children = new Map()
  const events = []
  const storageCalls = []
  const environmentCalls = []
  const controllerStates = new Map(); const controllerFailures = new Set(); const controllerStops = []
  const gpu = { gpus: [{ uuid: 'GPU-11111111-1111-1111-1111-111111111111', name: 'CPU fixture GPU', devicePath: '/dev/nvidia0' }], devicePaths: ['/dev/nvidia0'] }
  const controllerKey = (target, role) => target.host + ':' + target.remoteRoot + ':' + role
  const newController = (target, role, prepared) => {
    const policy = { backendPath: prepared.backendPath, hiddenPaths: prepared.hiddenPaths, devicePaths: prepared.devicePaths, gpu: prepared.gpu }
    return { version: 1, role, bootId: randomUUID(), deploymentId: prepared.deploymentId, root: target.remoteRoot, pid: 1000,
      processStart: '123', hostBootId: 'cpu-host-boot', policy, policyDigest: controllerPolicyDigest(policy),
      occupied: { experiments: [], allocations: [], commands: [], services: [] }, actualGpu: prepared.gpu }
  }
  const preparationCommands = []
  const configuredHosts = new Set()
  const repairedSandboxes = new Set()
  let handshakeFixture
  let handshakeProbe
  ctx.effect(() => async () => { await handshakeFixture?.close() })
  const restoredPreparations = new Set()
  const installations = new Map()
  const overviewModes = new Map()
  function overviewRecord(record) {
    const mode = overviewModes.get(record.submission.experimentId)
    if (mode === undefined) return record
    const running = ['running', 'partial', 'invalid-total', 'read-failure'].includes(mode.name)
    const state = running ? 'running' : mode.name === 'blocked' ? 'blocked' : mode.name === 'cancelled' ? 'cancelled' : 'completed'
    const internal = { run_experiment_command_attempts: 11, run_experiment_command_successes: 0, distinct_run_ids_attempted: 11,
      goal_rounds_with_same_failure: 5, gpu_probe_completed: 0, environment_created: 0, model_downloaded: 0, dataset_prepared: 0,
      smoke_run_completed: 0, formal_training_completed: 0, adapter_saved: 0, adapter_reload_verified: 0, artifacts_created_on_node: 0,
      docs_verified_pages: 3, assigned_nodes: record.submission.nodes.length, gpus_assigned: 0, custom_fixture_metric: 7 }
    const metrics = mode.name === 'blocked' ? internal : mode.name === 'partial' ? { loss: 0.91 }
      : { step: 540, total_steps: mode.name === 'invalid-total' ? 0 : 2000, loss: 1.8452, tokens_per_second: 12400, ...internal }
    return clusterRecordSchema.parse({ ...record, state, revision: record.revision + mode.revision, resourcesReleased: !running,
      detail: mode.name === 'blocked' ? 'CPU fixture dependency unavailable; inspect the retained diagnostic.\n' + 'A long retained command error with no GPU acceptance. '.repeat(120) : undefined,
      progress: { phase: mode.name === 'blocked' ? 'CPU fixture stopped while creating the isolated environment.' : 'CPU fixture executing the approved plan.', metrics, updatedAt: mode.updatedAt }, updatedAt: mode.updatedAt })
  }
  let installationGate
  let planGate; let retryGate; let hostKeyGate; let failConnection = false; let timeoutConnection = false; let failCleanup = false
  const cleanupCalls = []
  const controlCalls = []
  let statusFailure
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
    environmentRequirements: () => ({ node: '^22.19.0 || >=24.0.0', pnpm: '11.7.0' }),
    installedEnvironmentRequirements: async () => ({ node: '^22.19.0 || >=24.0.0', pnpm: '11.7.0' }),
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
        { name: 'bwrap', path: configuredHosts.has(target.host) ? '/fixture/bwrap' : '', version: configuredHosts.has(target.host) ? 'bubblewrap fixture' : '' },
      ].map(program => configuredHosts.has(target.host) ? program : { ...program, path: '', version: '' }),
      sandboxExitCode: target.host.startsWith('sandbox-') && !repairedSandboxes.has(target.host) ? 1 : configuredHosts.has(target.host) ? 0 : 127,
      diagnostics: target.host.startsWith('sandbox-') && !repairedSandboxes.has(target.host)
        ? "bwrap: Can't mount proc on /newroot/proc: Operation not permitted"
        : target.host === 'ssh-handshake.fixture' ? 'CPU SSH handshake recovered after 3 connection attempts' : 'CPU environment fixture',
      }
    },
    remoteResult: async (target, script, _signal, _password, output) => {
      const installed = script.includes('fixture retry installation')
      const sandboxRepair = script.includes('fixture repair sandbox configuration')
      if (sandboxRepair && target.host === 'sandbox-repair.fixture') repairedSandboxes.add(target.host)
      if (installed) configuredHosts.add(target.host)
      const result = { stdout: sandboxRepair ? 'CPU sandbox configuration checked' : installed ? 'Required tools installed' : 'Package metadata loaded', stderr: installed || sandboxRepair ? '' : 'Fixture download failed',
        exitCode: installed || sandboxRepair ? 0 : 1, signal: null, timedOut: false, cancelled: false, exitConfirmed: true }
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
    ensureClusterRole: async (target, prepared, role) => {
      const key = controllerKey(target, role)
      if (!controllerStates.has(key)) controllerStates.set(key, newController(target, role, prepared))
      const record = fleet.list().find(row => row.preparation?.placements.some(placement => placement.workspaceRoot === target.storagePlacement?.workspaceRoot))
      if (record?.request.objective === 'CPU controller recovery' && role === 'node' && !controllerFailures.has(record.request.experimentId)) {
        controllerFailures.add(record.request.experimentId)
        const state = controllerStates.get(key); state.policy = { ...state.policy, devicePaths: ['/dev/nvidia2'] }; state.policyDigest = controllerPolicyDigest(state.policy)
      }
      verifyController(controllerStates.get(key), target, prepared, role)
    },
    inspectController: async (target, role) => structuredClone(controllerStates.get(controllerKey(target, role))),
    describeClusterNode: async server => ({ server, backendPath: '/fixture/bwrap', devicePaths: ['/dev/nvidia0'], hiddenPaths: [], gpuInfo: 'CPU test provider only (UUID: GPU-11111111-1111-1111-1111-111111111111)' }),
    delegateClusterLogin: async () => ({ knownHostsFile: '/fixture/private/known_hosts' }),
    installPrivateFile: async (_target, destination, content) => { const file = path(destination); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, content) },
    remote: async (target, script) => {
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
      if (operation === 'submit') {
        if (!existsSync(path(`${body.coordinator.remoteRoot}/secrets/${id}.json`))) throw new Error('private materials are missing')
        return { status: 200, value: await queue.submit(body) }
      }
      if (operation === 'status') { if (statusFailure !== undefined) throw new Error(statusFailure); return { status: 200, value: { record: overviewRecord(queue.get(id)), waitingFor: queue.waitingFor(id) } } }
      if (operation === 'approve') return { status: 200, value: await queue.approve(id, body.revision) }
      if (operation === 'answer-question') { const { experimentId: _id, ...reply } = body; return { status: 200, value: await queue.answerQuestion(id, reply) } }
      if (operation === 'cancel') return { status: 200, value: await queue.cancel(id, body.submission) }
      const record = overviewRecord(queue.get(id))
      if (record === undefined) throw new Error('experiment not found')
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
            state: ended || (active || mode !== undefined) && index === 0 ? 'completed' : mode?.name === 'blocked' && index === 1 ? 'blocked'
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
  const fleet = await ExperimentFleet.open(ctx, server => ({ ...server, localRepo: config.release, dataRoots: [], preparationOutputChars: policy.preparationOutputChars, agentCredentialRefs: [], tokenRef: 'FIXTURE', toolTimeoutMs: 30000, controlPollIntervalMs: 100, minimumFreeBytes: policy.minimumFreeBytes }), policy.connectionCheckTimeoutMs, driver)
  const retry = fleet.retry.bind(fleet)
  fleet.retry = async id => { await retryGate?.promise; return retry(id) }
  new AsperaRemote(ctx, fleet, new ExperimentDownloads(ctx, fleet, 60000), policy)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/aspera-test', handler: async (req, res) => {
    try {
    const url = new URL(req.url, 'http://localhost')
    const id = url.searchParams.get('id')
    const kind = url.pathname.split('/').at(-1)
    if (kind.startsWith('overview-')) {
      const name = kind.slice('overview-'.length)
      if (!['running', 'blocked', 'cancelled', 'completed', 'legacy', 'partial', 'invalid-total', 'read-failure'].includes(name)
        || queue.get(id)?.submission.objective !== 'CPU overview review') throw new Error('Unknown overview fixture or experiment')
      overviewModes.set(id, { name, revision: (overviewModes.get(id)?.revision ?? 2) + 1, updatedAt: Date.now() })
      await fleet.refresh(id)
    }
    if (kind === 'fail-status') statusFailure = 'SSH connection failed: ECONNREFUSED observations.test'
    if (kind === 'timeout-status') statusFailure = 'The operation was aborted due to timeout'
    if (kind === 'restore-status') statusFailure = undefined
    if (kind === 'controller-recovery') {
      const base = fleet.servers().servers[0]
      const { storagePlacement: _placement, remoteRoot: _root, ...connection } = base
      const server = { ...connection, id: randomUUID(), name: 'CPU maintenance', host: 'cpu-maintenance' }
      await ctx.credentials.set(sshPasswordRef(server), 'cpu-only-controller-password')
      await fleet.saveServer(server)
      await fleet.create({ experimentId: randomUUID(), name: 'CPU controller recovery', objective: 'CPU controller recovery', serverIds: [server.id], coordinatorId: server.id, models: fixtureSelections, mode: 'semi' })
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
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ...fleet.snapshot(), queue: queue.list(), cleanupCalls, controlCalls, events, storageCalls, environmentCalls, preparationCommands, controllerStops,
      sshHandshakeRecovery: handshakeFixture?.facts() }))
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(error) }))
    }
  } }))
}

function assertHealth(response) { if (!response.ok) throw new Error('CPU service health failed') }
