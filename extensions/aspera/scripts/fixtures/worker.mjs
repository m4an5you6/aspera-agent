/** Keyless replay provider for the actual Aspera worker profile and scoped tools. */
import assert from 'node:assert/strict'
import { writeFileSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fixtureProvider } from './models.mjs'
import { ToolCallId, HarnessError } from '@deepseek-ai/dsh-llm'

export const inject = ['llm', 'webServer', 'userQuestions']

/** Mount deterministic model responses; application and tools remain the production profile. */
export function apply(ctx, config) {
  if (config.ready !== undefined) {
    writeFileSync(config.ready + '.incoming', JSON.stringify({ port: ctx.webServer.port }))
    renameSync(config.ready + '.incoming', config.ready)
    return
  }
  const knowledge = ['get_experiment_requirements', 'read_experiment_input', 'read_framework_documentation', 'read_framework_guidance']
  const execution = ['run_experiment_command', 'get_experiment_commands', 'read_experiment_file', 'list_experiment_files',
    'record_experiment_execution', 'report_experiment_progress', 'start_inference_service', 'get_inference_services', 'finish_experiment']
  const expected = [...knowledge, ...(config.semi ? ['ask_user_question'] : []), ...(config.planning ? ['save_experiment_plan'] : execution)].sort()
  const observed = { tools: [], calls: [], guidanceRead: false, inputRead: false, inputBlocked: false }
  let step = 0
  let rounds = 0
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
    return next()
  }, { global: true })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.provider !== fixtureProvider || !options.messages.some(message => JSON.stringify(message).includes(config.id))) {
      yield* next(); return
    }
    assert.equal(options.model, config.planning ? 'qwen-planning' : 'qwen-execution')
    // Replay intentionally supplies the response without contacting a model provider.
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
    const actionStep = step - (config.ask && step > 3 ? 1 : 0)
    if (config.ask && step >= 4) {
      assert.ok(JSON.stringify(options.messages).includes('Continue with a measured trial'), 'The original tool must receive the saved reply')
    }
    if ((config.planning && actionStep >= 4) || (!config.planning && actionStep >= 5)) {
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
    } else if (actionStep === 3) {
      name = 'record_experiment_execution'
      args = { json: JSON.stringify({ serverId: config.serverId, framework: 'fixture', version: 'test-version', script: 'smoke.py',
        environment: '.venv', parameters: { steps: '1' }, artifacts: [], evaluation: {} }) }
    } else { name = 'finish_experiment'; args = { status: 'blocked', detail: 'No GPU is available in the local worker replay.' } }
    assert.ok(step < 7, 'Worker failed to finish after its terminal tool')
    step += 1; observed.calls.push(name)
    writeFileSync(config.observed, JSON.stringify(observed))
    const block = { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) }
    yield { type: 'block-start', index: 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: 0, block }
    yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }, { global: true })
}
