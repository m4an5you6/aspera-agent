/** Scoped evidence reads preserve original files and reject escaped or changed ownership. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, appendFileSync, symlinkSync, unlinkSync, lstatSync, linkSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import type { CompletionReview, ClusterNode } from '@aspera/experiments'
import { inspectCompletionIdentity, inspectCompletionFile, inspectCompletionSession, inspectHistoricalEnvironment, saveCompletionReview, listCompletionFiles,
  inspectAcceptanceSource, inspectAcceptanceRuntime, saveAcceptanceEvidence, inspectAcceptanceReferences } from '../scripts/completion-files.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts', 'completion-files-')); roots.push(root)
  const runRoot = resolve(root, 'run'), controlRoot = resolve(root, 'control'), releaseRoot = resolve(root, 'release')
  const experimentId = randomUUID(), serverId = randomUUID(), deploymentId = 'a'.repeat(64)
  const node = fromAny<ClusterNode, object>({ server: { id: serverId, name: 'CPU' }, devicePaths: [] })
  const put = (file: string, data: unknown) => { mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)) }
  put(resolve(runRoot, '.aspera-owner.json'), { version: 1, experimentId, serverId })
  put(resolve(controlRoot, '.aspera-owner.json'), { version: 1, kind: 'control', serverId })
  put(resolve(controlRoot, `state/node-home/storages/aspera_node/allocations/${experimentId}.json`), { record: { deploymentId, node, released: true } })
  put(resolve(releaseRoot, 'aspera-release.json'), { deploymentId }); put(resolve(releaseRoot, '.ready'), 'ready')
  put(resolve(runRoot, 'workspace/train.log'), '57/57\ntraining completed\n')
  put(resolve(runRoot, 'workspace/pyenv/pyvenv.cfg'), 'version_info = 3.10.12\ninclude-system-site-packages = false\n')
  put(resolve(runRoot, 'workspace/pyenv/bin/python'), 'CPU fixture, never executed')
  put(resolve(runRoot, 'workspace/pyenv/lib/python3.10/site-packages/ms_swift-4.6.0.dist-info/METADATA'), 'Name: ms-swift\nVersion: 4.6.0\n')
  const request = { runRoot, controlRoot, releaseRoot, experimentId, serverId, deploymentId, node, maxBytes: 1024 }
  return { root, runRoot, request, put }
}
it('binds a read to the original allocation and unchanged fixed release', () => {
  const f = fixture(); expect(inspectCompletionIdentity(f.request)).toEqual({ verified: true })
  f.put(resolve(f.request.releaseRoot, 'aspera-release.json'), { deploymentId: 'b'.repeat(64) })
  expect(() => inspectCompletionIdentity(f.request)).toThrow('fixed release identity')
})
function inferenceRecovery() {
  const f = fixture(), recoveryId = randomUUID(), runRoot = resolve(f.root, 'recovery'), serverId = f.request.serverId
  const node = { ...f.request.node, server: { ...f.request.node.server, inferenceMapping: { url: 'https://example.org/inference', port: 3000 } } }
  f.request.node = node
  f.put(resolve(f.request.controlRoot, `state/node-home/storages/aspera_node/allocations/${f.request.experimentId}.json`), { record: { deploymentId: f.request.deploymentId, node, released: true } })
  const source = { ...f.request, maxBytes: 8192, maxEntries: 20 }
  const recovery = { ...source, experimentId: recoveryId, runRoot }
  f.put(resolve(runRoot, '.aspera-owner.json'), { version: 1, experimentId: recoveryId, serverId })
  f.put(resolve(f.request.controlRoot, `state/node-home/storages/aspera_node/allocations/${recoveryId}.json`), { record: { deploymentId: source.deploymentId, node, released: false } })
  const commandId = 'train-230', directory = 'outputs/checkpoint-230'
  f.put(resolve(source.controlRoot, `state/node-home/storages/aspera_node/commands/${source.experimentId}_${commandId}.json`), { record: { experimentId: source.experimentId, commandId, state: 'completed', exitCode: 0, released: true } })
  const files = ['adapter_config.json', 'adapter_model.safetensors', 'trainer_state.json'].map(name => {
    const path = resolve(source.runRoot, 'workspace', directory, name)
    f.put(path, name === 'trainer_state.json' ? { global_step: 230 } : name)
    const info = lstatSync(path)
    return { name, device: String(info.dev), inode: String(info.ino), bytes: info.size, modified: info.mtimeMs }
  })
  const candidate = { sourceExperimentId: source.experimentId, serverId, commandId, directory, step: 230, files }
  const checkpointId = createHash('sha256').update(JSON.stringify(candidate)).digest('hex')
  const snapshot = { experimentId: recoveryId, serverId, source: { ...candidate, checkpointId }, state: 'ready',
    destination: 'inference-checkpoints/' + checkpointId, files: files.map(file => ({ ...file, sha256: createHash('sha256').update(readFileSync(resolve(source.runRoot, 'workspace', directory, file.name))).digest('hex') })) }
  for (const file of files) {
    const path = resolve(runRoot, 'workspace', snapshot.destination, file.name)
    mkdirSync(resolve(path, '..'), { recursive: true }); linkSync(resolve(source.runRoot, 'workspace', directory, file.name), path)
  }
  f.put(resolve(runRoot, 'inference-checkpoints-v1', randomUUID() + '.json'), snapshot)
  const stage = { experimentId: source.experimentId, serverId, stageId: 'stage2', attemptId: 'native', sessionId: 'original', planRevision: 1 }
  f.put(resolve(source.runRoot, 'stage-acceptance-v1/stage2.registration.json'), { ...stage, commandId })
  f.put(resolve(source.runRoot, 'stage-acceptance-v1/stage2.verification.json'), { ...stage, ready: true, endStep: 230 })
  f.put(resolve(source.runRoot, 'service-verifications-v1', randomUUID() + '.json'), { experimentId: source.experimentId, serverId, url: node.server.inferenceMapping.url, modelName: 'qwen9b-230' })
  return { ...f, source, recovery, snapshot, input: { ...source, expectedStep: 230, recovery } }
}
it('reads the exact retained native checkpoint and related snapshot without changing original files', () => {
  const f = inferenceRecovery(), path = resolve(f.source.runRoot, 'workspace/outputs/checkpoint-230/trainer_state.json'), before = readFileSync(path)
  expect(inspectAcceptanceSource(f.input)).toMatchObject({ step: 230, checkpointId: f.snapshot.source.checkpointId, modelName: 'qwen9b-230' })
  expect(inspectAcceptanceRuntime({ ...f.recovery, coordinator: false })).toMatchObject({ goalFinished: false, snapshots: [f.snapshot], services: [] })
  expect(readFileSync(path)).toEqual(before)
})
it('reads the recovery coordinator identity from its fixed submission while the inference Goal is active', () => {
  const f = inferenceRecovery(), record = { submission: { experimentId: f.recovery.experimentId, deploymentId: f.recovery.deploymentId }, state: 'running' }
  f.put(resolve(f.recovery.controlRoot, 'state/coordinator-home/storages/aspera_queue/experiments', f.recovery.experimentId + '.json'), { record })
  expect(inspectAcceptanceRuntime({ ...f.recovery, coordinator: true })).toMatchObject({ record, goalFinished: false })
})
it.each(['experiment', 'release'])('rejects a recovery coordinator submission with another %s identity', kind => {
  const f = inferenceRecovery(), submission = { experimentId: f.recovery.experimentId, deploymentId: f.recovery.deploymentId }
  if (kind === 'experiment') submission.experimentId = randomUUID()
  else submission.deploymentId = 'b'.repeat(64)
  f.put(resolve(f.recovery.controlRoot, 'state/coordinator-home/storages/aspera_queue/experiments', f.recovery.experimentId + '.json'), { record: { submission, state: 'running' } })
  expect(() => inspectAcceptanceRuntime({ ...f.recovery, coordinator: true })).toThrow('Recovery coordinator identity differs')
})
it('refuses changed adapter files, another native endpoint and an unreleased training command', () => {
  const f = inferenceRecovery()
  expect(() => inspectAcceptanceSource({ ...f.input, expectedStep: 30 })).toThrow('unique protected')
  f.put(resolve(f.source.controlRoot, `state/node-home/storages/aspera_node/commands/${f.source.experimentId}_train-230.json`), { record: { experimentId: f.source.experimentId, commandId: 'train-230', state: 'running', released: false } })
  expect(() => inspectAcceptanceSource(f.input)).toThrow('successful release')
  f.put(resolve(f.source.controlRoot, `state/node-home/storages/aspera_node/commands/${f.source.experimentId}_train-230.json`), { record: { experimentId: f.source.experimentId, commandId: 'train-230', state: 'completed', exitCode: 0, released: true } })
  f.put(resolve(f.source.runRoot, 'workspace/outputs/checkpoint-230/adapter_config.json'), 'changed')
  expect(() => inspectAcceptanceSource(f.input)).toThrow('does not match')
  expect(() => inspectAcceptanceRuntime({ ...f.recovery, coordinator: false })).toThrow('checkpoint changed')
})
it('writes a separate immutable serving proof while preserving original results', () => {
  const f = inferenceRecovery(), operation = { experimentId: f.source.experimentId, operationId: randomUUID(), source: { experimentId: f.source.experimentId }, recoveryExperimentId: f.recovery.experimentId }
  const observation = { experimentId: f.recovery.experimentId, publicGeneration: 'program observation' }
  const request = { ...f.source, operation, observation }
  const saved = saveAcceptanceEvidence(request)
  expect(saved.path).toBe('reports/acceptance-recovery/' + operation.operationId + '.json')
  expect(saveAcceptanceEvidence(request)).toEqual(saved)
  const changed = { ...request, observation: { ...observation, publicGeneration: 'another result' } }
  expect(() => saveAcceptanceEvidence(changed)).toThrow('immutable')
})
it('uses bounded settled preflight summaries instead of loading a huge historical environment file list', () => {
  const f = fixture(), operationId = randomUUID()
  f.put(resolve(f.runRoot, 'environment-borrowings-v1/training.json'), 'large-reference-'.repeat(1000))
  const preflight = { status: 'reusable', candidateId: 'a'.repeat(64), requirements: ['torch==2'], additionalBytes: 0 }
  f.put(resolve(f.runRoot, 'environment-operations-v1', operationId, 'receipt.v1.json'), { experimentId: f.request.experimentId,
    serverId: f.request.serverId, exitCode: 0, exitConfirmed: true, preflight })
  expect(inspectAcceptanceReferences({ ...f.request, maxEntries: 20 })).toEqual({ preflights: [preflight], proposals: [], environmentIssues: [] })
})
it.each(['../outside', '/absolute/file', 'folder/../../outside'])('refuses evidence path %s', path => {
  const f = fixture(); expect(() => inspectCompletionFile({ ...f.request, path })).toThrow()
})
it('hashes the complete source while bounding text, and detects a new generation', () => {
  const f = fixture(); f.put(resolve(f.runRoot, 'workspace/train.log'), 'x'.repeat(2048))
  const before = inspectCompletionFile({ ...f.request, path: 'train.log', maxBytes: 1024 })
  expect(before.text).toHaveLength(1024); expect(before.truncated).toBe(true)
  f.put(resolve(f.runRoot, 'workspace/train.log'), 'Changed original file\n')
  const after = inspectCompletionFile({ ...f.request, path: 'train.log' })
  expect(before.sha256).not.toBe(after.sha256); expect(before.generation).not.toBe(after.generation)
})
it('hashes large state artifacts without returning binary payload and reads text tails by position', () => {
  const f = fixture(), value = 'head' + 'x'.repeat(1024 * 1024) + 'final result'
  f.put(resolve(f.runRoot, 'workspace/state.pt'), value)
  const meta = inspectCompletionFile({ ...f.request, path: 'state.pt', metadataOnly: true })
  expect(meta).toMatchObject({ sha256: createHash('sha256').update(value).digest('hex'), bytes: Buffer.byteLength(value), text: '', tail: '', truncated: true })
  const text = inspectCompletionFile({ ...f.request, path: 'state.pt' })
  expect(text.text).toBe(value.slice(0, 1024)); expect(text.tail).toBe(value.slice(-1024)); expect(text.sha256).toBe(meta.sha256)
})
it('registers uv historical metadata read-only and rejects another framework version', () => {
  const f = fixture(), bin = resolve(f.runRoot, 'workspace/pyenv/bin/python'), before = readFileSync(bin)
  const environment = inspectHistoricalEnvironment({ ...f.request, environment: 'pyenv', framework: 'ms-swift', version: '4.6.0' })
  expect(environment).toMatchObject({ kind: 'historical', packages: { 'ms-swift': '4.6.0' } })
  expect(readFileSync(bin)).toEqual(before)
  expect(() => inspectHistoricalEnvironment({ ...f.request, environment: 'pyenv', framework: 'ms-swift', version: '1' })).toThrow('version differs')
})
it('lists result candidates without traversing historical dependency directories', () => {
  const f = fixture(), result = listCompletionFiles({ ...f.request, maxEntries: 100, excludeDirectories: [] })
  expect(result.files.map(file => file.path)).toEqual(['train.log'])
})
it('writes only an independent receipt and rejects a conflicting revision', () => {
  const f = fixture(), original = readFileSync(resolve(f.runRoot, 'workspace/train.log'))
  const receipt = fromAny<CompletionReview, object>({ experimentId: f.request.experimentId, operationId: randomUUID(), submissionHash: 'c'.repeat(64), revision: 1 })
  expect(saveCompletionReview({ ...f.request, receipt }).sha256).toHaveLength(64)
  expect(saveCompletionReview({ ...f.request, receipt }).sha256).toHaveLength(64)
  expect(() => saveCompletionReview({ ...f.request, receipt: { ...receipt, revision: 0 } })).toThrow('revision conflict')
  expect(readFileSync(resolve(f.runRoot, 'workspace/train.log'))).toEqual(original)
})
it('reads complete large Session events and rejects a later blocked Goal as completion proof', () => {
  const f = fixture(), sessionId = 'original-execution', file = resolve(f.runRoot, 'events.jsonl')
  const rows = [
    { type: 'tool/call', data: { name: 'finish_experiment', arguments: JSON.stringify({ status: 'completed', detail: '证据'.repeat(40000) }) } },
    { type: 'goal/change', data: { goal: { phase: 'complete' } } }, { type: 'turn/end', data: {} },
  ].map((event, seq) => ({ sessionId, event: { ...event, seq } }))
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  expect(inspectCompletionSession({ ...f.request, sessionId, maxBytes: 1048576 }).finished).toBe(true)
  expect(inspectCompletionSession({ ...f.request, sessionId: 'another', maxBytes: 1048576 }).finished).toBe(false)
  appendFileSync(file, JSON.stringify({ sessionId, event: { seq: 3, type: 'goal/change', data: { goal: { phase: 'blocked' } } } }) + '\n')
  expect(inspectCompletionSession({ ...f.request, sessionId, maxBytes: 1048576 }).finished).toBe(false)
  appendFileSync(file, '{"partial":')
  expect(() => inspectCompletionSession({ ...f.request, sessionId, maxBytes: 1048576 })).toThrow('incomplete event')
})
it('rejects a directory link to another location without reading its target', () => {
  const f = fixture(), target = resolve(f.root, 'other'), link = resolve(f.runRoot, 'workspace/linked')
  f.put(resolve(target, 'secret.txt'), 'not authorized')
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  try { expect(() => inspectCompletionFile({ ...f.request, path: 'linked/secret.txt' })).toThrow('symbolic link') }
  finally { unlinkSync(link) }
})
