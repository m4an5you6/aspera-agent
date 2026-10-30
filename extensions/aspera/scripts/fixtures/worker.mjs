/** Keyless replay provider for the actual Aspera worker profile and scoped tools. */
import assert from 'node:assert/strict'
import { writeFileSync, renameSync, readFileSync, mkdirSync, rmdirSync, existsSync } from 'node:fs'
import { randomUUID, createHash } from 'node:crypto'
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
  if (config.typedRejection) ctx.effect(() => {
    const original = globalThis.fetch, url = `https://huggingface.co/aspera-cpu-doc/${config.id}`
    globalThis.fetch = async (input, init) => {
      if (String(input) !== url) return original(input, init)
      assert.equal(init.redirect, 'error'); assert.equal(init.credentials, 'omit')
      const saved = JSON.parse(readFileSync(config.observed, 'utf8'))
      saved.documentationFetches = (saved.documentationFetches ?? 0) + 1
      writeFileSync(config.observed, JSON.stringify(saved))
      return new Response('Fixed CPU documentation version 4.5.3\n'.repeat(64))
    }
    return () => { globalThis.fetch = original }
  })
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
      if (config.commandAdmission && req.url.split('?')[0] === '/aspera/v4/node/run') {
        assert.equal(req.headers.authorization, `Bearer ${materials.connections[0].token}`)
        let input = ''; for await (const chunk of req) input += chunk
        const body = JSON.parse(input); assert.equal(body.experimentId, config.id)
        res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'Stored mount differs', admission: {
          version: 1, formatVersion: '0.1.3', experimentId: config.id, serverId: config.serverId, commandId: body.commandId,
          requestHash: createHash('sha256').update(body.command).digest('hex'), state: 'rejected', processState: 'not-started', checkedAt: 1, detail: 'Stored mount differs',
        } })); return
      }
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
      if (config.commandAdmission) { assert.ok(spec.argv.includes('--size')); assert.ok(!spec.argv.includes('--bind')); assert.ok(!spec.argv.includes('--dev-bind')) }
      if (config.commandAdmission) { assert.equal(spec.argv[spec.argv.lastIndexOf('TMPDIR') + 1], '/tmp'); assert.ok(!spec.argv.includes('--symlink')) }
      else { assert.equal(spec.argv[spec.argv.lastIndexOf('TMPDIR') + 1], '/tmp/aspera'); assert.ok(spec.argv.includes('--symlink')) }
      launches += 1
      const recorded = JSON.parse(readFileSync(config.observed, 'utf8'))
      if (config.stageRetries && launches === 3) {
        const checkpoint = resolve(config.runRoot, 'workspace/attempt2/checkpoint-2')
        assert.ok(spec.argv.some((value, index) => value === '--ro-bind' && spec.argv[index + 1] === checkpoint && spec.argv[index + 2] === checkpoint))
        recorded.successfulCheckpointReadOnly = true
      }
      writeFileSync(config.observed, JSON.stringify({ ...recorded, nodeLaunches: launches, privateTemporaryPaths: true }))
      const stdout = new PassThrough(); const stderr = new PassThrough()
      const done = Promise.withResolvers()
      const exitCode = config.stageRetries && launches === 1 ? 1 : 0
      const finish = () => {
        if (config.stageRetries && exitCode === 0 && launches === 2) {
          const directory = resolve(config.runRoot, 'workspace/attempt2')
          mkdirSync(directory, { recursive: true })
          writeFileSync(resolve(directory, 'state.json'), JSON.stringify({ global_step: 2 }))
          writeFileSync(resolve(directory, 'metrics.jsonl'), [{ step: 1, loss: 1, learning_rate: 0.00005 },
            { step: 2, loss: 0.9, learning_rate: 0 }].map(value => JSON.stringify({ ...value, attempt_id: 'smoke-evidence' })).join('\n') + '\n')
          writeFileSync(resolve(directory, 'eval.json'), JSON.stringify({ n: 2, eval_loss: 0.9, adapter_path: 'attempt2/checkpoint-2', attempt_id: 'smoke-evidence' }))
          writeFileSync(resolve(directory, 'inference.jsonl'), ['First synthetic response', 'Second synthetic response']
            .map(response => JSON.stringify({ adapter_path: 'attempt2/checkpoint-2', response, attempt_id: 'smoke-evidence' })).join('\n') + '\n')
          writeFileSync(resolve(directory, 'train.log'), 'CPU replay synthetic training evidence\n')
          mkdirSync(resolve(directory, 'checkpoint-2'), { recursive: true })
          for (const name of ['trainer_state.json', 'adapter_model.safetensors', 'optimizer.pt', 'scheduler.pt']) {
            writeFileSync(resolve(directory, 'checkpoint-2', name), name === 'trainer_state.json' ? '{"global_step":2}' : 'CPU checkpoint fixture')
          }
        }
        if (config.commandWait) {
          const current = JSON.parse(readFileSync(config.observed, 'utf8'))
          assert.equal(current.calls.length, recorded.calls.length, 'The model must not dispatch another tool while this command is running')
          writeFileSync(config.observed, JSON.stringify({ ...current, exclusiveWaitNoModelPolls: true }))
        }
        stdout.end('CPU command output\n'); stderr.end('CPU command diagnostic\n')
        done.resolve({ exitCode, signal: null })
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
function baseWorkerResponses(config, observed) {
  const knowledge = ['get_experiment_requirements', 'read_experiment_input', 'read_framework_documentation', 'read_framework_guidance']
  const execution = ['run_experiment_command', 'get_experiment_commands', 'read_experiment_file', 'list_experiment_files',
    'run_experiment_command_group', 'run_experiment_diagnostic', 'write_experiment_evidence', 'verify_experiment_storage', 'register_experiment_stage', 'verify_experiment_stage',
    'record_experiment_execution', 'report_experiment_progress', 'get_experiment_execution_progress', 'report_experiment_step', 'start_inference_service', 'stop_inference_service', 'get_inference_services', 'verify_inference_service', 'inspect_inference_checkpoints', 'prepare_inference_checkpoint', 'finish_experiment', 'inspect_experiment_completion',
    'inspect_experiment_environment', 'prepare_experiment_environment', 'recover_experiment_environment',
    'preview_experiment_cache_cleanup', 'cleanup_experiment_cache', 'inspect_experiment_storage', 'assess_experiment_storage',
    'inspect_experiment_materials', 'prepare_experiment_materials', 'get_experiment_storage_policy', 'propose_experiment_storage_policy']
  const expected = [...knowledge, ...(config.semi ? ['ask_user_question'] : []), ...(config.planning ? ['save_experiment_plan', 'get_experiment_plan_schema', 'read_experiment_plan_draft', 'update_experiment_plan_draft', 'validate_experiment_plan_draft'] : execution)].sort()
  if (config.inferencePlan) return inferencePlanResponses(config, observed, expected)
  if (config.planningDraft) return planningDraftResponses(config, observed, expected)
  if (config.managedEnvironments) return environmentResponses(config, observed, expected)
  if (config.inferenceCheckpoint) return inferenceCheckpointResponses(config, observed, expected)
  if (config.stepReports) return stepResponses(config, observed, expected)
  if (config.commandAdmission) return admissionResponses(config, observed, expected)
  if (config.stageRetries) return stageRetryResponses(config, observed, expected)
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
    if (step >= 3) { assert.ok(JSON.stringify(options.messages).includes('dataset row')); observed.inputRead = true }
    if (config.serviceLifecycle && step >= 5) {
      assert.ok(JSON.stringify(options.messages).includes('service is outside this experiment'))
      observed.serviceStopOwnershipChecked = true
    }
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
    if ((config.planning && actionStep >= 4) || (!config.planning && actionStep >= (config.nodeCommands ? 9 : config.serviceLifecycle ? 6 : 5))) {
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
      args = { status: 'completed', plan: { summary: 'Version-specific keyless plan', steps: ['Prepare the isolated framework environment', 'Verify a short run'],
        frameworks: [{ name: 'unsloth', version: 'test-version', documentation: 'https://unsloth.ai/docs' }] } }
    } else if (config.nodeCommands && actionStep < 7) {
      if (actionStep <= 4) { name = config.commandGroup ? 'run_experiment_command_group' : 'run_experiment_command'; args = config.commandGroup ? { json: JSON.stringify(group) } : { server_id: config.serverId, run_id: 'probe_env', command: 'printf node-storage-fixture' } }
      else if (actionStep === 5) { name = 'get_experiment_commands'; args = { wait: true } }
      else { name = 'read_experiment_file'; args = { server_id: config.serverId, offset: 0 } }
    } else if (actionStep === 3 || (config.nodeCommands && actionStep === 7)) {
      name = 'record_experiment_execution'
      args = { json: JSON.stringify({ serverId: config.serverId, framework: 'fixture', version: 'test-version', script: 'smoke.py',
        environment: '.venv', parameters: { steps: '1' }, artifacts: [], evaluation: {} }) }
    } else if (config.serviceLifecycle && actionStep === 4) {
      name = 'stop_inference_service'; args = { server_id: config.serverId, service_id: '11111111-1111-4111-8111-111111111111' }
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

/** Replay an Agent that receives correction diagnostics without repeating completed work. */
export function workerResponses(config, observed) {
  const respond = baseWorkerResponses(config, observed)
  return async function* (options) {
    if (config.outputLimitOnce && !observed.outputLimitRecovered && observed.nodeLaunches >= 1) {
      observed.outputLimitRecovered = true
      writeFileSync(config.observed, JSON.stringify(observed))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The response reached its single-output limit.' } }
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    const resultMessage = options.messages.filter(message => message.role === 'tool').at(-1)
    const text = typeof resultMessage?.content === 'string' ? resultMessage.content : (resultMessage?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
    let result
    try { result = JSON.parse(text || 'null') }
    catch (error) { if (!(error instanceof SyntaxError)) throw error }
    if (result?.state === 'active' && result.decision?.decision === 'unconfirmed' && ['agent-report', 'requirement'].includes(result.decision.reason)) {
      const assistant = options.messages.filter(message => message.role === 'assistant').at(-1)
      const calls = assistant?.tool_calls ?? (Array.isArray(assistant?.content) ? assistant.content.filter(block => block.type === 'tool-call') : [])
      const original = calls.find(call => call.id === (resultMessage.tool_call_id ?? resultMessage.toolCallId))
      const name = original?.function?.name ?? original?.name
      assert.equal(name, 'finish_experiment')
      observed.unverifiedBlockCorrections = (observed.unverifiedBlockCorrections ?? 0) + 1
      assert.ok(observed.unverifiedBlockCorrections <= 2)
      observed.calls.push(name); writeFileSync(config.observed, JSON.stringify(observed))
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: original.function?.arguments ?? original.arguments } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield* respond(options)
  }
}

/** Exercise recovery tools against the actual legacy CPU node without fabricating a ready snapshot. */
function inferenceCheckpointResponses(config, observed, expected) {
  const sourceId = '11111111-1111-4111-8111-111111111111'
  const actions = [
    ['read_framework_guidance', { framework: 'unsloth' }],
    ['inspect_inference_checkpoints', { server_id: config.serverId, source_experiment_id: sourceId }],
    ['prepare_inference_checkpoint', { server_id: config.serverId, json: JSON.stringify({ sourceExperimentId: sourceId, checkpointId: 'a'.repeat(64), operationId: randomUUID() }) }],
    ['finish_experiment', { status: 'blocked', detail: 'CPU replay has neither an authorized retained producer nor required CUDA access.' }],
  ]
  let step = 0
  return async function* (options) {
    observed.tools = options.tools.map(tool => tool.name).sort(); assert.deepEqual(observed.tools, expected)
    const text = JSON.stringify(options.messages)
    if (step >= 1) { assert.ok(text.includes('name: unsloth')); observed.guidanceRead = true }
    if (step >= 2) { assert.ok(text.includes('Checkpoint source is outside the assigned server history')); observed.foreignCheckpointRefused = true }
    if (step >= 3) { assert.ok(text.includes('Inference snapshots require a protocol-4 storage assignment')); observed.legacySnapshotRefused = true }
    if (step >= actions.length) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The original source remains unchanged; this CPU replay cannot publish a verified adapter.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const [name, args] = actions[step++]; observed.calls.push(name); writeFileSync(config.observed, JSON.stringify(observed))
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** Replay a failed-and-released attempt followed by program-validated registration of its successor. */
function stageRetryResponses(config, observed, expected) {
  const original = { stageId: 'smoke', serverId: config.serverId, attemptId: 'attempt1', attemptLabel: 'smoke-evidence', commandId: 'train-first',
    parameters: 'stage-args.json', trainerState: 'attempt1/state.json', metrics: 'attempt1/metrics.jsonl', evaluation: 'attempt1/eval.json', inference: 'attempt1/inference.jsonl' }
  const next = { ...original, attemptId: 'attempt2', commandId: 'train-second', trainerState: 'attempt2/state.json', metrics: 'attempt2/metrics.jsonl',
    evaluation: 'attempt2/eval.json', inference: 'attempt2/inference.jsonl' }
  const retry = { ...next, previousAttemptId: original.attemptId }
  const actions = [
    ['read_framework_guidance', { framework: 'unsloth' }],
    ['register_experiment_stage', { json: JSON.stringify({ ...original, inference: undefined }) }],
    ['register_experiment_stage', { json: JSON.stringify(original) }],
    ['run_experiment_command', { server_id: config.serverId, run_id: original.commandId, command: 'printf node-storage-fixture' }],
    ['register_experiment_stage', { json: JSON.stringify(next) }],
    ['register_experiment_stage', { json: JSON.stringify(retry) }],
    ['register_experiment_stage', { json: JSON.stringify(retry) }],
    ['run_experiment_command', { server_id: config.serverId, run_id: retry.commandId, command: 'printf node-storage-fixture' }],
    ['verify_experiment_stage', { json: JSON.stringify({ serverId: config.serverId, stageId: original.stageId }) }],
    ['verify_experiment_stage', { json: JSON.stringify({ serverId: config.serverId, stageId: original.stageId }) }],
    ['run_experiment_command', { server_id: config.serverId, run_id: 'format-evidence', command: 'printf node-storage-fixture' }],
    ['finish_experiment', { status: 'blocked', detail: 'CPU replay lacks real training metrics and GPU acceptance; a successful retry command alone is insufficient.' }],
  ]
  const anchor = resolve(config.runRoot, 'stage-acceptance-v1', config.serverId + '_smoke.registration.json')
  const successor = resolve(config.runRoot, 'stage-attempts-v1', config.serverId + '_smoke', 'attempt1.json')
  let step = 0, anchorBytes, successorBytes
  return async function* (options) {
    observed.tools = options.tools.map(tool => tool.name).sort(); assert.deepEqual(observed.tools, expected)
    const stageTool = options.tools.find(tool => tool.name === 'register_experiment_stage')
    assert.ok(stageTool.description.includes('not its directory') && stageTool.description.includes('learning_rate')
      && stageTool.description.includes('eval_loss') && stageTool.description.includes('JSONL'))
    observed.stageEvidenceFormatRead = true
    assert.ok(stageTool.description.includes('original native TrainerState') && stageTool.description.includes('approved later continuation points'))
    observed.stageSavingPolicyRead = true
    const text = JSON.stringify(options.messages)
    if (step > 0) { assert.ok(text.includes('name: unsloth')); observed.guidanceRead = true }
    if (step === 2) {
      assert.ok(text.includes('missing approved evidence filenames: inference')); assert.equal(existsSync(anchor), false)
      observed.missingStageEvidenceCorrectedBeforeLaunch = true
    }
    if (step === 3) anchorBytes = readFileSync(anchor, 'utf8')
    if (step === 4) { assert.ok(text.includes('failed')); assert.equal(observed.nodeLaunches, 1) }
    if (step === 5) { assert.ok(text.includes('retry requires previousAttemptId=attempt1')); assert.equal(existsSync(successor), false); observed.stageRetryCorrectionRead = true }
    if (step === 6) {
      successorBytes = readFileSync(successor, 'utf8')
      const saved = JSON.parse(successorBytes)
      assert.equal(saved.previousCommand.exitCode, 1); assert.equal(saved.previousCommand.released, true)
      assert.equal(saved.registration.attemptId, retry.attemptId); assert.equal(readFileSync(anchor, 'utf8'), anchorBytes)
      observed.stageRetryAccepted = true; observed.originalStageAttemptPreserved = true
    }
    if (step === 7) { assert.equal(readFileSync(successor, 'utf8'), successorBytes); observed.stageRetryIdempotent = true }
    if (step === 8) { assert.equal(observed.nodeLaunches, 2); observed.failedStageCommandNotReplayed = true }
    if (step === 9) {
      const checked = JSON.parse(readFileSync(resolve(config.runRoot, 'stage-acceptance-v1', config.serverId + '_smoke.verification.json'), 'utf8'))
      assert.equal(checked.attemptId, retry.attemptId); assert.equal(checked.ready, true)
      assert.ok(checked.checks.some(value => value.code === 'inference' && value.passed))
      assert.equal(checked.sources.find(value => value.path === retry.metrics).purpose, 'training')
      assert.notEqual(retry.trainerState, 'attempt2/checkpoint-2/trainer_state.json')
      assert.equal(checked.sources.find(value => value.path === retry.trainerState).sha256,
        checked.sources.find(value => value.path === 'attempt2/checkpoint-2/trainer_state.json').sha256)
      observed.nativeCheckpointAliasVerified = true
      observed.structuredArtifactEvidenceRead = true; observed.jsonlReloadEvidenceRead = true
      writeFileSync(resolve(config.runRoot, 'workspace/attempt2/metrics.jsonl'), [
        { step: 1, loss: 1, learning_rate: 0.00005, attempt_id: retry.attemptId },
        { step: 2, loss: 0.9, learning_rate: 0, attempt_id: retry.attemptId },
      ].map(row => JSON.stringify(row)).join('\n') + '\n')
    }
    if (step === 10) {
      const checked = JSON.parse(readFileSync(resolve(config.runRoot, 'stage-acceptance-v1', config.serverId + '_smoke.verification.json'), 'utf8'))
      assert.equal(checked.attemptId, retry.attemptId); assert.equal(checked.ready, false)
      assert.ok(checked.checks.some(value => value.code === 'metrics' && !value.passed))
      const detail = checked.checks.find(value => value.code === 'metrics').detail
      for (const value of [retry.metrics, retry.attemptId, retry.attemptLabel]) assert.ok(detail.includes(value))
      assert.ok(text.includes('expected attemptLabel=')); observed.stageLabelDiagnosticRead = true
      observed.independentStageEvidenceStillRequired = true
    }
    if (step === 11) assert.equal(observed.successfulCheckpointReadOnly, true, 'Evidence formatting must retain the successful recovery checkpoint')
    if (step >= actions.length) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Retry registration passed; independent training evidence remains missing.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    const [name, args] = actions[step++]; observed.calls.push(name); writeFileSync(config.observed, JSON.stringify(observed))
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** The formal planner repairs inference classification without manufacturing historical training requirements. */
function inferencePlanResponses(config, observed, expected) {
  const plan = { summary: 'Restore an existing adapter and serve real inference; no new training',
    frameworks: [{ name: 'transformers', version: 'fixture', documentation: 'https://huggingface.co/docs/transformers/' }],
    steps: ['Inspect the retained checkpoint', 'Serve authenticated generation'] }
  const calls = [
    ['read_experiment_input', { name: 'acceptance-source.json', offset: 0 }],
    ['read_framework_guidance', { framework: 'swift' }],
    ['save_experiment_plan', { status: 'completed', plan }],
    ['get_experiment_plan_schema', { section: 'workload' }],
    ['update_experiment_plan_draft', { requestId: 'declare-inference', expectedRevision: 1, workload: 'inference' }],
    ['validate_experiment_plan_draft', {}],
    ['save_experiment_plan', { status: 'completed', draft_revision: 2 }],
  ]
  let step = 0
  return async function* (options) {
    observed.tools = options.tools.map(tool => tool.name).sort(); assert.deepEqual(observed.tools, expected)
    const messages = JSON.stringify(options.messages)
    if (step > 0) {
      assert.ok(messages.includes('textSha256') && messages.includes('textRedacted'))
      assert.ok(!messages.includes('private-source-key')); observed.sourceTextProofRead = true
    }
    if (step > 1) { assert.ok(messages.includes('name: swift')); observed.guidanceRead = true }
    if (step > 2) { assert.ok(messages.includes('requires structured stages')); observed.classificationErrorLogged = true }
    if (step > 3) { assert.ok(messages.includes('inference')); observed.workloadSchemaRead = true }
    const calling = step < calls.length
    if (calling) {
      const [name, args] = calls[step++]
      observed.calls.push(name)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('inference-plan-' + step), name, arguments: JSON.stringify(args) } }
    } else {
      const saved = JSON.parse(readFileSync(resolve(config.runRoot, 'plan.json'), 'utf8'))
      assert.equal(saved.plan.workload, 'inference'); assert.equal(saved.plan.stages, undefined)
      assert.deepEqual(saved.plan.steps, plan.steps); assert.deepEqual(saved.plan.frameworks, plan.frameworks)
      observed.noTrainingStagesInvented = true
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Saved inference-only plan with retained checkpoint evidence.' } }
    }
    writeFileSync(config.observed, JSON.stringify(observed))
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: calling ? 'tool-calls' : 'stop' } }
  }
}

/** Repair a rejected legacy plan through the production DSH tool registry without resubmitting its text. */
function planningDraftResponses(config, observed, expected) {
  if (config.planningRequirements) return planningRequirementResponses(config, observed, expected)
  const originalSteps = ['Preserve the original approved requirement ' + 'original context '.repeat(400), 'Continue the measured stage']
  const plan = { summary: 'Draft repair replay', steps: originalSteps,
    frameworks: [{ name: 'transformers', version: 'fixture', documentation: 'https://huggingface.co/docs/transformers/' }],
    stages: [{ stageId: 'smoke', planStep: 1, title: 'Smoke', framework: 'transformers', startStep: 0, additionalSteps: 30, endStep: 30,
      metricScope: 'stage', loggingSteps: 1, scheduler: { mode: 'fresh', type: 'linear', learningRate: 0.0001, warmupSteps: 0, totalSteps: 30 },
      samples: { unit: 'sequences', meaning: 'Actual training examples', expectedCount: 30, basis: 'Actual examples', perDeviceBatchSize: 1, gradientAccumulationSteps: 1, worldSize: 1 }, results: { baseControl: 1 } }] }
  let step = 0
  return async function* (options) {
    observed.tools = (options.tools ?? []).map(tool => tool.name).sort(); assert.deepEqual(observed.tools, expected)
    const messages = JSON.stringify(options.messages)
    const planTool = options.tools.find(tool => tool.name === 'save_experiment_plan')
    const schema = JSON.stringify(planTool)
    assert.ok(schema.includes('microbatch') && schema.includes('consumed') && schema.includes('baseControl'))
    observed.typedPlanVisible = true
    const editTool = JSON.stringify(options.tools.find(tool => tool.name === 'update_experiment_plan_draft'))
    assert.ok(editTool.includes('oneOf') && editTool.includes('step') && editTool.includes('text'))
    if (step > 0) { assert.ok(messages.includes('name: unsloth')); observed.guidanceRead = true }
    const rejectedAt = config.typedRejection ? 3 : 1
    if (step > rejectedAt) { assert.ok(messages.includes('samples.unit') && messages.includes('results.baseControl')); observed.rejectedDraftSaved = true }
    if (step > rejectedAt && config.typedRejection) { assert.ok(messages.includes('invalid arguments:')); observed.originalTypeErrorRetained = true }
    if (step > rejectedAt + 1) { assert.ok(messages.includes('"revision":2') || messages.includes('\\"revision\\":2')); observed.partialRepairAccepted = true }
    if (step > rejectedAt + 2) {
      assert.ok(messages.includes('"revision":3') || messages.includes('\\"revision\\":3'))
      observed.schemaStepTextsAccepted = true
    }
    if (config.typedRejection && step > 2) {
      const documents = options.messages.flatMap(message => {
        if (typeof message.content !== 'string') return []
        try { const value = JSON.parse(message.content); return value?.url === `https://huggingface.co/aspera-cpu-doc/${config.id}` ? [value] : [] }
        catch (error) { if (error instanceof SyntaxError) return []; throw error }
      })
      assert.equal(documents.length, 2); assert.equal(documents[0].cached, false); assert.equal(documents[1].cached, true)
      assert.ok(Buffer.byteLength(documents[0].text) <= 1024)
      assert.equal(JSON.parse(readFileSync(config.observed, 'utf8')).documentationFetches, 1)
      observed.documentationCached = true; observed.documentSnapshotLimit = true
    }
    const calls = [
      ['read_framework_guidance', { framework: 'unsloth' }],
      ...(config.typedRejection ? Array.from({ length: 2 }, () => ['read_framework_documentation', { url: `https://huggingface.co/aspera-cpu-doc/${config.id}` }]) : []),
      ['save_experiment_plan', { status: 'completed', ...(config.typedRejection ? { plan } : { plan_json: JSON.stringify(plan) }) }],
      ['update_experiment_plan_draft', { requestId: 'repair-fields', expectedRevision: 1, stages: [{ stageId: 'smoke', samples: { unit: 'example', meaning: 'consumed' }, results: { baseControl: true } }] }],
      ['update_experiment_plan_draft', { requestId: 'schema-step-texts', expectedRevision: 2, steps: originalSteps }],
      ['read_experiment_plan_draft', {}], ['validate_experiment_plan_draft', {}], ['get_experiment_plan_schema', { section: 'samples' }],
      ['get_experiment_plan_schema', { section: 'stepEdits' }],
      ['save_experiment_plan', { status: 'completed', draft_revision: 3 }],
    ]
    const calling = step < calls.length
    if (calling) {
      const [name, args] = calls[step++]
      observed.calls.push(name)
      writeFileSync(config.observed, JSON.stringify(observed))
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('draft-call-' + step), name, arguments: JSON.stringify(args) } }
    } else {
      const saved = JSON.parse(readFileSync(resolve(config.runRoot, 'plan.json'), 'utf8'))
      assert.deepEqual(saved.plan.steps, originalSteps); assert.equal(saved.plan.stages[0].results.baseControl, true)
      observed.originalPlanPreserved = true
      writeFileSync(config.observed, JSON.stringify(observed))
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Saved the original plan after repairing only three fields.' } }
    }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: calling ? 'tool-calls' : 'stop' } }
  }
}

/** The actual planner receives fixed-requirement differences and repairs the same draft. */
function planningRequirementResponses(config, observed, expected) {
  const required = config.requirements, stage = required.stages[1]
  const plan = { summary: 'Actual training details remain model-authored', steps: ['Train first stage', 'Continue from checkpoint'],
    frameworks: [{ name: 'transformers', version: 'fixture', documentation: 'https://huggingface.co/docs/transformers/' }],
    stages: [required.stages[0], { ...stage, scheduler: { ...stage.scheduler, mode: 'restart' },
      samples: { unit: 'example', meaning: 'consumed', expectedCount: 1600, basis: '200*8', perDeviceBatchSize: 1, gradientAccumulationSteps: 8, worldSize: 1 } }],
    storagePolicy: { ...required.storagePolicy, checkpointCount: 5 } }
  const actions = [
    ['read_framework_guidance', { framework: 'unsloth' }],
    ['read_experiment_plan_draft', { section: 'requirements' }],
    ['save_experiment_plan', { status: 'completed', plan_json: JSON.stringify(plan) }],
    ['update_experiment_plan_draft', { requestId: 'preserve-submitted-requirements', expectedRevision: 1,
      stages: [{ stageId: stage.stageId, scheduler: { mode: 'continue' } }], removeStageFields: [{ stageId: stage.stageId, fields: ['samples'] }], storagePolicy: required.storagePolicy }],
    ['save_experiment_plan', { status: 'completed', draft_revision: 2 }],
  ]
  let index = 0
  return async function* (options) {
    observed.tools = options.tools.map(tool => tool.name).sort(); assert.deepEqual(observed.tools, expected)
    const text = JSON.stringify(options.messages)
    if (index > 0) { assert.ok(text.includes('name: unsloth')); observed.guidanceRead = true }
    if (index > 2) {
      assert.ok(text.includes('stages.1.samples') && text.includes('stages.1.scheduler.mode') && text.includes('storagePolicy.checkpointCount'))
      assert.equal(existsSync(resolve(config.runRoot, 'plan.json')), index > 4)
      observed.fixedRequirementsCorrected = true
    }
    writeFileSync(config.observed, JSON.stringify(observed))
    if (index >= actions.length) {
      const saved = JSON.parse(readFileSync(resolve(config.runRoot, 'plan.json'), 'utf8')).plan
      assert.equal(saved.stages[1].scheduler.mode, 'continue'); assert.equal(saved.stages[1].samples, undefined); assert.equal(saved.storagePolicy.checkpointCount, 3)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The Agent repaired its draft without changing the submitted user requirements.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    const [name, args] = actions[index++]; observed.calls.push(name); writeFileSync(config.observed, JSON.stringify(observed))
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** Replay explicit refusal followed by independent read-only diagnosis through real tool dispatch. */
function admissionResponses(config, observed, expected) {
  let step = 0
  const actions = [
    ['read_framework_guidance', { framework: 'unsloth' }],
    ['run_experiment_command', { server_id: config.serverId, run_id: 'denied_probe', command: 'printf node-storage-fixture' }],
    ['run_experiment_diagnostic', { server_id: config.serverId, run_id: 'readonly_probe', command: 'printf node-storage-fixture' }],
    ['read_experiment_file', { server_id: config.serverId, command_id: 'readonly_probe', stream: 'stdout', offset: 0 }],
    ['read_experiment_file', { server_id: config.serverId, command_id: 'readonly_probe', stream: 'stderr', offset: 0 }],
    ['run_experiment_diagnostic', { server_id: config.serverId, run_id: 'readonly_probe', command: 'printf a-different-request' }],
    ['run_experiment_diagnostic', { server_id: config.serverId, run_id: 'fresh_probe', command: 'printf node-storage-fixture' }],
    ['finish_experiment', { status: 'blocked', detail: 'CPU replay requires verified current storage before training.' }],
  ]
  return async function* (options) {
    observed.tools = options.tools.map(tool => tool.name).sort(); assert.deepEqual(observed.tools, expected)
    const text = JSON.stringify(options.messages)
    if (step > 0) { assert.ok(text.includes('name: unsloth')); observed.guidanceRead = true }
    if (step > 1) { assert.ok(text.includes('not-started')); assert.ok(text.includes('Stored mount differs')); observed.explicitRefusalReturned = true }
    if (step > 2 && step <= 6) { assert.ok(text.includes('diagnostic')); assert.ok(text.includes('completed')); assert.equal(observed.nodeLaunches, 1); observed.diagnosticExecutedOnce = true }
    if (step > 3) { assert.ok(text.includes('CPU command output')); observed.diagnosticOutputRead = true }
    if (step > 4) { assert.ok(text.includes('CPU command diagnostic')); observed.diagnosticErrorRead = true }
    if (step > 5) { assert.ok(text.includes('different content or purpose')); observed.commandIdentityConflictRejected = true }
    if (step > 6) { assert.equal(observed.nodeLaunches, 2); observed.freshCommandExecuted = true }
    writeFileSync(config.observed, JSON.stringify(observed))
    if (step >= actions.length) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Storage remains blocked; diagnostic evidence is retained.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    const [name, args] = actions[step++]; observed.calls.push(name)
    writeFileSync(config.observed, JSON.stringify(observed))
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

/** Missing reports are repaired without repeating settled commands; independent checks still run. */
/** Simulated installer outcomes use the real profile tools and authenticated node route; no GPU claims are made. */
function installEnvironmentNode(ctx, config) {
  const retention = (policy, proposalId, revision = 1) => ({ version: 1, experimentId: config.id, serverId: config.serverId,
    proposalId, planRevision: 1, expectedRevision: revision, revision, policy, reason: 'CPU retained-content fixture', requestHash: 'a'.repeat(64), createdAt: 1, updatedAt: 1 })
  const materialPath = resolve(process.env.DSH_CLUSTER_ROOT, 'secrets', config.id + '.json')
  const materials = JSON.parse(readFileSync(materialPath, 'utf8'))
  materials.submission.coordinator.remotePort = ctx.webServer.port; materials.submission.nodes[0].server.remotePort = ctx.webServer.port
  writeFileSync(materialPath, JSON.stringify(materials))
  const operations = []
  const reads = new Map()
  let materialReads = 0
  let materialAction
  let verificationId
  let verificationRecovered = false
  let dependencyTrial = false
  let policyProposal, policyReads = 0, policyRequestCount
  const materialStartedAt = Date.now()
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/aspera/v4/node', handler: async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${materials.connections[0].token}`)
    let text = ''; for await (const chunk of req) text += chunk
    const input = JSON.parse(text); assert.equal(input.experimentId, config.id)
    let value
    if (req.url.endsWith('/status') || req.url.endsWith('/services')) value = []
    else if (req.url.endsWith('environment-acceptance')) value = { verified: false, detail: 'CPU fixture: required CUDA access is unavailable' }
    else if (req.url.endsWith('storage-inspect')) {
      assert.equal(input.scope.kind, 'directory')
      value = { complete: false, scope: input.scope, cursor: 'more-unrelated-content', materialCandidates: [{ id: 'f'.repeat(64) }],
        diagnostic: 'Account-side catalog sees the released legacy pyenv hidden in ordinary commands; targeted candidate does not require full discovery', historicalEnvironments: [{ id: 'c'.repeat(64), reusable: false }] }
    }
    else if (req.url.endsWith('material-inspect')) {
      assert.equal(input.reuseCandidateId, undefined)
      value = { id: 'd'.repeat(64), revision: 'a'.repeat(40), missingBytes: 4096, verifiedBytes: 0,
        detail: 'Default assets lack 4096 bytes; historical sources were not selected or evaluated' }
      if (input.provider === 'modelscope') {
        assert.equal(input.kind, 'dataset'); assert.equal(input.revision, 'b'.repeat(40))
        value = { id: 'e'.repeat(64), revision: input.revision, provider: 'modelscope',
          detail: 'Official ModelScope Git commit and tree attested; node file checks are still required' }
      }
    }
    else if (req.url.endsWith('storage-policy-status')) {
      if (policyProposal !== undefined) {
        assert.equal(Number(readFileSync(config.observed + '.requests', 'utf8')), policyRequestCount, 'A pending retention decision must not cause another model request')
        if (++policyReads >= 2) {
          policyProposal = { ...policyProposal, state: 'rejected' }
          writeFileSync(config.observed + '.policy-confirmation', JSON.stringify({ reads: policyReads, hostDecision: 'rejected', sameModelRequestCount: true }))
        }
      }
      value = { current: { ...retention({ artifact: 'adapter', checkpointCount: 2,
      optimizerState: true, schedulerState: true, recoveryPoints: ['checkpoint-30', 'checkpoint-230'], outputMinimumBytes: 0, checkpointMinimumBytes: 0,
      basis: 'Approved fixture policy' }, '10000000-0000-4000-8000-000000000003'), state: 'approved' }, proposals: policyProposal === undefined ? [] : [policyProposal] }
    }
    else if (req.url.endsWith('storage-policy-propose')) {
      policyRequestCount = Number(readFileSync(config.observed + '.requests', 'utf8'))
      policyProposal = { ...retention(input.policy, input.operationId, input.expectedRevision), reason: input.reason, state: 'pending' }; value = policyProposal
    }
    else if (req.url.endsWith('storage-policy-decide')) {
      throw new Error('An automatic Agent must wait for the Host decision instead of deciding a retention reduction itself')
    }
    else if (req.url.endsWith('storage-assess')) {
      assert.equal(input.materialSources, undefined, 'The program selects the settled equivalent source')
      value = { state: 'ready', operationId: input.operationId,
        materialSources: [{ materialId: 'd'.repeat(64), verificationOperationId: verificationId, mode: 'readonly' }],
        coverage: { scope: 'declared', complete: false, coveredMaterialIds: input.materialIds, unresolved: [] },
        materialEstimates: [{ materialId: 'd'.repeat(64), mode: 'readonly', totalBytes: 4096, verifiedReusableBytes: 4096, confirmedMissingBytes: 0, unknownBytes: 0, newPeakBytes: 0 }],
        detail: 'Separate system and data volume budgets; declared scope does not establish whole-experiment readiness' }
      if (input.requirements.includes('environment:training')) {
        dependencyTrial = true
        value.state = 'requirements-pending'
        value.detail = 'Trial requirements are not published environment requirements; inspect the registered dependency set'
      } else if (dependencyTrial && input.mode === 'commit') {
        value.state = input.requirements.includes('borrow-fixture==1') ? 'ready' : 'requirements-pending'
        value.detail = value.state === 'ready' ? 'Corrected dependency trial uses published environment requirements'
          : 'Registered environment requirements are omitted: borrow-fixture==1; retain the registered dependency set'
      }
    }
    else if (req.url.endsWith('material-prepare')) {
      if (input.action === 'recover') {
        assert.equal(input.operationId, verificationId)
        assert.equal(input.budgetId, undefined)
        verificationRecovered = true
      } else materialAction = input.action
      if (materialAction === 'verify') {
        assert.equal(input.budgetId, undefined); assert.equal(input.reuseCandidateId, undefined); verificationId = input.operationId
      }
      value = { state: 'running', operationId: input.operationId }
    }
    else if (req.url.endsWith('material-status')) {
      materialReads += 1
      value = { version: 1, experimentId: config.id, serverId: config.serverId, operationId: input.operationId, materialId: 'd'.repeat(64),
        requestHash: 'e'.repeat(64), state: materialReads < 3 ? 'running' : 'completed', startedAt: materialStartedAt, deadline: materialStartedAt + 7200000,
        updatedAt: Date.now(), downloadedBytes: 0, reusedBytes: 4096, exitConfirmed: materialReads >= 3, admissionReleased: materialReads >= 3,
        reuse: { state: materialReads >= 3 ? 'verified' : 'discovering', complete: materialReads >= 3, additionalBytes: 0, diagnostics: [] },
        detail: materialAction === 'verify' ? 'Canonical files verified read-only without a download budget or publication' : 'Read-only material published with zero downloaded bytes' }
      if (input.operationId === verificationId && materialReads >= 3 && !verificationRecovered) {
        value.admissionReleased = false
        value.settlementError = 'Original verifier exited; settlement requires recovery of this operation'
      }
    }
    else if (req.url.endsWith('environment-inspect')) value = { version: 1, experimentId: config.id, serverId: config.serverId,
      checkedAt: Date.now(), operations: [], launches: [], storage: { serverId: config.serverId, name: 'CPU fixture', checkedAt: Date.now(), source: 'remote',
      availableBytes: 100000, capacityBytes: 200000, workspaceBytes: 0, sharedBytes: 0, reclaimableBytes: 0,
      environments: [], legacy: [], operations: [], complete: false, error: 'CPU fixture environment inspection',
      repairPlans: operations.flatMap(row => row.repairPlans ?? []), diagnostics: operations.flatMap(row => row.diagnostics ?? []),
      materials: [{ name: 'retained-small-package', version: '1', wheelHash: 'a'.repeat(64), source: 'fixture', bytes: 32, cachedAt: 1, available: true },
        { name: 'retained-large-package', version: '1', wheelHash: 'b'.repeat(64), source: 'fixture'.repeat(5000), bytes: 0, cachedAt: 1, available: false }] } }
    else if (req.url.endsWith('environment-preview')) value = { serverId: config.serverId, fingerprint: 'a'.repeat(64), eligible: true,
      candidates: [{ id: 'temporary-fixture', kind: 'temporary', bytes: 64, reason: 'Confirmed exited owned operation' },
        { id: 'input-duplicate-' + '8'.repeat(64), kind: 'input-duplicate', bytes: 32, reason: 'Identical authenticated released input snapshots; paths and bytes retained' },
        { id: 'release-asset-duplicate-' + '7'.repeat(64), kind: 'release-asset-duplicate', bytes: 32, reason: 'Identical immutable assets from idle sealed releases; every byte retained' }],
      referenceRepairs: [{ id: '9'.repeat(64), sourceExperimentId: config.id, environmentId: 'training', eligible: true,
        detail: 'Original environment removal and process exit confirmed', checkedAt: 1 }] }
    else if (req.url.endsWith('environment-cleanup')) {
      const references = input.nodes[0].referenceRepairIds
      const inputSharing = input.nodes[0].candidateIds?.some(id => id.startsWith('input-duplicate-'))
      if (inputSharing) {
        assert.deepEqual(input.nodes[0].candidateIds, ['input-duplicate-' + '8'.repeat(64), 'release-asset-duplicate-' + '7'.repeat(64)])
      }
      if (references) { assert.deepEqual(references, ['9'.repeat(64)]); assert.deepEqual(input.nodes[0].candidateIds, []) }
      value = { serverId: config.serverId, state: 'completed', reclaimedBytes: references ? 0 : 64,
        ...(references ? { repairedReferences: references } : {}),
        detail: references ? 'Only removed-environment references confirmed; no additional files deleted; models and logs retained'
          : inputSharing ? 'Input snapshots compacted; original paths and bytes retained; idle sealed release assets compacted without deleting a release; no environment/model/log deletion'
          : 'Only owned temporary files removed; environments, models and logs retained' }
    }
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
          ...(operation.failure === undefined ? {} : { failure: operation.failure }), ...(operation.preflight === undefined ? {} : { preflight: operation.preflight }) },
        detail: waiting ? 'Installer receipt written; waiting for process-group exit' : pending ? 'Original startup outcome unconfirmed; recover this operation' : operation.detail }
      if (!waiting && operation.action === 'install' && operation.state === 'completed' && operation.detail.includes('mandatory reuse plan checked')) {
        value.operation.diagnostics = Array.from({ length: 1200 }, (_, index) => ({ version: 1, experimentId: config.id,
          serverId: config.serverId, operationId: operation.operationId, environmentId: 'training', id: index.toString(16).padStart(64, '0'),
          sourceFingerprint: 'a'.repeat(64), code: 'unreadable', checkedAt: 1,
          detail: 'retained-operation-detail-' + index + ': ' + 'original metadata '.repeat(100) }))
      }
    }
    else if (req.url.endsWith('environment-recover')) {
      value = operations.find(row => row.operationId === input.operationId)
      assert.ok(value, 'Recovery must refer to an original operation')
      value = { version: 1, experimentId: config.id, serverId: config.serverId, operationId: input.operationId,
        environmentId: 'training', requestHash: 'a'.repeat(64), action: value.action, state: 'blocked',
        commandId: 'environment-' + input.operationId, startedAt: value.startedAt, updatedAt: 100, exitConfirmed: true, exitCode: null,
        recovery: { version: 1, experimentId: config.id, serverId: config.serverId, operationId: input.operationId,
          environmentId: 'training', sourceReceiptHash: 'a'.repeat(64), state: 'verification-required', createdAt: 100, updatedAt: 100,
          detail: 'Original process exit confirmed; reverify training' },
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
      if (input.requirements.includes('legacy-corrupt-fixture==1') && input.action !== 'repair') {
        value.state = 'blocked'; value.exitConfirmed = true
        const diagnostic = { version: 1, experimentId: config.id, serverId: config.serverId, operationId: input.operationId,
          environmentId: 'training', id: '8'.repeat(64), sourceFingerprint: '7'.repeat(64), code: 'content-mismatch',
          path: 'decord-0.6.0.dist-info/top_level.txt', package: 'decord', expectedBytes: 17, actualBytes: 7,
          detail: 'Historical RECORD differs: expected 17 bytes, actual 7', checkedAt: 1 }
        const plan = { version: 1, id: '6'.repeat(64), experimentId: config.id, serverId: config.serverId,
          environmentId: 'training', sourceOperationId: input.operationId, requestHash: 'a'.repeat(64), sourceFingerprint: '7'.repeat(64),
          diagnosticIds: [diagnostic.id], strategy: 'rebuild-from-materials', requirements: input.requirements, modules: input.modules,
          requireCuda: false, packages: ['decord'], checkedAt: 1, downloadBytes: null, copyBytes: null, peakBytes: null,
          detail: 'Agent can select verified-material repair; historical source remains unchanged' }
        value.diagnostics = [diagnostic]; value.repairPlans = [plan]; value.detail = diagnostic.detail
      }
      if (input.requirements.includes('historical-incomplete-fixture==1')) {
        value.state = 'blocked'; value.exitConfirmed = true
        value.detail = 'Historical environment is missing requested distributions: av==16.1.0, qwen_vl_utils==0.0.14'
      }
      if (input.action === 'verify-reuse') {
        value.state = 'completed'; value.exitConfirmed = true
        value.preflight = { version: 1, experimentId: config.id, serverId: config.serverId, operationId: input.operationId,
          environmentId: 'training', requirements: input.requirements, status: 'reusable', checkedAt: Date.now(), additionalBytes: 0,
          detail: 'Source verified read-only; no publication or installer was started' }
        delete value.environment
      }
      if (input.requirements.includes('lock-busy-fixture==1')) {
        value.state = 'blocked'; value.exitConfirmed = true
        value.detail = 'Another environment operation holds the server package lock; inspect its receipt; dependency installation did not start'
      }
      if (input.action === 'repair') {
        assert.equal(input.repairPlanId, '6'.repeat(64)); assert.equal(input.environmentId, 'training')
        assert.equal(input.repairWheelMetadata, true)
        value.detail = 'Agent-selected repair verified; input-wheel derivation preserves code/library bytes; historical RECORD unchanged; zero large downloads'
      }
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
  const firstInstallId = JSON.parse(firstInstall[1].json).operationId
  const pending = mutation('install', ['pending-fixture==1'])
  const pendingId = JSON.parse(pending[1].json).operationId
  const collision = mutation('install', ['shared-conflict-fixture==1'])
  const collisionRetry = mutation('create', ['shared-conflict-fixture==1'])
  const lockRefusal = mutation('install', ['lock-busy-fixture==1'])
  const budgetId = randomUUID(), materialOperationId = randomUUID(), verificationId = randomUUID()
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
    ['inspect_experiment_storage', { server_id: config.serverId, refresh: true, scope_json: JSON.stringify({ kind: 'directory', rootId: 'b'.repeat(64), relativePath: 'runs/' + config.id + '/workspace/models/tiny' }) }],
    mutation('create', ['borrow-fixture==1']),
    ['inspect_experiment_materials', { server_id: config.serverId, json: JSON.stringify({ kind: 'model', provider: 'huggingface', repository: 'fixture/model', revision: 'a'.repeat(40), metadataSource: 'host' }) }],
    ['prepare_experiment_materials', { server_id: config.serverId, json: JSON.stringify({ operationId: verificationId, materialId: 'd'.repeat(64), action: 'verify' }) }],
    ['prepare_experiment_materials', { server_id: config.serverId, json: JSON.stringify({ operationId: verificationId, materialId: 'd'.repeat(64), action: 'recover' }) }],
    ['assess_experiment_storage', { server_id: config.serverId, json: JSON.stringify({ operationId: budgetId, environmentId: 'training', requirements: ['borrow-fixture==1'], materialIds: ['d'.repeat(64)], outputBytes: 1024, checkpointBytes: 0 }) }],
    ['prepare_experiment_materials', { server_id: config.serverId, json: JSON.stringify({ operationId: materialOperationId, materialId: 'd'.repeat(64), budgetId, action: 'acquire' }) }],
    ['inspect_experiment_environment', { server_id: config.serverId, details_json: 'latest-saved-material-page' }],
    ['inspect_experiment_environment', { server_id: config.serverId, details_json: 'latest-saved-oversized-material-page' }],
    ['inspect_experiment_environment', { server_id: config.serverId, details_json: 'latest-saved-inline-material-page' }],
    mutation('create', ['historical-incomplete-fixture==1']),
    mutation('create', ['legacy-corrupt-fixture==1']),
    ['inspect_experiment_environment', { server_id: config.serverId }],
    ['inspect_experiment_environment', { server_id: config.serverId, details_json: 'latest-saved-repair-page' }],
    ['prepare_experiment_environment', { server_id: config.serverId, json: JSON.stringify({
      operationId: randomUUID(), environmentId: 'training', action: 'repair', repairPlanId: '6'.repeat(64),
      requirements: ['legacy-corrupt-fixture==1'], modules: ['tiny_fixture'], requireCuda: false, repairWheelMetadata: true }) }],
    ['preview_experiment_cache_cleanup', { server_id: config.serverId }],
    ['cleanup_experiment_cache', { server_id: config.serverId, operation_id: randomUUID(), fingerprint: 'a'.repeat(64),
      candidate_ids: JSON.stringify(['input-duplicate-' + '8'.repeat(64), 'release-asset-duplicate-' + '7'.repeat(64)]) }],
    ['cleanup_experiment_cache', { server_id: config.serverId, operation_id: randomUUID(), fingerprint: 'a'.repeat(64),
      candidate_ids: '[]', reference_repair_ids: JSON.stringify(['9'.repeat(64)]) }],
    mutation('verify-reuse', ['tiny-fixture==1']),
    ['get_experiment_storage_policy', { server_id: config.serverId }],
    ['propose_experiment_storage_policy', { server_id: config.serverId, json: JSON.stringify({ operationId: randomUUID(), expectedRevision: 1,
      reason: 'Ask for a semantic checkpoint reduction', policy: { artifact: 'adapter', checkpointCount: 1, optimizerState: true, schedulerState: true,
        recoveryPoints: ['checkpoint-230'], outputMinimumBytes: 0, checkpointMinimumBytes: 0, basis: 'Fixture proposal, not an approval' } }) }],
    ['assess_experiment_storage', { server_id: config.serverId, json: JSON.stringify({ operationId: randomUUID(), mode: 'preview', environmentId: 'training', requirements: ['borrow-fixture==1'], materialIds: ['d'.repeat(64)], outputBytes: 4096, checkpointBytes: 0 }) }],
    ['inspect_experiment_materials', { server_id: config.serverId, json: JSON.stringify({ kind: 'dataset', provider: 'modelscope', repository: 'fixture/data', revision: 'b'.repeat(40), metadataSource: 'host' }) }],
    lockRefusal, lockRefusal, mutation('verify'),
    ['assess_experiment_storage', { server_id: config.serverId, json: JSON.stringify({ operationId: randomUUID(), mode: 'preview', environmentId: 'training', requirements: ['environment:training'], materialIds: ['d'.repeat(64)], outputBytes: 1024, checkpointBytes: 0 }) }],
    ['assess_experiment_storage', { server_id: config.serverId, json: JSON.stringify({ operationId: randomUUID(), mode: 'commit', environmentId: 'training', requirements: [], materialIds: ['d'.repeat(64)], outputBytes: 1024, checkpointBytes: 0 }) }],
    ['assess_experiment_storage', { server_id: config.serverId, json: JSON.stringify({ operationId: randomUUID(), mode: 'commit', environmentId: 'training', requirements: ['borrow-fixture==1'], materialIds: ['d'.repeat(64)], outputBytes: 1024, checkpointBytes: 0 }) }],
    ['inspect_experiment_environment', { server_id: config.serverId, operation_id: firstInstallId }],
    ['inspect_experiment_environment', { server_id: config.serverId, details_json: 'latest-saved-operation-page' }],
    ['finish_experiment', { status: 'blocked', detail: 'CPU fixture has no GPU; required CUDA acceptance remains blocked' }],
  ]
  let index = 0
  return async function* (options) {
    observed.tools = (options.tools ?? []).map(tool => tool.name).sort(); assert.deepEqual(observed.tools, expected)
    const text = JSON.stringify(options.messages)
    if (index > 0) { assert.ok(text.includes('name: unsloth')); observed.guidanceRead = true }
    if (index > 1) { assert.ok(text.includes('outside this experiment allocation')); observed.environmentScopeRejected = true }
    if (index === 4) {
      for (const message of options.messages) for (const block of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []) {
        if (block.type !== 'text') continue
        let value
        try { value = JSON.parse(block.text) } catch (error) { if (!(error instanceof SyntaxError)) throw error; continue }
        if (value.operationId !== firstInstallId || value.state !== 'completed') continue
        assert.equal(value.operation.diagnosticCount, 1200); assert.ok(value.details)
        assert.ok(Buffer.byteLength(block.text) <= 8192, 'The operation result must fit before DSH formatted-output spilling')
        assert.equal(value.processState, 'exited'); assert.equal(value.admissionReleased, true)
        observed.environmentOperationOutputBounded = true
      }
      assert.equal(observed.environmentOperationOutputBounded, true, 'The next model request must receive parseable completed-operation JSON')
    }
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
      assert.ok(text.includes('settlement requires recovery of this operation'))
      observed.materialRecoverySameOperation = true
      assert.ok(text.includes('targeted candidate does not require full discovery'))
      assert.ok(text.includes('without a download budget or publication'))
      assert.ok(text.includes('declared scope does not establish whole-experiment readiness'))
      assert.ok(text.includes('historical sources were not selected or evaluated'))
      observed.targetedDiscoveryWithoutFullScan = true; observed.readonlyMaterialVerificationWithoutBudget = true; observed.capacityScopeExplicit = true
      assert.ok(text.includes('retained-small-package')); observed.environmentPagedDetails = true
      for (const message of options.messages) for (const block of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []) {
        if (block.type !== 'text') continue
        try {
          const value = JSON.parse(block.text)
          if (value.fields?.find(field => field.key === 'name')?.value !== 'retained-large-package') continue
          assert.equal(value.fields.find(field => field.key === 'bytes').value, 0)
          assert.equal(value.fields.find(field => field.key === 'available').value, false)
          assert.ok(value.fields.find(field => field.key === 'source').page)
          observed.environmentInlineDetails = true
        } catch (error) { if (!(error instanceof SyntaxError)) throw error }
      }
      assert.equal(observed.environmentInlineDetails, true)
      observed.automaticMaterialSourceSelection = true; observed.materialBudgetBindsVerification = true
      assert.ok(text.includes('expected 17 bytes, actual 7'))
      assert.ok(text.includes('Agent-selected repair verified'))
      assert.ok(text.includes('historical RECORD unchanged'))
      assert.ok(text.includes('missing requested distributions: av==16.1.0, qwen_vl_utils==0.0.14'))
      observed.historicalMissingDependencyDiagnosticRead = true
      assert.ok(text.includes('no additional files deleted'))
      assert.ok(text.includes('Source verified read-only; no publication'))
      assert.ok(text.includes('Ask for a semantic checkpoint reduction'))
      assert.deepEqual(JSON.parse(readFileSync(config.observed + '.policy-confirmation', 'utf8')), { reads: 2, hostDecision: 'rejected', sameModelRequestCount: true })
      observed.exclusiveRetentionWait = true
      observed.environmentReadonlyPreflight = true; observed.storagePolicyReductionRefused = true
      observed.agentSelectedEnvironmentRepair = true; observed.environmentReferenceOnlyRelease = true
      assert.ok(text.includes('Input snapshots compacted; original paths and bytes retained'))
      assert.ok(text.includes('idle sealed release assets compacted without deleting a release'))
      observed.inputSnapshotsCompacted = true
      observed.releaseAssetsCompacted = true
      assert.equal(observed.environmentOperationOutputBounded, true)
      assert.ok(text.includes('retained-operation-detail-0:'))
      observed.environmentOperationDetailsRead = true
    }
    if (index >= actions.length - 1) {
      assert.ok(text.includes('Official ModelScope Git commit and tree attested'))
      observed.modelscopeDatasetManifest = true
      assert.ok(text.includes('dependency installation did not start'))
      assert.match(text, /admissionReleased\\*":true/)
      observed.environmentLockRefusalTerminal = true
      assert.ok(text.includes('Trial requirements are not published environment requirements'))
      assert.ok(text.includes('Registered environment requirements are omitted: borrow-fixture==1'))
      assert.ok(text.includes('Corrected dependency trial uses published environment requirements'))
      observed.correctedDependencyTrialRead = true
    }
    if (index >= actions.length) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'The CPU fixture is blocked at the required CUDA check; existing materials and environments are retained.' } }
      yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    const [name, args] = actions[index++]
    if (['latest-saved-material-page', 'latest-saved-repair-page', 'latest-saved-oversized-material-page', 'latest-saved-inline-material-page', 'latest-saved-operation-page'].includes(args.details_json)) {
      const selected = args.details_json
      const section = selected === 'latest-saved-repair-page' ? 'repairPlans' : 'materials'
      let page
      for (const message of options.messages) for (const block of typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content ?? []) {
        if (block.type !== 'text') continue
        try {
          const value = JSON.parse(block.text)
          if (selected === 'latest-saved-operation-page') {
            if (value.operationId === firstInstallId && value.details) page = { ...value.details, path: [0, 'operation', 'diagnostics'] }
          } else if (selected === 'latest-saved-oversized-material-page') {
            if (value.section === 'materials' && value.rows?.length > 0 && value.next) page = value.next
          } else if (selected === 'latest-saved-inline-material-page') {
            if (value.rowIndex === 1 && value.detail) page = value.detail
          } else if (value.sections?.[section]?.page) page = value.sections[section].page
        }
        catch (error) { if (!(error instanceof SyntaxError)) throw error }
      }
      assert.ok(page, 'Bounded inspection must supply a saved detail page')
      args.details_json = JSON.stringify(page)
    }
    observed.calls.push(name); writeFileSync(config.observed, JSON.stringify(observed))
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
