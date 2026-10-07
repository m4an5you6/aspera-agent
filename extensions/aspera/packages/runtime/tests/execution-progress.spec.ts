/** Isolated coordinator files exercise revision conflicts and immutable plan ownership. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { clusterRecordSchema, executionStepReportSchema, experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import type { ExecutionStepReport } from '@aspera/experiments'
import { inventory, modelSnapshots, placement } from '../../experiments/tests/fixtures.ts'
import { ExecutionProgressStore } from '../src/execution-progress.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    expect(root.startsWith(resolve('.artifacts') + sep)).toBe(true)
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts/execution-progress-')); roots.push(root)
  const experimentId = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const remoteRoot = root.replaceAll('\\', '/').replace(/^[A-Za-z]:/, '')
  const coordinator = { id: serverId, name: 'Node', host: 'fixture.test', username: 'trainer', sshPort: 22, remotePort: 43019,
    remoteRoot, storagePlacement: placement(serverId, experimentId, remoteRoot), authMode: 'password' }
  const record = clusterRecordSchema.parse({ submission: { protocol: 4, name: 'Step reports', experimentId, deploymentId: 'a'.repeat(64),
    models: modelSnapshots(), objective: 'A joint experiment', inventories: [{ serverId, inventory: inventory(remoteRoot) }],
    coordinator, nodes: [{ server: coordinator, devicePaths: ['/dev/nvidia_fixture'], backendPath: '/fixture/bwrap', hiddenPaths: [], gpuInfo: 'CPU fixture' }],
    inputs: [], createdAt: 1, strategy: { mode: 'automatic', coordinator: 'single-agent' },
    versions: { dsh: '0.2.0-rc.2', extension: '0.1.1', harness: 'a'.repeat(64), data: [] } },
    payloadHash: 'b'.repeat(64), sequence: 1, revision: 1, state: 'running', resourcesReleased: false, updatedAt: 1,
    handover: '本机派发完成，远端实验已接管', executions: [], services: [], sessionId: 'execution-session',
    plan: { revision: 1, summary: 'Two actual plan steps', steps: ['Prepare', 'Verify'], frameworks: [], createdAt: 1 },
    approval: { planRevision: 1, approvedAt: 1, by: 'policy' } })
  mkdirSync(resolve(root, 'state'), { recursive: true }); mkdirSync(resolve(root, 'runs', experimentId), { recursive: true })
  writeFileSync(resolve(root, 'state/coordinator.generation'), 'generation')
  const store = new ExecutionProgressStore(root)
  const report = executionStepReportSchema.parse({ experimentId, planRevision: 1, sessionId: 'execution-session', generation: 'generation',
    callId: 'first-call', expectedRevision: 0, step: 1, state: 'running', detail: 'Preparing the selected nodes' })
  return { root, record, store, report, path: resolve(root, 'runs', experimentId, 'execution-progress.v1.json') }
}

it('starts unreported steps without writing during a read and restores actual reports', () => {
  const f = fixture()
  expect(f.store.read(f.record)).toMatchObject({ revision: 0, steps: [{ state: 'pending' }, { state: 'pending' }] })
  expect(existsSync(f.path)).toBe(false)
  const result = f.store.report(f.record, f.report)
  expect(result).toMatchObject({ accepted: true, progress: { revision: 1, steps: [{ state: 'running', callId: 'first-call' }, { state: 'pending' }] } })
  expect(new ExecutionProgressStore(f.root).read(f.record)).toEqual(result.progress)
  expect(existsSync(f.path + '.incoming')).toBe(false)
})

it('deduplicates a lost-response retry and rejects concurrent reports using an older revision', async () => {
  const f = fixture()
  const [first, conflicting] = await Promise.all([
    Promise.resolve().then(() => f.store.report(f.record, f.report)),
    Promise.resolve().then(() => f.store.report(f.record, { ...f.report, callId: 'parallel', step: 2 })),
  ])
  expect(first.accepted).toBe(true)
  expect(conflicting).toMatchObject({ accepted: false, error: expect.stringContaining('latest revision'), progress: { revision: 1 } })
  expect(f.store.report(f.record, { ...f.report, callId: 'response-retry' })).toEqual(first)
  expect(f.store.read(f.record)?.revision).toBe(1)
})

it('requires a start before completion, allows blocked work to continue and never reopens completed steps', () => {
  const f = fixture()
  expect(f.store.report(f.record, { ...f.report, state: 'completed' }).accepted).toBe(false)
  f.store.report(f.record, f.report)
  f.store.report(f.record, { ...f.report, expectedRevision: 1, state: 'blocked', detail: 'Download failed' })
  f.store.report(f.record, { ...f.report, expectedRevision: 2, state: 'running', detail: 'Retrying verified source' })
  expect(f.store.report(f.record, { ...f.report, expectedRevision: 3, state: 'completed', detail: 'Validated on all nodes' }).accepted).toBe(true)
  expect(f.store.report(f.record, { ...f.report, expectedRevision: 4 })).toMatchObject({ accepted: false, error: expect.stringContaining('cannot be reopened') })
  expect(f.store.read(f.record)?.steps[1]?.state).toBe('pending')
})

it('rejects another experiment, plan, Session, coordinator generation and invalid step without changing files', () => {
  const f = fixture(); f.store.report(f.record, f.report)
  const before = readFileSync(f.path, 'utf8')
  const variants: Partial<ExecutionStepReport>[] = [{ experimentId: executionStepReportSchema.shape.experimentId.parse(randomUUID()) },
    { planRevision: 2 }, { sessionId: 'another-session' }, { generation: 'old-generation' }, { step: 99 }]
  for (const variant of variants) {
    expect(f.store.report(f.record, { ...f.report, expectedRevision: 1, ...variant }).accepted).toBe(false)
    expect(readFileSync(f.path, 'utf8')).toBe(before)
  }
  for (const state of ['waiting-reply', 'cancelling', 'cancelled', 'blocked', 'failed', 'completed', 'interrupted', 'serving'] as const) {
    expect(f.store.report({ ...f.record, state }, { ...f.report, expectedRevision: 1, step: 2 }).accepted).toBe(false)
    expect(readFileSync(f.path, 'utf8')).toBe(before)
  }
})

it('refuses mismatched saved ownership and removes progress with the owned experiment directory', () => {
  const f = fixture(); f.store.report(f.record, f.report)
  const changed = structuredClone(f.record); changed.plan!.revision = 2
  expect(() => f.store.read(changed)).toThrow('another experiment, plan or Session')
  const progress = f.store.read(f.record)!
  writeFileSync(f.path, JSON.stringify({ ...progress, steps: progress.steps.reverse() }))
  expect(() => f.store.read(f.record)).toThrow('another experiment, plan or Session')
  const ownedRun = resolve(f.root, 'runs', f.record.submission.experimentId)
  expect(ownedRun.startsWith(f.root + sep)).toBe(true)
  rmSync(ownedRun, { recursive: true })
  expect(existsSync(f.path)).toBe(false)
})
