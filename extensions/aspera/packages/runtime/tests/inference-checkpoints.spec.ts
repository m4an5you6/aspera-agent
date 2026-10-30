/** Inference recovery retains native producer evidence and snapshots only the adapter loading files. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync, renameSync, symlinkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { experimentIdSchema, serverIdSchema, stageRegistrationSchema, prepareInferenceCheckpointSchema } from '@aspera/experiments'
import { CheckpointProtection } from '../src/checkpoint-protection.ts'
import { InferenceCheckpointSnapshots, inspectInferenceCheckpoints, prepareInferenceCheckpointProof } from '../src/inference-checkpoints.ts'
import type { InferenceCheckpointSource } from '../src/inference-checkpoints.ts'

const roots: string[] = [], base = resolve('.artifacts')
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(root) !== base || !root.startsWith(resolve(base, 'inference-checkpoint-'))) throw new Error('Snapshot test cleanup escaped its root')
  rmSync(root, { recursive: true, force: true })
} })
async function fixture() {
  mkdirSync(base, { recursive: true }); const root = mkdtempSync(resolve(base, 'inference-checkpoint-')); roots.push(root)
  const serverId = serverIdSchema.parse(randomUUID()), sourceId = experimentIdSchema.parse(randomUUID()), targetId = experimentIdSchema.parse(randomUUID())
  const run = (id: typeof sourceId) => {
    const runRoot = resolve(root, id), workspace = resolve(runRoot, 'workspace'); mkdirSync(workspace, { recursive: true })
    writeFileSync(resolve(runRoot, '.aspera-owner.json'), JSON.stringify({ version: 1, experimentId: id, serverId }))
    return { runRoot, workspace, experimentId: id, serverId }
  }
  const source: InferenceCheckpointSource = { ...run(sourceId), released: true, commands: [{ commandId: 'train', state: 'completed', exitCode: 0, released: true }] }
  const target = run(targetId), folder = resolve(source.workspace, 'outputs/checkpoint-230'); mkdirSync(folder, { recursive: true })
  const bytes = { 'adapter_config.json': '{"r":8,"base_model_name_or_path":"fixture"}', 'adapter_model.safetensors': 'preserved synthetic adapter', 'trainer_state.json': '{"global_step":230}', 'optimizer.pt': 'preserved optimizer', 'scheduler.pt': 'preserved scheduler' }
  for (const [name, value] of Object.entries(bytes)) writeFileSync(resolve(folder, name), value)
  const protection = new CheckpointProtection(source.runRoot, source.workspace, sourceId, serverId)
  await protection.register(stageRegistrationSchema.parse({ version: 1, experimentId: sourceId, serverId, sessionId: 'original-execution', planRevision: 1,
    stageId: 'stage2', attemptId: 'original', commandId: 'train', registeredAt: 1, historical: false, trainerState: 'outputs/checkpoint-230/trainer_state.json',
    parameters: 'args.json', metrics: 'metrics.jsonl', requirement: { stageId: 'stage2', title: 'Continue', planStep: 1, framework: 'transformers', startStep: 30,
      additionalSteps: 200, endStep: 230, metricScope: 'stage', loggingSteps: 5, scheduler: { mode: 'continue', type: 'cosine', learningRate: 0.0001, warmupSteps: 12, totalSteps: 230 },
      requiredFiles: Object.keys(bytes).map(name => 'outputs/checkpoint-230/' + name) } }))
  await protection.mounts('evaluate', source.commands)
  const candidate = inspectInferenceCheckpoints(source, 65536)[0]!
  const request = prepareInferenceCheckpointSchema.parse({ operationId: randomUUID(), sourceExperimentId: sourceId, checkpointId: candidate.checkpointId })
  const snapshots = new InferenceCheckpointSnapshots(target, 0)
  const proof = () => prepareInferenceCheckpointProof(source, request, 65536, AbortSignal.timeout(5000))
  const publish = async () => snapshots.publish(source, request, await proof(), 65536)
  return { root, source, target, folder, candidate, request, snapshots, proof, publish, bytes }
}

it('preserves producer contents and creates only read-only-mountable hardlink aliases for inference', async () => {
  const f = await fixture(), before = readFileSync(resolve(f.folder, 'adapter_model.safetensors'))
  const snapshot = await f.publish(), directory = resolve(f.target.workspace, snapshot.destination)
  expect(snapshot).toMatchObject({ version: 1, state: 'ready', mode: 'hardlink', additionalFileBytes: 0, source: { step: 230 } })
  for (const file of snapshot.files) {
    expect(lstatSync(resolve(directory, file.name)).ino).toBe(lstatSync(resolve(f.folder, file.name)).ino)
    expect(file.sha256).toBe(createHash('sha256').update(f.bytes[file.name]).digest('hex'))
  }
  expect(() => lstatSync(resolve(directory, 'optimizer.pt'))).toThrow()
  expect(f.snapshots.mounts()).toEqual([directory])
  expect(readFileSync(resolve(f.folder, 'adapter_model.safetensors'))).toEqual(before)
  expect(inspectInferenceCheckpoints(f.source, 65536)[0]).toEqual(f.candidate)
  expect(await f.publish()).toEqual(snapshot)
  if (dirname(f.folder) !== resolve(f.source.workspace, 'outputs')) throw new Error('Source alias test cleanup escaped its workspace')
  rmSync(f.folder, { recursive: true })
  expect(readFileSync(resolve(directory, 'adapter_model.safetensors'))).toEqual(before)
  expect(f.snapshots.mounts()).toEqual([directory])
})

it('rejects unconfirmed producers, changed native files and missing adapter configuration', async () => {
  const f = await fixture()
  expect(() => inspectInferenceCheckpoints({ ...f.source, released: false }, 65536)).toThrow('release must be confirmed')
  expect(() => inspectInferenceCheckpoints({ ...f.source, commands: [{ ...f.source.commands[0]!, released: false }] }, 65536)).toThrow('release must be confirmed')
  const proof = await f.proof()
  writeFileSync(resolve(f.folder, 'adapter_model.safetensors'), 'different')
  await expect(f.snapshots.publish(f.source, f.request, proof, 65536)).rejects.toThrow('identity changed')
  expect(f.snapshots.mounts()).toEqual([])
})

it('refuses source directory links and source ownership changes before any snapshot is published', async () => {
  const f = await fixture()
  renameSync(f.folder, f.folder + '-original'); symlinkSync(f.folder + '-original', f.folder, 'junction')
  expect(() => inspectInferenceCheckpoints(f.source, 65536)).toThrow('symbolic link')
  writeFileSync(resolve(f.source.runRoot, '.aspera-owner.json'), '{}')
  expect(() => inspectInferenceCheckpoints(f.source, 65536)).toThrow('another owner')
})

it('keeps incomplete publication fenced and resumes the same request without duplicating adapter bytes', async () => {
  const f = await fixture(), proof = await f.proof(), privateRoot = resolve(f.target.runRoot, 'inference-checkpoints-v1')
  mkdirSync(privateRoot)
  const stale = { version: 1, experimentId: f.target.experimentId, serverId: f.target.serverId, request: f.request, source: f.candidate,
    destination: 'inference-checkpoints/' + f.candidate.checkpointId, files: proof.files, mode: 'hardlink', additionalFileBytes: 0, state: 'publishing', startedAt: 1, updatedAt: 1 }
  writeFileSync(resolve(privateRoot, f.request.operationId + '.json'), JSON.stringify(stale))
  expect(() => f.snapshots.mounts()).toThrow('original operationId')
  const recovered = await f.snapshots.publish(f.source, f.request, proof, 65536)
  expect(recovered).toMatchObject({ state: 'ready', startedAt: 1 })
  await expect(f.snapshots.publish(f.source, { ...f.request, sourceExperimentId: experimentIdSchema.parse(randomUUID()) }, proof, 65536)).rejects.toThrow()
  const target = resolve(f.target.workspace, recovered.destination, 'adapter_config.json')
  renameSync(target, target + '.retained'); writeFileSync(target, 'replacement')
  expect(() => f.snapshots.mounts()).toThrow('changed')
})

it('does not publish when hashing is cancelled or the saved safety reserve would be consumed', async () => {
  const f = await fixture()
  await expect(prepareInferenceCheckpointProof(f.source, f.request, 65536, AbortSignal.abort())).rejects.toThrow()
  const full = new InferenceCheckpointSnapshots(f.target, Number.MAX_SAFE_INTEGER)
  await expect(full.publish(f.source, f.request, await f.proof(), 65536)).rejects.toThrow('safety reserve')
  expect(full.mounts()).toEqual([])
})
