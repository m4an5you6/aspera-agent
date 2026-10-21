/** Keyless replay provider for the actual Aspera worker profile and scoped tools. */
import assert from 'node:assert/strict'
import { writeFileSync, renameSync, readFileSync, mkdirSync, rmdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fixtureProvider } from './models.mjs'
import { ToolCallId, HarnessError } from '@deepseek-ai/dsh-llm'
import { applyClusterRole } from '../../packages/runtime/lib/cluster.js'
import { createServer } from 'node:http'
import { ExecutionProgressStore } from '../../packages/runtime/lib/execution-progress.js'
import { clusterRecordSchema, executionStepReportSchema } from '@aspera/experiments'

export const inject = ['llm', 'webServer', 'userQuestions', 'storage']

/** Mount deterministic model responses; application and tools remain the production profile. */
export async function apply(ctx, config) {
  if (config.ready !== undefined) {
    writeFileSync(config.ready + '.incoming', JSON.stringify({ port: ctx.webServer.port }))
    renameSync(config.ready + '.incoming', config.ready)
    return
  }
  const observed = { tools: [], calls: [], guidanceRead: false, inputRead: false, inputBlocked: false }
  if (!config.planning && !config.managedEnvironments) await installCpuNode(ctx, config)
  if (config.managedEnvironments) installEnvironmentNode(ctx, config)
  if (!config.planning) await installStepCoordinator(ctx, config)
  let admitted = false
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (!agent.session.id.endsWith(config.id) || admitted) return next()
    admitted = true
    if (!config.semi) {
      await assert.rejects(ctx.userQuestions.ask({ agent, questions: [{ id: 'unexpected', question: 'Await a human?' }], signal: AbortSignal.timeout(1000) }),
        error => error.code === 'ASPERA_UNATTENDED')
      observed.humanWaitingRejected = true
    }
    if (config.transient) {
      observed.recoverableFailures = 1
      writeFileSync(config.observed, JSON.stringify(observed))
      throw new HarnessError('Keyless recoverable connection failure', 'TRANSPORT')
    }
    if (config.http) writeFileSync(config.observed, JSON.stringify(observed))
    return next()
  }, { global: true })
  if (config.http) return
  const responses = workerResponses(config, observed)
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== fixtureProvider || !options.messages.some(message => JSON.stringify(message).includes(config.id))) {
      yield* next(); return
    }
    yield* responses(options)
  }, { global: true })
}

/** The replay uses production report validation and private files over authenticated HTTP. */
async function installStepCoordinator(ctx, config) {
  const root = process.env.DSH_CLUSTER_ROOT
  const materialPath = resolve(root, 'secrets', config.id + '.json')
  const materials = JSON.parse(readFileSync(materialPath, 'utf8'))
  const token = 'c'.repeat(32)
  writeFileSync(resolve(root, 'secrets/coordinator.token'), token)
  const reports = new ExecutionProgressStore(root)
  let record
  const server = createServer(async (req, res) => {
    const respond = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)) }
    if (req.headers.authorization !== `Bearer ${token}`) { respond(401, { error: 'unauthorized' }); return }
    try {
      let text = ''
      for await (const chunk of req) text += chunk
      const input = JSON.parse(text)
      assert.equal(input.experimentId, config.id)
      if (req.url.endsWith('/execution-progress')) respond(200, { supported: true, progress: reports.read(record) })
      else if (req.url.endsWith('/report-execution-step')) respond(200, reports.report(record, executionStepReportSchema.parse(input)))
      else respond(404, { error: 'unknown step fixture route' })
    } catch (error) { respond(500, { error: String(error) }) }
  })
  ctx.effect(() => async () => { await new Promise((done, reject) => server.close(error => error ? reject(error) : done())) })
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  materials.submission.coordinator.remotePort = server.address().port - 1
  writeFileSync(materialPath, JSON.stringify(materials))
  record = clusterRecordSchema.parse({ submission: materials.submission, payloadHash: 'b'.repeat(64), sequence: 1, revision: 1,
    state: 'running', resourcesReleased: false, updatedAt: 1, handover: '本机派发完成，远端实验已接管', executions: [], services: [],
    sessionId: `aspera-execution-${config.id}`, plan: JSON.parse(readFileSync(resolve(root, 'runs', config.id, 'approved-plan.json'), 'utf8')),
    approval: { planRevision: 1, approvedAt: 1, by: 'policy' } })
}

/** CPU command handles use the production node routes, storage and experiment tools. */
async function installCpuNode(ctx, config) {
  const root = process.env.DSH_CLUSTER_ROOT
  mkdirSync(resolve(root, 'runs', config.id, 'workspace'), { recursive: true })
  writeFileSync(resolve(root, 'runs', config.id, '.aspera-owner.json'), JSON.stringify({ version: 1, experimentId: config.id, serverId: config.serverId }))
  writeFileSync(resolve(root, 'runs', config.id, 'workspace/smoke.py'), '# CPU command fixture metadata\n')
  const materialPath = resolve(root, 'secrets', config.id + '.json')
  const materials = JSON.parse(readFileSync(materialPath, 'utf8'))
  materials.submission.coordinator.remotePort = ctx.webServer.port
  materials.submission.nodes[0].server.remotePort = ctx.webServer.port
  writeFileSync(materialPath, JSON.stringify(materials))
  const tokenFile = resolve(root, 'secrets/node-replay.token')
  writeFileSync(tokenFile, materials.connections[0].token)
  let launches = 0
  const groupExits = []
  // CPU command replay provides an explicit acceptance double; Linux tests own real interpreter verification.
  const webServer = { port: ctx.webServer.port, register(route) {
    return ctx.webServer.register({ ...route, handler: async (req, res) => {
      if (req.url.split('?')[0] !== '/aspera/v4/node/environment-acceptance') return route.handler(req, res)
      assert.equal(req.headers.authorization, `Bearer ${materials.connections[0].token}`)
      let input = ''; for await (const chunk of req) input += chunk
      const body = JSON.parse(input); assert.equal(body.experimentId, config.id)
      assert.ok(body.environments.every(value => value === '.venv'))
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(config.stepReports
        ? { verified: true, environments: 1 } : { verified: false, detail: 'CPU replay has no required CUDA device' }))
    } })
  } }
  const nodeContext = { storage: ctx.storage, webServer, logger: ctx.logger,
    effect: ctx.effect.bind(ctx), subprocess: { spawn(spec) {
      assert.equal(spec.argv.at(-1), 'printf node-storage-fixture')
      launches += 1
      const recorded = JSON.parse(readFileSync(config.observed, 'utf8'))
      writeFileSync(config.observed, JSON.stringify({ ...recorded, nodeLaunches: launches }))
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const done = Promise.withResolvers()
      const finish = () => {
        if (config.commandWait) {
          const current = JSON.parse(readFileSync(config.observed, 'utf8'))
          assert.equal(current.calls.length, recorded.calls.length, 'The model must not dispatch another tool while this command is running')
          writeFileSync(config.observed, JSON.stringify({ ...current, exclusiveWaitNoModelPolls: true }))
        }
        stdout.end('CPU command output\n'); stderr.end('CPU command diagnostic\n')
        done.resolve({ exitCode: 0, signal: null })
      }
      if (config.commandGroup) {
        groupExits.push(finish)
        if (groupExits.length === 2) queueMicrotask(() => { for (const exit of groupExits) exit() })
      }
      else if (config.commandWait) { const timer = setTimeout(finish, 2500); ctx.effect(() => () => { clearTimeout(timer) }) }
      else queueMicrotask(finish)
      return { stdout, stderr, done: done.promise, terminate() {}, waitForExit: async () => true }
    } } }
  await applyClusterRole(nodeContext, { role: 'node', root, tokenFile, deploymentId: 'a'.repeat(64),
    backendPath: '/fixture/bwrap', hiddenPaths: [], devicePaths: ['/dev/nvidia_fixture'],
    chunkBytes: 65536, fileLimit: 100, cleanupTimeoutMs: 1000, pollIntervalMs: 1000,
    networkProbeLifetimeMs: 1000, serviceRequestTimeoutMs: 1000, serviceRequestBytes: 65536,
    observations: { intervalMs: 60000, historyMs: 900000, readBytes: 65536, metricSamples: 1000 } })
  const body = { experimentId: config.id, deploymentId: 'a'.repeat(64), protocol: 2,
    node: { ...materials.submission.nodes[0], server: { ...materials.submission.coordinator, storagePlacement: undefined } } }
  const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/aspera/v2/node/allocate`, {
    method: 'POST', headers: { authorization: `Bearer ${materials.connections[0].token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(10000),
  })
  assert.equal(response.status, 200, await response.text())
}

/** Deterministic actions shared by stream replay and the actual provider HTTP fixture. */
export function workerResponses(config, observed) {
  const knowledge = ['get_experiment_requirements', 'read_experiment_input', 'read_framework_documentation', 'read_framework_guidance']
  const execution = ['run_experiment_command', 'get_experiment_commands', 'read_experiment_file', 'list_experiment_files',
    'run_experiment_command_group', 'register_experiment_stage', 'verify_experiment_stage',
    'record_experiment_execution', 'report_experiment_progress', 'get_experiment_execution_progress', 'report_experiment_step', 'start_inference_service', 'get_inference_services', 'finish_experiment', 'inspect_experiment_completion',
    'inspect_experiment_environment', 'prepare_experiment_environment', 'recover_experiment_environment',
    'preview_experiment_cache_cleanup', 'cleanup_experiment_cache', 'inspect_experiment_storage', 'assess_experiment_storage',
    'inspect_experiment_materials', 'prepare_experiment_materials']
  const expected = [...knowledge, ...(config.semi ? ['ask_user_question'] : []), ...(config.planning ? ['save_experiment_plan'] : execution)].sort()
  if (config.managedEnvironments) return environmentResponses(config, observed, expected)
  if (config.stepReports) return stepResponses(config, observed, expected)
  let step = 0
  let rounds = 0
  const group = { operationId: randomUUID(), commands: ['member1', 'member2'].map(commandId => ({ serverId: config.serverId, commandId, command: 'printf node-storage-fixture' })) }
  return async function* (options) {
    assert.equal(options.model, config.planning ? 'qwen-planning' : 'qwen-execution')
    observed.tools = (options.tools ?? []).map(tool => tool.name).sort()
    assert.deepEqual(observed.tools, expected)
    if (rounds < (config.renewRounds ?? 0)) {
      rounds += 1; observed.rounds = rounds
      writeFileSync(config.observed, JSON.stringify(observed))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Recorded progress; continue the same experiment.' } }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (step > 0) {
      assert.ok(JSON.stringify(options.messages).includes('name: unsloth'), JSON.stringify(options.messages).slice(-5000))
      observed.guidanceRead = true
    }
    if (step >= 2) { assert.ok(JSON.stringify(options.messages).includes('input is outside this experiment')); observed.inputBlocked = true }
    if (step >= 3) { assert.ok(JSON.stringify(options.messages).includes(Buffer.from('dataset row\n').toString('base64'))); observed.inputRead = true }
    if (config.nodeCommands && step >= 4) {
      const text = options.messages.map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n')
      assert.ok(text.includes('"state":"completed"'), 'The exclusive tool must wait for the real node exit: ' + text.slice(-2000))
      assert.ok(!text.includes('not path-safe'))
      observed.commandsAccepted = true
      if (step >= 6) { assert.ok(text.includes('"state":"completed"')); assert.equal(observed.nodeLaunches, config.commandGroup ? 2 : 1); observed.commandDeduplicated = true }
      if (config.commandGroup) { assert.equal(observed.nodeLaunches, 2); observed.groupStartedBeforeWait = true }
      if (step >= 7) { assert.ok(text.includes('CPU command output')); assert.ok(text.includes('CPU command diagnostic')); observed.nodeLogRead = true }
    }
    if (config.tokenLimit && step >= (config.planning ? 3 : 6)) {
      writeFileSync(config.observed, JSON.stringify(observed))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Provider truncated the response at its token limit.' } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    const actionStep = step - (config.ask && step > 3 ? 1 : 0)
    if (config.ask && step >= 4) {
      assert.ok(JSON.stringify(options.messages).includes('Continue with a measured trial'), 'The original tool must receive the saved reply')
    }
    if ((config.planning && actionStep >= 4) || (!config.planning && actionStep >= (config.nodeCommands ? 9 : 5))) {
      const block = { type: 'text', text: config.planning ? 'The plan is saved for confirmation.' : 'The experiment is blocked because a GPU is unavailable.' }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block }
      yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    let name; let args
    if (step === 0) { name = 'read_framework_guidance'; args = { framework: 'unsloth' } }
    else if (step === 1) { name = 'read_experiment_input'; args = { name: '../secrets/model.json', offset: 0 } }
    else if (step === 2) { name = 'read_experiment_input'; args = { name: 'data.txt', offset: 0 } }
    else if (config.ask && step === 3) {
      name = 'ask_user_question'
      args = { questions: [{ id: 'trial', question: 'How should the ambiguous evaluation split be resolved?',
        options: [{ label: 'Continue with a measured trial' }, { label: 'Stop for a revised experiment' }] }] }
    } else if (config.planning) {
      name = 'save_experiment_plan'
      args = { status: 'completed', plan_json: JSON.stringify({ summary: 'Version-specific keyless plan', steps: ['Prepare the isolated framework environment', 'Verify a short run'],
        frameworks: [{ name: 'unsloth', version: 'test-version', documentation: 'https://unsloth.ai/docs' }] }) }
    } else if (config.nodeCommands && actionStep < 7) {
      if (actionStep <= 4) { name = config.commandGroup ? 'run_experiment_command_group' : 'run_experiment_command'; args = config.commandGroup ? { json: JSON.stringify(group) } : { server_id: config.serverId, run_id: 'probe_env', command: 'printf node-storage-fixture' } }
      else if (actionStep === 5) { name = 'get_experiment_commands'; args = { wait: true } }
      else { name = 'read_experiment_file'; args = { server_id: config.serverId, offset: 0 } }
    } else if (actionStep === 3 || (config.nodeCommands && actionStep === 7)) {
      name = 'record_experiment_execution'
      args = { json: JSON.stringify({ serverId: config.serverId, framework: 'fixture', version: 'test-version', script: 'smoke.py',
        environment: '.venv', parameters: { steps: '1' }, artifacts: [], evaluation: {} }) }
    } else { name = 'finish_experiment'; args = { status: 'blocked', detail: 'No GPU is available in the local worker replay.' } }
    assert.ok(step < (config.nodeCommands ? 9 : 7), 'Worker failed to finish after its terminal tool')
    step += 1; observed.calls.push(name)
    writeFileSync(config.observed, JSON.stringify(observed))
    const block = { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** Missing reports are repaired without repeating settled commands; independent checks still run. */
/** Simulated installer outcomes use the real profile tools and authenticated node route; no GPU claims are made. */
function installEnvironmentNode(ctx, config) {
  const materialPath = resolve(process.env.DSH_CLUSTER_ROOT, 'secrets', config.id + '.json')
  const materials = JSON.parse(readFileSync(materialPath, 'utf8'))
  materials.submission.coordinator.remotePort = ctx.webServer.port; materials.submission.nodes[0].server.remotePort = ctx.webServer.port
  writeFileSync(materialPath, JSON.stringify(materials))
  const operations = []
  const reads = new Map()
  let materialReads = 0
  const materialStartedAt = Date.now()
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/aspera/v4/node', handler: async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${materials.connections[0].token}`)
    let text = ''; for await (const chunk of req) text += chunk
    const input = JSON.parse(text); assert.equal(input.experimentId, config.id)
    let value
    if (req.url.endsWith('/status') || req.url.endsWith('/services')) value = []
    else if (req.url.endsWith('environment-acceptance')) value = { verified: false, detail: 'CPU fixture: required CUDA access is unavailable' }
    else if (req.url.endsWith('storage-inspect')) value = { complete: true, diagnostic: 'Account-side catalog sees the released legacy pyenv hidden in ordinary commands', historicalEnvironments: [{ id: 'c'.repeat(64), reusable: false }] }
    else if (req.url.endsWith('material-inspect')) value = { id: 'd'.repeat(64), revision: 'a'.repeat(40), missingBytes: 0, verifiedBytes: 4096,
      detail: 'Canonical fixed revision and existing local files verified' }
    else if (req.url.endsWith('storage-assess')) value = { state: 'ready', operationId: input.operationId, detail: 'Separate system and data volume budgets; no second environment allocation' }
    else if (req.url.endsWith('material-prepare')) value = { state: 'running', operationId: input.operationId }
    else if (req.url.endsWith('material-status')) {
      materialReads += 1
      value = { version: 1, experimentId: config.id, serverId: config.serverId, operationId: input.operationId, materialId: 'd'.repeat(64),
        requestHash: 'e'.repeat(64), state: materialReads < 3 ? 'running' : 'completed', startedAt: materialStartedAt, deadline: materialStartedAt + 7200000,
        updatedAt: Date.now(), downloadedBytes: 0, reusedBytes: 4096, exitConfirmed: materialReads >= 3, admissionReleased: materialReads >= 3,
        detail: 'Read-only material published with zero downloaded bytes' }
    }
    else if (req.url.endsWith('environment-inspect')) value = { operations, storage: { environments: [] }, diagnostic: 'CPU fixture environment inspection' }
    else if (req.url.endsWith('environment-preview')) value = { serverId: config.serverId, fingerprint: 'a'.repeat(64), eligible: true,
      candidates: [{ id: 'temporary-fixture', kind: 'temporary', bytes: 64, reason: 'Confirmed exited owned operation' }] }
    else if (req.url.endsWith('environment-cleanup')) value = { serverId: config.serverId, state: 'completed', reclaimedBytes: 64,
      detail: 'Only owned temporary files removed; environments, models and logs retained' }
    else if (req.url.endsWith('environment-status')) {
      const operation = operations.find(row => row.operationId === input.operationId)
      assert.ok(operation, 'Status must query the original submitted operation')
      const count = (reads.get(input.operationId) ?? 0) + 1; reads.set(input.operationId, count)
      const pending = operation.state === 'requested'
      const waiting = count < 3
      const startedAt = operation.startedAt
      const state = waiting ? 'running' : pending ? 'unknown' : operation.state === 'completed' ? 'completed' : 'failed'
      value = { experimentId: config.id, serverId: config.serverId, operationId: input.operationId, state,
        checkedAt: Date.now(), elapsedMs: Date.now() - startedAt,
        processState: waiting ? 'running' : pending ? 'unknown' : 'exited', admissionReleased: !waiting && !pending,
        runtime: { version: 1, experimentId: config.id, serverId: config.serverId, operationId: input.operationId, environmentId: 'training',
          deploymentId: materials.submission.deploymentId, startedAt, deadline: startedAt + 1800000, updatedAt: Date.now(),
          exitConfirmed: !waiting && !pending, exitCode: waiting || pending ? null : operation.state === 'completed' ? 0 : 1, admissionReleased: !waiting && !pending },
        operation: { version: 1, experimentId: config.id, serverId: config.serverId, operationId: operation.operationId,
          environmentId: 'training', requestHash: 'a'.repeat(64), action: operation.action, state: operation.state,
          commandId: 'environment-' + operation.operationId, startedAt, updatedAt: startedAt, exitConfirmed: operation.exitConfirmed,
          exitCode: operation.exitConfirmed ? operation.state === 'completed' ? 0 : 1 : null, detail: operation.detail,
          ...(operation.failure === undefined ? {} : { failure: operation.failure }) },
        detail: waiting ? 'Installer receipt written; waiting for process-group exit' : pending ? 'Original startup outcome unconfirmed; recover this operation' : operation.detail }
    }
    else if (req.url.endsWith('environment-recover')) {
      value = operations.find(row => row.operationId === input.operationId)
      assert.ok(value, 'Recovery must refer to an original operation')
      value = { ...value, state: 'blocked', exitConfirmed: true, exitCode: null,
        recovery: { version: 1, state: 'verification-required', updatedAt: 100 },
        detail: 'Original startup rejected; verified materials retained; original receipt preserved, program verification required under the same training identity' }
    }
    else {
      const repeated = operations.find(row => row.operationId === input.operationId)
      value = repeated ?? { operationId: input.operationId, action: input.action, environmentId: input.environmentId,
        startedAt: Date.now(),
        state: input.requirements.includes('pending-fixture==1') ? 'requested' : input.requireCuda || input.requirements.includes('broken-fixture==1') ? 'blocked' : 'completed',
        exitConfirmed: !input.requirements.includes('pending-fixture==1'), downloadBytes: 0, reuseChecked: true,
        detail: input.requirements.includes('borrow-fixture==1') ? 'CPU fixture: read-only verified historical environment, no installer and zero download' : input.requireCuda ? 'CPU fixture: required CUDA access is unavailable' : input.requirements.includes('broken-fixture==1')
          ? 'CPU fixture: incompatible dependency import failed; original environment retained' : 'CPU fixture: mandatory reuse plan checked, environment verified, user-site disabled, hardlink payload checked',
        environment: { python: '/owned/env/python/bin/python', verification: { verified: !input.requireCuda } } }
      if (repeated === undefined) operations.push(value)
      if (input.requirements.includes('shared-conflict-fixture==1')) {
        const original = operations.find(row => row !== value && row.failure?.code === 'shared-content-conflict')
        value.state = 'blocked'; value.exitConfirmed = true
        value.failure = { version: 1, experimentId: config.id, serverId: config.serverId, operationId: input.operationId,
          environmentId: 'training', requestHash: 'a'.repeat(64), contextHash: 'b'.repeat(64), requirementsHash: 'c'.repeat(64), inputRequirementsHash: 'c'.repeat(64),
          packages: ['d'.repeat(64)], path: 'packaging/__init__.py', detail: 'Shared package collision requires its reported cause to change', createdAt: value.startedAt,
          code: original === undefined ? 'shared-content-conflict' : 'unchanged-failure',
          ...(original === undefined ? {} : { previousOperationId: original.operationId }) }
        value.detail = original === undefined ? 'Shared package collision; original environment and verified materials retained'
          : 'Unresolved dependency conflict from original operation; changing operation ID or create/install does not repair it'
      }
    }
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value))
  } }))
}

function environmentResponses(config, observed, expected) {
  const mutation = (action, requirements = [], requireCuda = false) => ['prepare_experiment_environment', { server_id: config.serverId,
    json: JSON.stringify({ operationId: randomUUID(), environmentId: 'training', action, requirements, modules: ['tiny_fixture'], requireCuda }) }]
  const firstInstall = mutation('install', ['tiny-fixture==1'])
  const pending = mutation('install', ['pending-fixture==1'])
  const pendingId = JSON.parse(pending[1].json).operationId
  const collision = mutation('install', ['shared-conflict-fixture==1'])
  const collisionRetry = mutation('create', ['shared-conflict-fixture==1'])
  const budgetId = randomUUID(), materialOperationId = randomUUID()
  const actions = [
    ['read_framework_guidance', { framework: 'unsloth' }],
    ['inspect_experiment_environment', { server_id: randomUUID() }],
    mutation('create'), firstInstall, firstInstall, mutation('install', ['broken-fixture==1']), pending,
    ['inspect_experiment_environment', { server_id: config.serverId }],
    ['recover_experiment_environment', { server_id: config.serverId, operation_id: pendingId }],
    mutation('verify'),
    ['preview_experiment_cache_cleanup', { server_id: config.serverId }],
    ['cleanup_experiment_cache', { server_id: config.serverId, operation_id: randomUUID(), fingerprint: 'a'.repeat(64) }],
    mutation('install', ['tiny-fixture==1']), mutation('verify', [], true),
    ['inspect_experiment_environment', { server_id: config.serverId }],
    collision, collisionRetry,
    ['inspect_experiment_storage', { server_id: config.serverId, refresh: true }],
    mutation('create', ['borrow-fixture==1']),
    ['inspect_experiment_materials', { server_id: config.serverId, json: JSON.stringify({ kind: 'model', provider: 'huggingface', repository: 'fixture/model', revision: 'a'.repeat(40) }) }],
    ['assess_experiment_storage', { server_id: config.serverId, json: JSON.stringify({ operationId: budgetId, environmentId: 'training', requirements: ['borrow-fixture==1'], materialIds: ['d'.repeat(64)], outputBytes: 1024, checkpointBytes: 0 }) }],
    ['prepare_experiment_materials', { server_id: config.serverId, json: JSON.stringify({ operationId: materialOperationId, materialId: 'd'.repeat(64), budgetId, action: 'acquire' }) }],
    ['finish_experiment', { status: 'blocked', detail: 'CPU fixture has no GPU; required CUDA acceptance remains blocked' }],
  ]
  let index = 0
  return async function* (options) {
    observed.tools = (options.tools ?? []).map(tool => tool.name).sort(); assert.deepEqual(observed.tools, expected)
    const text = JSON.stringify(options.messages)
    if (index > 0) { assert.ok(text.includes('name: unsloth')); observed.guidanceRead = true }
    if (index > 1) { assert.ok(text.includes('outside this experiment allocation')); observed.environmentScopeRejected = true }
    if (index >= 4) {
      assert.ok(text.includes('mandatory reuse plan checked')); observed.environmentMandatoryReuse = true
      assert.match(text, /admissionReleased\\*":true/, 'The next model request must receive confirmed installer release')
      assert.ok(!text.includes('Installer receipt written; waiting for process-group exit'), 'Intermediate polling observations must not reach the next model request')
      observed.environmentWaitsForExit = true
    }
    if (index >= 7) { assert.ok(text.includes('incompatible dependency import failed'), text.slice(-3000)); observed.environmentDiagnosticRead = true }
    if (index >= 9) { assert.ok(text.includes('verified materials retained')); observed.environmentRecoveryRead = true }
    if (index >= 10) { assert.ok(text.includes('program verification required')); observed.environmentRecoveryVerificationRequired = true }
    if (index >= 12) { assert.ok(text.includes('models and logs retained')); observed.environmentCleanupScoped = true }
    if (index >= 14) { assert.ok(text.includes('required CUDA access is unavailable')); observed.environmentCudaBlocked = true }
    if (index >= actions.length - 1) {
      assert.ok(text.includes('unchanged-failure')); assert.ok(text.includes('previousOperationId'))
      assert.ok(text.includes('changing operation ID or create/install does not repair it'))
      assert.ok(text.includes('separate fixed-pip installer'))
      observed.environmentRepeatedConflictRejected = true; observed.environmentInstallerIsolated = true
      assert.ok(text.includes('released legacy pyenv hidden')); assert.ok(text.includes('read-only verified historical environment'))
      assert.ok(text.includes('Separate system and data volume budgets')); assert.ok(text.includes('zero downloaded bytes'))
      observed.storageAccountViewRead = true; observed.historicalReadonlyReuse = true; observed.materialWaitsForExit = true
    }
    if (index >= actions.length) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The CPU fixture is blocked at the required CUDA check; existing materials and environments are retained.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    const [name, args] = actions[index++]; observed.calls.push(name); writeFileSync(config.observed, JSON.stringify(observed))
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

function stepResponses(config, observed, expected) {
  const report = (step, state, expected_revision, detail) => ['report_experiment_step', { plan_revision: 1, step, state, expected_revision, detail }]
  const actions = [
    ['read_framework_guidance', { framework: 'unsloth' }],
    ['get_experiment_execution_progress', {}],
    ['finish_experiment', { status: 'completed' }],
    report(1, 'running', 0, 'Preparing the selected node'),
    report(1, 'completed', 0, 'Stale revision must be refused'),
    report(1, 'completed', 1, 'Framework version recorded'),
    report(2, 'blocked', 2, 'The first source is unavailable'),
    ['get_experiment_execution_progress', {}],
    report(2, 'running', 3, 'Resuming the same approved step'),
    ...(config.stepCommands ? [
      ['run_experiment_command', { server_id: config.serverId, run_id: 'probe_env', command: 'printf node-storage-fixture' }],
      ['get_experiment_commands', { wait: true }],
    ] : []),
    report(2, 'completed', 4, 'Verified short run recorded'),
    ['inspect_experiment_completion', {}],
    ['finish_experiment', { status: 'completed' }],
    ['record_experiment_execution', { json: JSON.stringify({ serverId: config.serverId, framework: 'fixture', version: 'test-version', script: 'smoke.py',
      environment: '.venv', parameters: { steps: '1' }, artifacts: [], evaluation: {} }) }],
    ['finish_experiment', { status: 'blocked', detail: 'context budget exhausted', reason: 'input-context-limit' }],
    ['record_experiment_execution', { json: JSON.stringify({ serverId: config.serverId, framework: 'fixture', version: 'test-version', script: 'smoke.py',
      environment: '.venv', parameters: { steps: '2' }, artifacts: [], evaluation: {} }) }, 'fail-write'],
    ['finish_experiment', { status: 'completed' }, 'remove-failure-directory'],
    ['record_experiment_execution', { json: JSON.stringify({ serverId: config.serverId, framework: 'fixture', version: 'test-version', script: 'smoke.py',
      environment: '.venv', parameters: { steps: '1' }, artifacts: [], evaluation: {} }) }],
    ['finish_experiment', { status: config.stepCommands ? 'completed' : 'blocked', detail: config.stepCommands ? undefined : 'No successful settled commands; step reports cannot substitute for command acceptance' }],
  ]
  let index = 0
  return async function* (options) {
    observed.tools = (options.tools ?? []).map(tool => tool.name).sort()
    assert.deepEqual(observed.tools, expected)
    assert.equal(options.model, 'qwen-execution')
    const text = JSON.stringify(options.messages)
    if (index >= 1) { assert.ok(text.includes('name: unsloth')); observed.guidanceRead = true }
    if (index >= 3) { assert.ok(text.includes('lack completed reports')); observed.missingCompletionRejected = true }
    if (index >= 5) { assert.ok(text.includes('read the latest revision')); observed.staleReportRejected = true }
    if (index >= 8) { assert.ok(text.includes('The first source is unavailable')); observed.blockedStepRecorded = true }
    if (index === actions.length - 1) {
      assert.ok(text.includes('has no recorded framework'), 'Omitted execution evidence must reach the Agent before completion')
      assert.ok(text.includes('An execution record write has not committed'), 'A write failure must block completion even when an earlier valid entry exists')
      observed.executionOmissionCorrected = true
      observed.executionWriteFailureCorrected = true
      assert.ok(text.includes('claimed budget failure is unconfirmed'), 'A free-text context claim must not end the Goal')
      observed.unconfirmedBudgetCorrected = true
    }
    if (index >= actions.length) {
      const results = options.messages.filter(message => message.role === 'tool')
      const result = JSON.parse(results.at(-1).content)
      assert.ok(['completed', 'blocked'].includes(result.state), 'Goal stayed active after the expected completion: ' + JSON.stringify(results).slice(-5000))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Actual execution records and independent completion checks are saved.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const [name, args, control] = actions[index++]
    if (control === 'fail-write') mkdirSync(resolve(config.runRoot, 'execution-record-pending.v1.json'))
    if (control === 'remove-failure-directory') rmdirSync(resolve(config.runRoot, 'execution-record-pending.v1.json'))
    observed.calls.push(name); writeFileSync(config.observed, JSON.stringify(observed))
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
