/** Real Linux namespace regression; all writes remain inside the fresh test directory. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { stageRegistrationSchema } from '@aspera/experiments'
import { CheckpointProtection } from './checkpoint-protection.mjs'
import { experimentSandboxArgv } from './experiment-sandbox.mjs'

test('deletion and overwrite cannot change retained recovery files', { timeout: 30000 }, async () => {
  assert.equal(process.platform, 'linux')
  const root = mkdtempSync(resolve('checkpoint-fixture-')), workspace = resolve(root, 'workspace')
  mkdirSync(workspace)
  try {
    const stage = stageRegistrationSchema.parse({ version: 1, experimentId: randomUUID(), serverId: randomUUID(), sessionId: 'test', registeredAt: 1,
      historical: false, planRevision: 1, stageId: 'first', attemptId: 'first', commandId: 'train', parameters: 'args.json', trainerState: 'metrics/state.json', metrics: 'metrics/steps.jsonl',
      requirement: { stageId: 'first', planStep: 1, title: 'Synthetic checkpoint', framework: 'transformers', startStep: 0, additionalSteps: 2, endStep: 2,
        metricScope: 'stage', loggingSteps: 1, scheduler: { mode: 'fresh', type: 'linear', learningRate: 0.001, warmupSteps: 0, totalSteps: 2 },
        requiredFiles: ['trainer_state.json', 'adapter_model.safetensors', 'optimizer.pt', 'scheduler.pt'].map(name => 'checkpoints/retained/' + name) } })
    const store = new CheckpointProtection(root, workspace, stage.experimentId, stage.serverId)
    await store.register(stage)
    const checkpoint = resolve(workspace, 'checkpoints/retained')
    mkdirSync(checkpoint, { recursive: true })
    for (const path of stage.requirement.requiredFiles) writeFileSync(resolve(workspace, path), path.endsWith('trainer_state.json') ? '{"global_step":2}' : 'unchanged')
    const paths = await store.mounts('format', [{ commandId: 'train', state: 'completed', exitCode: 0, released: true }])
    const run = command => spawnSync(process.env.ASPERA_TEST_BWRAP, experimentSandboxArgv({ backendPath: process.env.ASPERA_TEST_BWRAP,
      workspaceRoot: workspace, devicePaths: [], hiddenPaths: [], protectedPaths: paths }, command).slice(1), { encoding: 'utf8', timeout: 10000 })
    const deletion = run(['bash', '-c', 'rm -rf checkpoints/retained'])
    assert.notEqual(deletion.status, 0, JSON.stringify(deletion))
    assert.match(deletion.stderr, /Read-only file system|Device or resource busy|Operation not permitted/)
    assert.equal(readFileSync(resolve(checkpoint, 'optimizer.pt'), 'utf8'), 'unchanged')
    const overwrite = run(['python3', '-B', '-c', "from pathlib import Path; Path('checkpoints/retained/adapter_model.safetensors').write_text('changed')"])
    assert.notEqual(overwrite.status, 0, JSON.stringify(overwrite))
    assert.equal(readFileSync(resolve(checkpoint, 'adapter_model.safetensors'), 'utf8'), 'unchanged')
    const next = run(['bash', '-c', 'mkdir -p outputs/next; printf new > outputs/next/evidence.txt; cat checkpoints/retained/trainer_state.json'])
    assert.equal(next.status, 0, next.stderr)
    assert.equal(JSON.parse(next.stdout).global_step, 2)
    assert.equal(readFileSync(resolve(workspace, 'outputs/next/evidence.txt'), 'utf8'), 'new')
    mkdirSync(resolve(workspace, 'outputs/unprotected'))
    writeFileSync(resolve(workspace, 'outputs/unprotected/temporary.txt'), 'temporary')
    const ordinaryCleanup = run(['bash', '-c', 'rm -rf outputs/unprotected'])
    assert.equal(ordinaryCleanup.status, 0, ordinaryCleanup.stderr)
    assert.equal(existsSync(resolve(workspace, 'outputs/unprotected')), false)
  } finally {
    assert.equal(dirname(root), resolve()); assert.ok(root.startsWith(resolve('checkpoint-fixture-')))
    rmSync(root, { recursive: true, force: true })
  }
})
