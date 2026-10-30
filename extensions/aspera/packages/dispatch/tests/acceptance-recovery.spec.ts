/** A serving recovery cannot substitute another checkpoint or bypass original completion acceptance. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import { acceptanceSourceSchema, acceptanceRecoveryObservationSchema, checkAcceptanceRecovery } from '@aspera/experiments'
import type { CompletionReview } from '@aspera/experiments'
import { AcceptanceRecoveries } from '../src/acceptance-recovery.ts'
import type { AcceptanceRecoveryOwner } from '../src/acceptance-recovery.ts'
import type { FleetExperiment } from '../src/types.ts'

function fixture() {
  const original = randomUUID(), recovery = randomUUID(), server = randomUUID(), service = randomUUID(), command = 'serve-230'
  const files = ['adapter_config.json', 'adapter_model.safetensors', 'trainer_state.json'].map((name, index) => ({ name, device: '1', inode: String(index + 10), bytes: 100, modified: 100, sha256: 'a'.repeat(64) }))
  const node = { serverId: server, step: 230, commandId: 'train-230', checkpointId: 'b'.repeat(64), directory: 'outputs/checkpoint-230', files, publicUrl: 'https://example.org/inference', modelName: 'qwen9b-230' }
  const source = acceptanceSourceSchema.parse({ experimentId: original, submissionHash: 'c'.repeat(64), resultRevision: 3, planRevision: 1, executionSessionId: 'original-session', nodes: [node] })
  const observation = acceptanceRecoveryObservationSchema.parse({ experimentId: recovery, submissionHash: 'd'.repeat(64), deploymentId: 'e'.repeat(64), state: 'serving', goalFinished: true,
    snapshots: [{ version: 1, experimentId: recovery, serverId: server, request: { operationId: randomUUID(), sourceExperimentId: original, checkpointId: node.checkpointId },
      source: { serverId: server, step: node.step, commandId: node.commandId, checkpointId: node.checkpointId, directory: node.directory,
        sourceExperimentId: original, files: files.map(({ sha256: _sha, ...file }) => file) },
      state: 'ready', destination: 'inference-checkpoints/' + node.checkpointId, mode: 'hardlink', additionalFileBytes: 0, files, startedAt: 100, updatedAt: 101 }],
    services: [{ id: service, experimentId: recovery, serverId: server, commandId: command, command: 'python infer.py', modelPath: 'inference-checkpoints/' + node.checkpointId,
      port: 18000, healthPath: '/health', modelName: node.modelName, createdAt: 110, updatedAt: 120, state: 'healthy', released: false,
      external: { url: node.publicUrl, port: 3000, state: 'reachable' } }],
    verifications: [{ version: 1, experimentId: recovery, serverId: server, deploymentId: 'e'.repeat(64), input: { operationId: randomUUID(), serviceId: service, maxTokens: 8 },
      commandId: command, modelName: node.modelName, url: node.publicUrl, createdAt: 120, deadline: 220, state: 'passed', result: { state: 'passed', detail: 'Public observations', finishedAt: 130,
        checks: ['identity', 'unauthenticated', 'invalid-credential', 'models', 'generation'].map(name => ({ name, passed: true, checkedAt: 125, detail: 'observed' })) } }],
  })
  return { source, observation }
}
it('accepts the retained native adapter only after stable serving and all public observations', () => {
  const f = fixture(); expect(checkAcceptanceRecovery(f.source, f.observation)).toEqual({ ready: true, blocked: false, issues: [] })
})
it.each(['checkpoint', 'modelPath', 'release', 'command', 'url', 'generation', 'duplicate', 'stopped', 'goal'] as const)('rejects incompatible or incomplete %s evidence', kind => {
  const f = fixture(), snapshot = f.observation.snapshots[0]!, service = f.observation.services[0]!, check = f.observation.verifications[0]!
  if (kind === 'checkpoint') snapshot.files[0]!.sha256 = 'f'.repeat(64)
  if (kind === 'modelPath') service.modelPath = 'another-adapter'
  if (kind === 'release') check.deploymentId = f.source.submissionHash
  if (kind === 'command') check.commandId = 'an-earlier-process'
  if (kind === 'url') service.external!.url = 'https://another.example.org'
  if (kind === 'generation') check.result!.checks[4]!.passed = false
  if (kind === 'duplicate') check.result!.checks[4]!.name = 'identity'
  if (kind === 'stopped') service.released = true
  if (kind === 'goal') f.observation.goalFinished = false
  expect(checkAcceptanceRecovery(f.source, f.observation).ready).toBe(false)
})
it('does not accept a missing selected inference node or a replaced original file', () => {
  const f = fixture(); f.source.nodes.push({ ...f.source.nodes[0]!, serverId: acceptanceSourceSchema.shape.nodes.element.shape.serverId.parse(randomUUID()) })
  expect(checkAcceptanceRecovery(f.source, f.observation).ready).toBe(false)
  f.source.nodes.pop(); f.source.nodes[0]!.files[1]!.inode = 'replaced'
  expect(checkAcceptanceRecovery(f.source, f.observation)).toMatchObject({ ready: false, blocked: true })
})

const roots: string[] = [], instances: AcceptanceRecoveries[] = []
afterEach(async () => { await Promise.all(instances.splice(0).map(instance => instance.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function serviceFixture() {
  const f = fixture(), id = f.source.experimentId, related = f.observation.experimentId, serverIds = f.source.nodes.map(node => node.serverId)
  mkdirSync(resolve('.artifacts'), { recursive: true }); const root = mkdtempSync(resolve('.artifacts', 'acceptance-recovery-')); roots.push(root)
  const original = fromAny<FleetExperiment, object>({ request: { experimentId: id, serverIds }, submission: { experimentId: id },
    latest: { state: 'blocked', revision: 3, resourcesReleased: true, sessionId: 'original-session', plan: { revision: 1 } } })
  const recovery = fromAny<FleetExperiment, object>({ request: { experimentId: related, serverIds }, submission: { protocol: 4, deploymentId: f.observation.deploymentId, experimentId: related },
    latest: { state: 'running', resourcesReleased: false, plan: { workload: 'inference' } } })
  const digest = (value: object) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
  f.source.submissionHash = digest(original.submission!); f.observation.submissionHash = digest(recovery.submission!)
  let alive = true, passed = false
  const reviewOperationId = randomUUID()
  const owner: AcceptanceRecoveryOwner = {
    get: requested => { if (!alive) throw new Error('Deleted'); return requested === id ? original : recovery }, alive: () => alive,
    candidates: () => [recovery], source: vi.fn(async () => structuredClone(f.source)), observe: vi.fn(async () => structuredClone(f.observation)),
    evidence: vi.fn(async () => ({ path: 'reports/acceptance-recovery/proof.json', sha256: 'f'.repeat(64) })), changed: vi.fn(),
    review: vi.fn(() => fromAny<CompletionReview, object>({ operationId: reviewOperationId, phase: 'collecting' })),
    reviewStatus: () => fromAny<CompletionReview, object>({ operationId: reviewOperationId, phase: passed ? 'passed' : 'collecting', remoteCommitted: passed,
      check: { ready: passed }, submissionHash: f.source.submissionHash, originalRevision: 3, executionSessionId: 'original-session' }),
  }
  const make = (reconnectMs = 1000) => { const instance = new AcceptanceRecoveries(root, owner, 5, reconnectMs); instances.push(instance); return instance }
  return { ...f, root, id, related, original, recovery, owner, make, pass: () => { passed = true }, remove: () => { alive = false } }
}
it('adopts existing inference beneath the original without changing either submission and waits for independent original acceptance', async () => {
  const f = serviceFixture(), service = f.make(), original = JSON.stringify(f.original), related = JSON.stringify(f.recovery)
  const row = await service.request(f.id, f.related)
  expect((await service.request(f.id, f.related)).operationId).toBe(row.operationId)
  await vi.waitFor(() => { expect(service.status(f.id)?.phase).toBe('reviewing') })
  expect(f.owner.review).toHaveBeenCalledTimes(1); expect(f.owner.evidence).toHaveBeenCalledTimes(1)
  expect(service.status(f.id)?.phase).not.toBe('passed'); f.pass()
  await vi.waitFor(() => { expect(service.status(f.id)?.phase).toBe('passed') })
  expect(JSON.stringify(f.original)).toBe(original); expect(JSON.stringify(f.recovery)).toBe(related)
  expect(f.owner.evidence).toHaveBeenCalledTimes(1)
})
it('retries a temporary observation timeout without interrupting or replacing the running recovery', async () => {
  const f = serviceFixture(), original = JSON.stringify(f.original), recovery = JSON.stringify(f.recovery)
  f.owner.observe = vi.fn().mockRejectedValueOnce(new DOMException('Read deadline reached', 'TimeoutError')).mockResolvedValue(f.observation)
  const service = f.make(), row = await service.request(f.id, f.related)
  await vi.waitFor(() => { expect(service.status(f.id)?.phase).toBe('reviewing') })
  expect(service.status(f.id)?.operationId).toBe(row.operationId)
  expect(vi.mocked(f.owner.observe).mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(f.owner.review).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(f.original)).toBe(original); expect(JSON.stringify(f.recovery)).toBe(recovery)
})
it('retains the same recovery after its observation connection budget is exhausted', async () => {
  const f = serviceFixture()
  f.owner.observe = vi.fn().mockRejectedValue(new DOMException('Read deadline reached', 'TimeoutError'))
  const service = f.make(20), row = await service.request(f.id, f.related)
  await vi.waitFor(() => { expect(service.status(f.id)?.phase).toBe('blocked') })
  expect(service.status(f.id)?.detail).toContain('connection recovery budget exhausted')
  expect(service.status(f.id)?.recoveryExperimentId).toBe(f.related)
  expect(f.owner.review).not.toHaveBeenCalled()
  f.owner.observe = vi.fn().mockResolvedValue(f.observation)
  expect((await service.request(f.id, f.related)).operationId).toBe(row.operationId)
  await vi.waitFor(() => { expect(service.status(f.id)?.phase).toBe('reviewing') })
})
it('keeps native training retained when recovered generation fails and does not start a completion review', async () => {
  const f = serviceFixture(); f.observation.state = 'blocked'; f.observation.verifications[0]!.result!.checks[4]!.passed = false
  const service = f.make(); await service.request(f.id, f.related)
  await vi.waitFor(() => { expect(service.status(f.id)?.phase).toBe('blocked') })
  expect(f.owner.review).not.toHaveBeenCalled(); expect(f.owner.evidence).not.toHaveBeenCalled()
  expect(f.original.latest?.state).toBe('blocked')
})
it('restores the same recovery operation after Host restart and refuses changed original identity', async () => {
  const f = serviceFixture(); f.observation.goalFinished = false
  const service = f.make(), row = await service.request(f.id, f.related)
  await vi.waitFor(() => { expect(f.owner.observe).toHaveBeenCalled() }); await service.close()
  const restored = f.make(); expect(restored.status(f.id)?.operationId).toBe(row.operationId)
  const before = vi.mocked(f.owner.observe).mock.calls.length
  restored.resume(); await vi.waitFor(() => { expect(vi.mocked(f.owner.observe).mock.calls.length).toBeGreaterThan(before) })
  f.original.latest!.revision++
  await vi.waitFor(() => { expect(restored.status(f.id)?.phase).toBe('blocked') })
  expect(f.owner.review).not.toHaveBeenCalled()
})
it('rejects another server and removes the observation task before deleting local recovery records', async () => {
  const f = serviceFixture(), service = f.make(); f.recovery.request.serverIds = []
  await expect(service.request(f.id, f.related)).rejects.toThrow('No existing inference recovery')
  f.recovery.request.serverIds = [...f.original.request.serverIds]; f.observation.goalFinished = false
  await service.request(f.id, f.related); await service.forget(f.id)
  expect(service.status(f.id)).toBeUndefined(); expect(f.owner.review).not.toHaveBeenCalled()
})
it('continues a released blocked inference as an internal runtime beneath the same original acceptance operation', async () => {
  const f = serviceFixture(), original = JSON.stringify(f.original)
  f.recovery.latest = { ...f.recovery.latest!, state: 'blocked', resourcesReleased: true, services: [] }
  let child: FleetExperiment | undefined
  const get = f.owner.get
  f.owner.get = id => child?.request.experimentId === id ? child : get(id)
  f.owner.createRuntime = vi.fn(async (_original, _previous, id) => {
    child = fromAny<FleetExperiment, object>({ request: { experimentId: id }, state: 'preparing', preparation: { stage: 'inspecting' } })
  })
  const service = f.make(), row = await service.request(f.id, f.related)
  expect(row.experimentId).toBe(f.id); expect(row.pendingRuntimeId).not.toBe(f.id); expect(row.pendingRuntimeId).not.toBe(f.related)
  expect(service.parentOf(row.pendingRuntimeId!)).toBe(f.id); expect(service.parentOf(f.related)).toBeUndefined()
  expect((await service.request(f.id)).operationId).toBe(row.operationId)
  expect(f.owner.createRuntime).toHaveBeenCalledTimes(1); expect(f.owner.review).not.toHaveBeenCalled()
  expect(JSON.stringify(f.original)).toBe(original)
})
it('blocks a status response from another recovery identity before saving any acceptance evidence', async () => {
  const f = serviceFixture(); f.observation.experimentId = f.source.experimentId
  const service = f.make(); await service.request(f.id, f.related)
  await vi.waitFor(() => { expect(service.status(f.id)?.phase).toBe('blocked') })
  expect(f.owner.evidence).not.toHaveBeenCalled(); expect(f.owner.review).not.toHaveBeenCalled()
})
