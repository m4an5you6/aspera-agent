/** CPU evidence for the real Host review Agent; no training or dependency installation is performed. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { clusterRecordSchema, legacyCompletionEvidenceError } from '@aspera/experiments'
import * as evidence from '../../packages/runtime/scripts/completion-files.mjs'

export function completionFixture(ctx, runPath, controlPath) {
  const tasks = new Map(), turns = new Map(), calls = []
  const expected = ['get_experiment_requirements', 'get_experiment_execution_progress', 'get_experiment_commands', 'list_experiment_files', 'read_experiment_file',
    'read_original_execution_trace', 'inspect_experiment_completion', 'record_experiment_execution', 'verify_experiment_completion', 'finish_experiment',
    'register_experiment_stage', 'verify_experiment_stage', 'report_experiment_step'].sort()
  ctx.on('llm/stream', async function* (options, next) {
    const text = JSON.stringify(options.messages), id = /Review original experiment ([a-f0-9-]{36})/.exec(text)?.[1]
    const task = tasks.get(id)
    if (task === undefined) { yield* next(); return }
    assert.equal(options.model, 'qwen-execution'); assert.deepEqual((options.tools ?? []).map(tool => tool.name).sort(), expected)
    const index = turns.get(id) ?? 0; turns.set(id, index + 1)
    const assessment = options.messages.filter(message => message.role === 'tool').flatMap(message => message.content
      .filter(block => block.type === 'text' && block.text.trimStart().startsWith('{')).map(block => JSON.parse(block.text)))
      .findLast(value => value.assessment?.experimentId === id)?.assessment
    const actions = task.mode === 'continuation' ? [
      ['get_experiment_requirements', {}], ['inspect_experiment_completion', {}], ['get_experiment_commands', {}],
      ['get_experiment_execution_progress', {}], ['read_original_execution_trace', {}], ['list_experiment_files', {}],
      ['register_experiment_stage', { json: JSON.stringify({ stageId: 'phase2', serverId: task.entry.serverId, attemptId: 'original-phase2', commandId: 'train',
        parameters: 'stage-args.json', trainerState: 'outputs/checkpoint-230/trainer_state.json', resumeState: 'outputs/checkpoint-30/trainer_state.json', metrics: 'metrics.jsonl' }) }],
      ['verify_experiment_stage', { json: JSON.stringify({ serverId: task.entry.serverId, stageId: 'phase2' }) }],
      ['get_experiment_execution_progress', {}],
      ['record_experiment_execution', { json: JSON.stringify(task.entry), sources_json: JSON.stringify(task.sources) }],
      ['report_experiment_step', { step: 2, state: 'completed', detail: 'Original 200-step continuation and existing finalization results were independently checked',
        expected_revision: assessment?.revision ?? 0, sources_json: JSON.stringify(task.sources) }],
      ['verify_experiment_completion', {}],
    ] : [
      ['get_experiment_requirements', {}], ['inspect_experiment_completion', {}], ['finish_experiment', { status: 'completed' }],
      ['get_experiment_commands', {}], ['get_experiment_execution_progress', {}], ['read_original_execution_trace', {}], ['list_experiment_files', {}],
      ['read_experiment_file', { server_id: task.entry.serverId, path: 'args.json' }],
      ['record_experiment_execution', { json: JSON.stringify({ ...task.entry, serverId: randomUUID() }), sources_json: JSON.stringify(task.sources) }],
      ['record_experiment_execution', { json: JSON.stringify({ ...task.entry, parameters: { max_steps: '999', num_train_epochs: '2' }, evaluation: { eval_loss: 0 }, artifacts: ['missing.safetensors'] }), sources_json: JSON.stringify(task.sources) }],
      ['record_experiment_execution', { json: JSON.stringify(task.entry), sources_json: JSON.stringify(task.sources) }],
      ...(task.mode === 'blocked' ? [['finish_experiment', { status: 'blocked', detail: 'Original adapter evidence is unavailable; no training or inference was restarted.' }]] : [['verify_experiment_completion', {}]]),
    ]
    if (task.mode !== 'continuation' && index >= 4) assert.ok(text.includes('has no recorded framework'), 'Missing evidence must be returned without completing the review Goal')
    if (task.mode !== 'continuation' && index >= 10) assert.ok(text.includes('outside this experiment'), 'Cross-node evidence must be rejected')
    if (task.mode !== 'continuation' && index >= 10) for (const field of ['parameters.max_steps', 'parameters.num_train_epochs', 'evaluation.eval_loss', 'missing.safetensors', 'availableKeys']) {
      assert.ok(text.includes(field), 'All evidence mismatches must be diagnosed together: ' + field)
    }
    if (task.mode !== 'continuation' && index >= 8) {
      const source = options.messages.filter(message => message.role === 'tool' && !message.isError)
        .flatMap(message => message.content.filter(block => block.type === 'text' && block.text.trimStart().startsWith('{')).map(block => JSON.parse(block.text)))
        .findLast(value => value.path === 'args.json' && typeof value.text === 'string')
      assert.ok(source, 'Training arguments must be returned as readable structured evidence')
      assert.deepEqual(JSON.parse(source.text), { max_steps: 57, num_train_epochs: 1, hub_token: null, api_key: '[redacted]' })
    }
    const action = actions[index]
    if (action === undefined) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const [name, args] = action; calls.push({ experimentId: id, name })
    if (index === 0) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'CPU diagnostic: hf_token: private-fixture-token"\nRead existing evidence only.' } }
    }
    yield { type: 'block-start', index: index === 0 ? 1 : 0, blockType: 'tool-call' }
    yield { type: 'block-end', index: index === 0 ? 1 : 0, block: { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) } }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }, { global: true })
  return {
    calls,
    async seed(record, save, mode = 'passed') {
      const id = record.submission.experimentId, node = record.submission.nodes[0], serverId = node.server.id
      const original = clusterRecordSchema.parse({ ...record, state: 'failed', resourcesReleased: true, revision: record.revision + 1,
        services: [], executions: [], detail: legacyCompletionEvidenceError, payloadHash: createHash('sha256').update(JSON.stringify(record.submission)).digest('hex') })
      const runRoot = runPath(id, ''), controlRoot = controlPath(node.server.remoteRoot), releaseRoot = controlPath(node.server.storagePlacement.releaseRoot)
      const put = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content)) }
      put(resolve(runRoot, '.aspera-owner.json'), { version: 1, experimentId: id, serverId })
      put(resolve(controlRoot, '.aspera-owner.json'), { version: 1, kind: 'control', serverId })
      put(resolve(controlRoot, `state/node-home/storages/aspera_node/allocations/${id}.json`), { record: { deploymentId: record.submission.deploymentId, node, released: true } })
      put(resolve(releaseRoot, 'aspera-release.json'), { deploymentId: record.submission.deploymentId }); put(resolve(releaseRoot, '.ready'), 'ready')
      put(resolve(runRoot, 'workspace/pyenv/pyvenv.cfg'), 'version_info = 3.10.12\ninclude-system-site-packages = false\n')
      put(resolve(runRoot, 'workspace/pyenv/bin/python'), 'CPU metadata-only fixture; never executed')
      put(resolve(runRoot, 'workspace/pyenv/lib/python3.10/site-packages/ms_swift-4.6.0.dist-info/METADATA'), 'Name: ms-swift\nVersion: 4.6.0\n')
      put(resolve(runRoot, 'workspace/train.py'), '# CPU fixture script preserved for evidence\n')
      put(resolve(runRoot, 'workspace/args.json'), { max_steps: 57, num_train_epochs: 1, hub_token: null, api_key: 'private-fixture-key' })
      put(resolve(runRoot, 'workspace/train.log'), 'CPU replay of recorded output: 57/57; checkpoint-57 saved\n')
      put(resolve(runRoot, 'workspace/metrics.json'), { eval_loss: 1.65 })
      put(resolve(runRoot, 'workspace/infer_results.json'), { status: 'ok', responses: ['CPU synthetic response'] })
      put(resolve(runRoot, 'workspace/checkpoint-57/adapter.safetensors'), 'CPU artifact fixture, no model weights')
      const entry = { serverId, framework: 'ms-swift', version: '4.6.0', script: 'train.py', environment: 'pyenv',
        parameters: { max_steps: '57', num_train_epochs: '1' }, artifacts: ['checkpoint-57/adapter.safetensors'], evaluation: { eval_loss: 1.65 } }
      if (mode === 'continuation') {
        original.state = 'blocked'; original.detail = 'Agent reported a context budget before finalization; original training reached 230 steps'
        original.plan = { ...original.plan, steps: ['Original training and artifacts', 'Existing continuation verification and report'], stages: [{ stageId: 'phase2', planStep: 2,
          title: 'Continue 200 steps', framework: 'transformers', startStep: 30, additionalSteps: 200, endStep: 230, metricScope: 'stage', loggingSteps: 1,
          scheduler: { mode: 'continue', type: 'cosine', learningRate: 0.0001, warmupSteps: 12, totalSteps: 230 }, requiredFiles: ['outputs/checkpoint-230/adapter.safetensors'] }] }
        entry.parameters.max_steps = '230'; entry.artifacts = ['outputs/checkpoint-230/adapter.safetensors']; original.executions = [entry]
        put(resolve(runRoot, 'workspace/args.json'), { max_steps: 230, num_train_epochs: 1 })
        put(resolve(runRoot, 'workspace/stage-args.json'), { max_steps: 230, learning_rate: 0.0001, warmup_steps: 12, lr_scheduler_type: 'cosine', resume_from_checkpoint: 'outputs/checkpoint-30' })
        put(resolve(runRoot, 'workspace/outputs/checkpoint-230/trainer_state.json'), { global_step: 230 })
        put(resolve(runRoot, 'workspace/outputs/checkpoint-30/trainer_state.json'), { global_step: 30 })
        for (const name of ['optimizer.pt', 'scheduler.pt', 'rng_state.pth']) put(resolve(runRoot, 'workspace/outputs/checkpoint-30', name), 'CPU opaque state identity; never executed')
        put(resolve(runRoot, 'workspace/outputs/checkpoint-230/adapter.safetensors'), 'CPU artifact fixture, no model weights')
        put(resolve(runRoot, 'workspace/metrics.jsonl'), Array.from({ length: 200 }, (_, index) => JSON.stringify({ step: index + 31, loss: 1.2,
          learning_rate: 0.0001 * 0.5 * (1 + Math.cos(Math.PI * (index + 31 - 12) / 218)) })).join('\n') + '\n')
        put(resolve(runRoot, 'finish-decision.v1.json'), { version: 1, experimentId: id, sessionId: original.sessionId, requested: 'blocked',
          decision: 'agent-incomplete', reason: 'agent-report', verified: false, checkedAt: original.updatedAt,
          detail: 'Agent did not complete finalization; context exhaustion was not established.', evidenceSeqs: [], factsHash: createHash('sha256').update(JSON.stringify(original)).digest('hex'), corrections: 2 })
      }
      const files = { framework: 'pyenv/lib/python3.10/site-packages/ms_swift-4.6.0.dist-info/METADATA', environment: 'pyenv/pyvenv.cfg',
        script: 'train.py', parameters: 'args.json', training: 'train.log', evaluation: 'metrics.json', inference: 'infer_results.json', artifact: entry.artifacts[0] }
      const task = { original, mode, runRoot, controlRoot, releaseRoot, entry, sources: Object.entries(files).map(([purpose, path]) => ({ serverId, purpose, path })),
        progress: { version: 1, experimentId: id, planRevision: original.plan.revision, sessionId: original.sessionId, revision: 1, updatedAt: original.updatedAt,
          steps: original.plan.steps.map((_step, index) => ({ step: index + 1, state: mode === 'continuation' && index === 1 ? 'pending' : 'completed', updatedAt: original.updatedAt })) },
        commands: [{ experimentId: id, serverId, commandId: 'train', command: 'pyenv/bin/python train.py --max_steps ' + entry.parameters.max_steps, state: 'completed', exitCode: 0, released: true, streams: ['stdout', 'stderr'] }] }
      tasks.set(id, task); turns.delete(id)
      const history = readFileSync(resolve(runRoot, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(row => row.sessionId === original.sessionId)
      const nextSeq = Math.max(-1, ...history.map(row => row.event.seq)) + 1
      for (const [offset, type, data] of [[0, 'tool/call', { turn: 0, step: 0, callId: 'cpu-original-finish', name: 'finish_experiment', arguments: JSON.stringify({ status: mode === 'continuation' ? 'blocked' : 'completed' }) }],
        [1, 'goal/change', { goal: { phase: mode === 'continuation' ? 'blocked' : 'complete' } }], [2, 'turn/end', { turn: 0, reason: { kind: mode === 'continuation' ? 'blocked' : 'completed' } }]]) {
        appendFileSync(resolve(runRoot, 'events.jsonl'), JSON.stringify({ sessionId: original.sessionId, source: 'execution', event: { seq: nextSeq + offset, time: original.updatedAt, type, data } }) + '\n')
      }
      await save(original); return task
    },
    catalog(id) { const task = tasks.get(id); return task === undefined ? undefined : { processes: task.commands, progress: task.progress } },
    async remote(script, signal) {
      const operation = /JSON\.stringify\((inspectCompletionIdentity|inspectCompletionFile|inspectCompletionSession|inspectHistoricalEnvironment|saveCompletionReview|saveCompletionAssessment|inspectExperimentFinalization|listCompletionFiles)\(/.exec(script)?.[1]
      if (operation === undefined) return undefined
      const encoded = script.match(/[A-Za-z0-9+/=]{80,}/g)?.at(-1), request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
      const task = tasks.get(request.experimentId); assert.ok(task, 'Review read must target a seeded original task')
      if (task.mode === 'blocked' && request.path === 'checkpoint-57/adapter.safetensors') throw new Error('Original adapter file is unavailable')
      if (task.mode === 'hold' && request.path === 'train.log') await new Promise((_done, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
      return JSON.stringify(evidence[operation]({ ...request, runRoot: task.runRoot, controlRoot: task.controlRoot, releaseRoot: task.releaseRoot }))
    },
  }
}
