/** Keyless replay provider for the actual Aspera worker profile and scoped tools. */
import assert from 'node:assert/strict'
import { writeFileSync, renameSync, readFileSync } from 'node:fs'
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
  if (config.nodeCommands) await installCpuNode(ctx, config)
  if (config.stepReports) await installStepCoordinator(ctx, config)
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
  const materialPath = resolve(root, 'secrets', config.id + '.json')
  const materials = JSON.parse(readFileSync(materialPath, 'utf8'))
  materials.submission.coordinator.remotePort = ctx.webServer.port
  materials.submission.nodes[0].server.remotePort = ctx.webServer.port
  writeFileSync(materialPath, JSON.stringify(materials))
  const tokenFile = resolve(root, 'secrets/node-replay.token')
  writeFileSync(tokenFile, materials.connections[0].token)
  let launches = 0
  const nodeContext = { storage: ctx.storage, webServer: ctx.webServer, logger: ctx.logger,
    effect: ctx.effect.bind(ctx), subprocess: { spawn(spec) {
      assert.equal(spec.argv.at(-1), 'printf node-storage-fixture')
      launches += 1
      const recorded = JSON.parse(readFileSync(config.observed, 'utf8'))
      writeFileSync(config.observed, JSON.stringify({ ...recorded, nodeLaunches: launches }))
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const done = Promise.withResolvers()
      queueMicrotask(() => {
        stdout.end('CPU command output\n'); stderr.end('CPU command diagnostic\n')
        done.resolve({ exitCode: 0, signal: null })
      })
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
    'record_experiment_execution', 'report_experiment_progress', 'get_experiment_execution_progress', 'report_experiment_step', 'start_inference_service', 'get_inference_services', 'finish_experiment']
  const expected = [...knowledge, ...(config.semi ? ['ask_user_question'] : []), ...(config.planning ? ['save_experiment_plan'] : execution)].sort()
  if (config.stepReports) return stepResponses(config, observed, expected)
  let step = 0
  let rounds = 0
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
      assert.ok(text.includes('"state":"running"'), 'The real node must accept the first command')
      assert.ok(!text.includes('not path-safe'))
      observed.commandsAccepted = true
      if (step >= 6) { assert.ok(text.includes('"state":"completed"')); assert.equal(observed.nodeLaunches, 1); observed.commandDeduplicated = true }
      if (step >= 7) { assert.ok(text.includes('CPU command output')); assert.ok(text.includes('CPU command diagnostic')); observed.nodeLogRead = true }
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
      if (actionStep <= 4) { name = 'run_experiment_command'; args = { server_id: config.serverId, run_id: 'probe_env', command: 'printf node-storage-fixture' } }
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
    ['record_experiment_execution', { json: JSON.stringify({ serverId: config.serverId, framework: 'fixture', version: 'test-version', script: 'smoke.py',
      environment: '.venv', parameters: { steps: '1' }, artifacts: [], evaluation: {} }) }],
    report(2, 'completed', 4, 'Verified short run recorded'),
    ['finish_experiment', { status: 'completed' }],
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
    if (index >= actions.length) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Actual plan-step reports are saved for independent acceptance.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const [name, args] = actions[index++]
    observed.calls.push(name); writeFileSync(config.observed, JSON.stringify(observed))
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}
