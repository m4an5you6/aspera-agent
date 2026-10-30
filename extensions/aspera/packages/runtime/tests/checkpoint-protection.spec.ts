import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, renameSync, symlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { experimentIdSchema, serverIdSchema, stageRegistrationSchema } from '@aspera/experiments'
import { CheckpointProtection } from '../src/checkpoint-protection.ts'

const roots: string[] = []
const base = resolve('.artifacts')
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(root) !== base || !root.startsWith(resolve(base, 'checkpoint-protection-'))) throw new Error('Checkpoint test cleanup escaped its temporary root')
  rmSync(root, { recursive: true, force: true })
} })
function fixture() {
  mkdirSync(base, { recursive: true })
  const root = mkdtempSync(resolve(base, 'checkpoint-protection-')); roots.push(root)
  const workspace = resolve(root, 'workspace'); mkdirSync(workspace)
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const files = ['trainer_state.json', 'adapter_model.safetensors', 'optimizer.pt', 'scheduler.pt']
  const stage = stageRegistrationSchema.parse({ version: 1, experimentId, serverId, sessionId: 'execution',
    planRevision: 1, registeredAt: 1, historical: false, stageId: 'stage1', attemptId: 'attempt1', commandId: 'train1',
    parameters: 'args.json', trainerState: 'metrics/state.json', metrics: 'metrics/train.jsonl',
    requirement: { stageId: 'stage1', planStep: 1, title: 'Retain recovery state', framework: 'transformers',
      startStep: 0, additionalSteps: 2, endStep: 2, metricScope: 'stage', loggingSteps: 1,
      scheduler: { mode: 'fresh', type: 'linear', learningRate: 0.001, totalSteps: 2, warmupSteps: 0 },
      requiredFiles: files.map(name => 'checkpoints/retained/' + name) } })
  const produce = () => {
    mkdirSync(resolve(workspace, 'checkpoints/retained'), { recursive: true })
    for (const name of files) writeFileSync(resolve(workspace, 'checkpoints/retained', name),
      name === 'trainer_state.json' ? '{"global_step":2,"max_steps":2}' : 'unchanged fixture')
  }
  return { root, workspace, stage, produce, store: new CheckpointProtection(root, workspace, experimentId, serverId) }
}

it('protects a successful retained checkpoint before another command can clear it, including after restart', async () => {
  const f = fixture(); await f.store.register(f.stage); f.produce()
  const completed = { commandId: 'train1', state: 'completed' as const, exitCode: 0, released: true }
  const paths = await f.store.mounts('format-evidence', [completed])
  expect(paths).toEqual([resolve(f.workspace, 'checkpoints/retained')])
  const restarted = new CheckpointProtection(f.root, f.workspace, f.stage.experimentId, f.stage.serverId)
  expect(await restarted.mounts('inference', [completed])).toEqual(paths)
  expect(readFileSync(resolve(paths[0]!, 'optimizer.pt'), 'utf8')).toBe('unchanged fixture')
  await expect(restarted.mounts('cleanup', [])).rejects.toThrow('outcome is unconfirmed')
  await expect(restarted.mounts('train1', [completed])).rejects.toThrow('successful checkpoint')
})

it('discovers only previously sealed released checkpoints without changing the original records', async () => {
  const f = fixture(); await f.store.register(f.stage); f.produce()
  const commands = [{ commandId: 'train1', state: 'completed' as const, exitCode: 0, released: true }]
  expect(f.store.retained(commands)).toEqual([])
  await f.store.mounts('evaluate', commands)
  const retained = f.store.retained(commands)
  expect(retained).toMatchObject([{ commandId: 'train1', directory: { path: 'checkpoints/retained' } }])
  expect(f.store.retained(commands)).toEqual(retained)
  expect(() => f.store.retained([{ ...commands[0]!, released: false }])).toThrow('unconfirmed')
})

it('keeps the original recovery checkpoint read-only while continuation writes separate outputs', async () => {
  const f = fixture(); await f.store.register(f.stage); f.produce()
  const command = { commandId: 'train1', state: 'completed' as const, exitCode: 0, released: true }
  await f.store.mounts('evaluate', [command])
  await f.store.register(stageRegistrationSchema.parse({ ...f.stage, stageId: 'stage2', commandId: 'train2', resumeState: 'checkpoints/retained/trainer_state.json',
    requirement: { ...f.stage.requirement, stageId: 'stage2', startStep: 2, endStep: 4,
      scheduler: { ...f.stage.requirement.scheduler, mode: 'continue', totalSteps: 4 } } }))
  expect(await f.store.mounts('train2', [command])).toEqual([resolve(f.workspace, 'checkpoints/retained')])
})

it('allows read-only diagnostics while a stage runs but prevents concurrent writable commands', async () => {
  const f = fixture(); await f.store.register(f.stage)
  const running = { commandId: 'train1', state: 'running' as const, exitCode: null, released: false }
  await expect(f.store.mounts('cleanup', [running])).rejects.toThrow('registered training stage')
  expect(await f.store.mounts('inspect', [running], true)).toEqual([])
  await expect(f.store.mounts('train1', [{ ...running, commandId: 'other' }])).rejects.toThrow('exclusive')
})

it('preserves successful command status and blocks missing, replaced or changed checkpoint evidence', async () => {
  const f = fixture(); await f.store.register(f.stage); f.produce()
  const commands = [{ commandId: 'train1', state: 'completed' as const, exitCode: 0, released: true }]
  await f.store.mounts('evaluate', commands)
  writeFileSync(resolve(f.workspace, 'checkpoints/retained/optimizer.pt'), 'changed')
  await expect(f.store.mounts('cleanup', commands)).rejects.toThrow('identity changed')
  expect(commands[0]!.state).toBe('completed')
  expect(await f.store.mounts('diagnostic', commands, true)).toEqual([])
})

it('rejects foreign registration, directory replacement and links outside the workspace', async () => {
  const f = fixture()
  await expect(f.store.register({ ...f.stage, experimentId: experimentIdSchema.parse(randomUUID()) })).rejects.toThrow('another allocation')
  await f.store.register(f.stage); f.produce()
  const commands = [{ commandId: 'train1', state: 'completed' as const, exitCode: 0, released: true }]
  await f.store.mounts('evaluate', commands)
  renameSync(resolve(f.workspace, 'checkpoints/retained'), resolve(f.workspace, 'checkpoints/original'))
  mkdirSync(resolve(f.workspace, 'checkpoints/retained'))
  await expect(f.store.mounts('cleanup', commands)).rejects.toThrow('identity changed')
  rmSync(resolve(f.workspace, 'checkpoints/retained'), { recursive: true })
  symlinkSync(resolve(f.workspace, 'checkpoints/original'), resolve(f.workspace, 'checkpoints/retained'), 'junction')
  await expect(f.store.mounts('cleanup', commands)).rejects.toThrow('symbolic link')
})

it('keeps failed attempts unsealed and refuses to reinterpret a changed registration', async () => {
  const f = fixture(); await f.store.register(f.stage)
  expect(await f.store.mounts('fix-script', [{ commandId: 'train1', state: 'failed', exitCode: 127, released: true }])).toEqual([])
  await expect(f.store.register(stageRegistrationSchema.parse({ ...f.stage, attemptId: 'different' }))).rejects.toThrow('registration changed')
})
