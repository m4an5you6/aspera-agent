/** Scheduling assertions synchronize on executor admission and durable state. */
import { randomUUID, createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { ExperimentTable } from '../src/table.ts'
import { ClusterQueue } from '../src/cluster-queue.ts'
import type { ClusterExecutor, ClusterOutcome } from '../src/cluster-queue.ts'
import { clusterSubmissionSchema, clusterSubmissionV2Schema, clusterSubmissionV3Schema, legacyClusterSubmissionSchema, clusterRecordSchema, serverIdSchema, experimentQuestionSchema, needsExperimentAttention } from '../src/cluster-protocol.ts'
import type { ClusterRecord, ExperimentId, ExperimentServerId } from '../src/cluster-protocol.ts'
import { experimentIdSchema } from '../src/cluster-protocol.ts'
import { controllerRepairIdSchema } from '../src/controller-protocol.ts'
import { inventory, placement, modelSnapshots } from './fixtures.ts'

const queues: ClusterQueue[] = []
afterEach(async () => { await Promise.all(queues.splice(0).map(queue => queue.close())) })

function submission(ids: ExperimentServerId[]) {
  const experimentId = experimentIdSchema.parse(randomUUID())
  const node = (id: ExperimentServerId) => ({ server: { id, name: id, host: 'gpu.example', username: 'trainer', sshPort: 22,
    remotePort: 43019, remoteRoot: '/experiment', authMode: 'password', trainingAddress: '10.0.0.1', storagePlacement: placement(id, experimentId, '/experiment') },
  devicePaths: ['/dev/nvidia0'], backendPath: '/usr/bin/bwrap', hiddenPaths: ['/experiment/secrets'], gpuInfo: 'GPU 0' })
  return clusterSubmissionSchema.parse({ protocol: 4, name: 'Joint training', models: modelSnapshots(), experimentId, deploymentId: 'a'.repeat(64), inventories: ids.map(serverId => ({ serverId, inventory: inventory('/experiment') })),
    objective: 'one joint training',
    coordinator: node(ids[0]!).server, nodes: ids.map(node), inputs: [], createdAt: 1, strategy: { mode: 'automatic', coordinator: 'single-agent' }, versions: { dsh: '0.2.0-rc.2', extension: '0.1.1', harness: 'a'.repeat(64), data: [] } })
}

function fixture(records = new Map<ExperimentId, ClusterRecord>()) {
  const started = new Map<ExperimentId, { signal: AbortSignal; settle: (outcome: ClusterOutcome) => void }>()
  const table = { get: (id: ExperimentId) => records.get(id), entries: () => records.entries(),
    put: async (id: ExperimentId, record: ClusterRecord) => { records.set(id, structuredClone(record)) },
  } satisfies ExperimentTable<ExperimentId, ClusterRecord>
  const executor: ClusterExecutor = {
    run: async (record, signal, report) => {
      await report(`session-${record.submission.experimentId}`, `goal-${record.submission.experimentId}`)
      return new Promise<ClusterOutcome>((settle) => {
        const cancelled = () => { settle({ state: 'cancelled', resourcesReleased: true }) }
        signal.addEventListener('abort', cancelled, { once: true })
        started.set(record.submission.experimentId, { signal, settle: (result) => { signal.removeEventListener('abort',
          cancelled); settle(result) } })
        if (signal.aborted) cancelled()
      })
    },
    reconcile: vi.fn(async () => true),
  }
  const errors: unknown[] = []
  const queue = new ClusterQueue(table, executor, (error) => { errors.push(error) })
  queues.push(queue)
  return { queue, started, records, executor, errors }
}

async function pendingQuestion(mode: 'semi' | 'automatic' = 'semi') {
  const f = fixture()
  const base = submission([serverIdSchema.parse(randomUUID())])
  const input = { ...base, strategy: { ...base.strategy, mode } }
  await f.queue.submit(input)
  await vi.waitFor(() => { expect(f.started.has(input.experimentId)).toBe(true) })
  const question = experimentQuestionSchema.parse({ version: 1, experimentId: input.experimentId,
    questionId: randomUUID(), revision: 1, stage: 'running', sessionId: `session-${input.experimentId}`,
    callId: 'operator-decision', questions: [{ id: 'cleaning', question: 'Deduplicate records?', options: [{ label: 'Deduplicate' }, { label: 'Keep' }] }], state: 'open', createdAt: 1 })
  const reply = { questionId: question.questionId, revision: 1, sessionId: question.sessionId, callId: question.callId,
    answer: { answers: [{ id: 'cleaning', selected: ['Deduplicate'] }] } }
  return { ...f, input, question, reply }
}

it('fences new admission during idle maintenance and rejects waiting or active work', async () => {
  const f = fixture(); const id = controllerRepairIdSchema.parse(randomUUID()); const input = submission([serverIdSchema.parse(randomUUID())])
  await Promise.all([f.queue.beginMaintenance(id), f.queue.beginMaintenance(id)])
  await expect(f.queue.submit(input)).rejects.toThrow('maintenance')
  await expect(f.queue.cancelMaintenance(controllerRepairIdSchema.parse(randomUUID()))).rejects.toThrow('identity changed')
  await f.queue.cancelMaintenance(id)
  await f.queue.submit(input)
  await expect(f.queue.beginMaintenance(id)).rejects.toThrow('occupied')
})
it('persists one answer across concurrent retries and resumes the same allocation and identities', async () => {
  const f = await pendingQuestion()
  const before = f.queue.get(f.input.experimentId)!
  await f.queue.openQuestion(f.input.experimentId, f.question)
  expect(needsExperimentAttention(f.queue.get(f.input.experimentId)!)).toBe(true)
  const [first, retry] = await Promise.all([f.queue.answerQuestion(f.input.experimentId, f.reply), f.queue.answerQuestion(f.input.experimentId, f.reply)])
  expect(first.revision).toBe(retry.revision)
  expect(needsExperimentAttention(retry)).toBe(false)
  await f.queue.consumeQuestion(f.input.experimentId, { questionId: f.question.questionId, revision: 1, sessionId: f.question.sessionId, callId: f.question.callId })
  expect(f.queue.get(f.input.experimentId)).toMatchObject({ state: 'running', sessionId: before.sessionId, goalId: before.goalId, payloadHash: before.payloadHash, submission: before.submission, resourcesReleased: false })
  expect(f.started.size).toBe(1)
  await expect(f.queue.answerQuestion(f.input.experimentId, { ...f.reply, answer: { answers: [{ id: 'cleaning', selected: ['Keep'] }] } })).rejects.toThrow('different answer')
})

it('rejects stale bindings and unavailable choices, then expires the question on cancellation', async () => {
  const f = await pendingQuestion()
  await f.queue.openQuestion(f.input.experimentId, f.question)
  for (const patch of [{ revision: 2 }, { sessionId: 'another-session' }, { callId: 'another-call' }]) {
    await expect(f.queue.answerQuestion(f.input.experimentId, { ...f.reply, ...patch })).rejects.toThrow('binding changed')
  }
  await expect(f.queue.answerQuestion(f.input.experimentId, { ...f.reply, answer: { answers: [{ id: 'cleaning', selected: ['Change model'] }] } })).rejects.toThrow('unavailable options')
  await f.queue.cancel(f.input.experimentId)
  await vi.waitFor(() => { expect(f.queue.get(f.input.experimentId)?.state).toBe('cancelled') })
  expect(f.queue.get(f.input.experimentId)?.questions?.[0]?.state).toBe('expired')
  await expect(f.queue.answerQuestion(f.input.experimentId, f.reply)).rejects.toThrow('no longer accepting')
  expect(f.started.size).toBe(1)
})

it('rejects human waiting in automatic mode even through the trusted service API', async () => {
  const f = await pendingQuestion('automatic')
  await expect(f.queue.openQuestion(f.input.experimentId, f.question)).rejects.toThrow('unavailable')
  expect(f.queue.get(f.input.experimentId)?.state).toBe('running')
})

it('reports an interrupted question after restart without replaying training', async () => {
  const f = await pendingQuestion()
  await f.queue.openQuestion(f.input.experimentId, f.question)
  const saved = new Map([[f.input.experimentId, structuredClone(f.queue.get(f.input.experimentId)!)]])
  await f.queue.close()
  const recovered = fixture(saved)
  await recovered.queue.recover()
  expect(recovered.queue.get(f.input.experimentId)).toMatchObject({ state: 'interrupted', resourcesReleased: true, questions: [{ state: 'expired' }] })
  expect(recovered.started.size).toBe(0)
  await expect(recovered.queue.answerQuestion(f.input.experimentId, f.reply)).rejects.toThrow('no longer accepting')
})

it('runs disjoint experiments while an earlier group waits without holding partial nodes', async () => {
  const f = fixture()
  const [a, b, c] = [0, 1, 2].map(() => serverIdSchema.parse(randomUUID()))
  const first = submission([a!]); const group = submission([a!, b!]); const following = submission([b!]); const separate = submission([c!])
  const accepted = await f.queue.submit(first)
  expect(accepted).toMatchObject({ state: 'queued', resourcesReleased: true, handover: '本机派发完成，远端实验已接管' })
  expect(accepted.goalId).toBeUndefined()
  await vi.waitFor(() => { expect(f.started.has(first.experimentId)).toBe(true) })
  await f.queue.submit(group); await f.queue.submit(following); await f.queue.submit(separate)
  await vi.waitFor(() => { expect(f.started.has(separate.experimentId)).toBe(true) })
  expect(f.queue.get(group.experimentId)).toMatchObject({ state: 'queued', resourcesReleased: true })
  expect(f.queue.waitingFor(group.experimentId)).toEqual([a])
  expect(f.queue.waitingFor(following.experimentId)).toEqual([b])
  f.started.get(first.experimentId)!.settle({ state: 'completed', resourcesReleased: true })
  await vi.waitFor(() => { expect(f.started.has(group.experimentId)).toBe(true) })
  expect(f.started.has(following.experimentId)).toBe(false)
  f.started.get(group.experimentId)!.settle({ state: 'completed', resourcesReleased: true })
  await vi.waitFor(() => { expect(f.started.has(following.experimentId)).toBe(true) })
  expect(f.errors).toEqual([])
})

it('deduplicates lost replies and refuses reused identities with changed requirements', async () => {
  const f = fixture(); const input = submission([serverIdSchema.parse(randomUUID())])
  const receipts = await Promise.all([f.queue.submit(input), f.queue.submit(input)])
  expect(receipts[0].payloadHash).toBe(receipts[1].payloadHash)
  await vi.waitFor(() => { expect(f.started.size).toBe(1) })
  await expect(f.queue.submit({ ...input, objective: 'changed training' })).rejects.toThrow('different requirements')
  expect(f.records.size).toBe(1)
})

it.each([1, 2, 3] as const)('preserves generation %s bytes and versions without starting old pending work', async protocol => {
  const base = submission([serverIdSchema.parse(randomUUID())])
  const legacyData = JSON.parse(JSON.stringify(base))
  delete legacyData.name; delete legacyData.models
  if (protocol !== 3) {
    delete legacyData.inventories; delete legacyData.coordinator.storagePlacement
    for (const node of legacyData.nodes) delete node.server.storagePlacement
  }
  const legacy = protocol === 3 ? clusterSubmissionV3Schema.parse({ ...legacyData, protocol }) : protocol === 1 ? legacyClusterSubmissionSchema.parse({ ...legacyData, protocol,
    strategy: { ...base.strategy, budget: { maxRuntimeSeconds: 3600, maxCommands: 100, maxGoalRounds: 100, maxServiceSeconds: 86400 } },
    versions: { ...base.versions, extension: '0.1.0' } }) : clusterSubmissionV2Schema.parse({ ...legacyData, protocol,
    versions: { ...base.versions, extension: '0.2.0' } })
  const bytes = JSON.stringify(legacy)
  expect(JSON.stringify(clusterSubmissionSchema.parse(JSON.parse(bytes)))).toBe(bytes)
  const record = clusterRecordSchema.parse({ submission: legacy, payloadHash: createHash('sha256').update(bytes).digest('hex'),
    sequence: 0, revision: 1, state: 'queued', resourcesReleased: true, executions: [], services: [], updatedAt: 1,
    handover: '本机派发完成，远端实验已接管' })
  const f = fixture(new Map([[legacy.experimentId, record]]))
  await f.queue.recover()
  expect((await f.queue.submit(JSON.parse(bytes))).state).toBe('interrupted')
  expect(f.started.size).toBe(0)
  expect(f.queue.get(legacy.experimentId)?.submission).toEqual(legacy)
  expect(f.queue.get(legacy.experimentId)?.payloadHash).toBe(record.payloadHash)
  await expect(fixture().queue.submit(legacy)).rejects.toThrow('protocol 4')
})

it('records cancellation arriving before admission and never starts a later retry', async () => {
  const f = fixture(); const input = submission([serverIdSchema.parse(randomUUID())])
  const cancelled = await f.queue.cancel(input.experimentId, input)
  expect(cancelled.state).toBe('cancelled')
  expect((await f.queue.submit(input)).state).toBe('cancelled')
  await f.queue.close()
  expect(f.started.size).toBe(0)
})

it('retains occupancy after failed cleanup, and resumes queued work after confirmed cancellation', async () => {
  const f = fixture(); const ids = [serverIdSchema.parse(randomUUID())]
  const first = submission(ids); const second = submission(ids)
  await f.queue.submit(first); await f.queue.submit(second)
  await vi.waitFor(() => { expect(f.started.has(first.experimentId)).toBe(true) })
  f.started.get(first.experimentId)!.settle({ state: 'failed', resourcesReleased: false, detail: 'node unreachable' })
  await vi.waitFor(() => { expect(f.queue.get(first.experimentId)?.state).toBe('failed') })
  expect(f.queue.get(second.experimentId)?.state).toBe('queued')
  await f.queue.cancel(first.experimentId)
  await vi.waitFor(() => { expect(f.started.has(second.experimentId)).toBe(true) })
})

it('recovers durable queue order without replaying interrupted training', async () => {
  const f = fixture(); const ids = [serverIdSchema.parse(randomUUID())]
  const first = submission(ids); const second = submission(ids)
  await f.queue.submit(first); await f.queue.submit(second)
  await vi.waitFor(() => { expect(f.started.has(first.experimentId)).toBe(true) })
  const saved = new Map(f.records)
  await f.queue.close()
  const recovered = fixture(saved)
  await recovered.queue.recover()
  await vi.waitFor(() => { expect(recovered.started.has(second.experimentId)).toBe(true) })
  expect(recovered.started.has(first.experimentId)).toBe(false)
  expect(recovered.queue.get(first.experimentId)?.state).toBe('interrupted')
  expect(recovered.queue.list().map(row => row.sequence)).toEqual([0, 1])
})

it('prepares semi-automatic plans without reserving nodes and confirms the displayed revision once', async () => {
  const f = fixture()
  const plans = new Map<ExperimentId, ReturnType<typeof Promise.withResolvers<{ plan: import('../src/cluster-protocol.ts').ExperimentPlan; sessionId: string }>>>()
  f.executor.prepare = (record) => {
    const pending = Promise.withResolvers<{ plan: import('../src/cluster-protocol.ts').ExperimentPlan; sessionId: string }>()
    plans.set(record.submission.experimentId, pending)
    return pending.promise
  }
  const ids = [serverIdSchema.parse(randomUUID())]
  const first = { ...submission(ids), strategy: { ...submission(ids).strategy, mode: 'semi' as const } }
  const second = submission(ids)
  await f.queue.submit(first); await f.queue.submit(second)
  await vi.waitFor(() => { expect(plans.size).toBe(2) })
  const plan = { revision: 1, summary: 'bounded short run', steps: ['install isolated environment', 'run and evaluate'], frameworks: [], createdAt: 1 }
  plans.get(first.experimentId)!.resolve({ plan, sessionId: 'planning-first' })
  plans.get(second.experimentId)!.resolve({ plan, sessionId: 'planning-second' })
  await vi.waitFor(() => { expect(f.started.has(second.experimentId)).toBe(true) })
  expect(f.queue.get(first.experimentId)).toMatchObject({ state: 'awaiting-approval', resourcesReleased: true, planningSessionId: 'planning-first' })
  expect(f.queue.get(second.experimentId)?.approval?.by).toBe('policy')
  await expect(f.queue.approve(first.experimentId, 2)).rejects.toThrow('plan changed')
  await f.queue.approve(first.experimentId, 1)
  expect(f.queue.waitingFor(first.experimentId)).toEqual(ids)
  expect(f.started.has(first.experimentId)).toBe(false)
  f.started.get(second.experimentId)!.settle({ state: 'completed', resourcesReleased: true })
  await vi.waitFor(() => { expect(f.started.has(first.experimentId)).toBe(true) })
  expect(f.queue.get(first.experimentId)?.approval?.by).toBe('user')
})

it('does not enqueue a plan that arrives after cancellation', async () => {
  const f = fixture()
  const pending = Promise.withResolvers<{ plan: import('../src/cluster-protocol.ts').ExperimentPlan; sessionId: string }>()
  f.executor.prepare = () => pending.promise
  const input = submission([serverIdSchema.parse(randomUUID())])
  await f.queue.submit(input)
  await vi.waitFor(() => { expect(f.queue.get(input.experimentId)?.state).toBe('planning') })
  await f.queue.cancel(input.experimentId)
  pending.resolve({ plan: { revision: 1, summary: 'late plan', steps: ['train'], frameworks: [], createdAt: 1 }, sessionId: 'late-plan' })
  await f.queue.close()
  expect(f.started.size).toBe(0)
  expect(f.queue.get(input.experimentId)).toMatchObject({ state: 'cancelled', resourcesReleased: true })
})

it('restores service observation after coordinator restart and keeps dependent work queued until cleanup', async () => {
  const f = fixture()
  const ids = [serverIdSchema.parse(randomUUID())]
  const first = submission(ids); const second = submission(ids)
  const receipt = await f.queue.submit(first)
  await vi.waitFor(() => { expect(f.started.has(first.experimentId)).toBe(true) })
  const saved = new Map<ExperimentId, ClusterRecord>([[first.experimentId, { ...receipt, state: 'serving', resourcesReleased: false }]])
  await f.queue.close()
  const recovered = fixture(saved)
  const observing = Promise.withResolvers<ClusterOutcome>()
  recovered.executor.restore = vi.fn((_record, signal) => {
    signal.addEventListener('abort', () => observing.resolve({ state: 'serving', resourcesReleased: false }), { once: true })
    return observing.promise
  })
  await recovered.queue.recover(); await recovered.queue.submit(second)
  await vi.waitFor(() => { expect(recovered.executor.restore).toHaveBeenCalledOnce() })
  expect(recovered.started.size).toBe(0)
  expect(recovered.queue.waitingFor(second.experimentId)).toEqual(ids)
  expect(recovered.executor.reconcile).not.toHaveBeenCalled()
  observing.resolve({ state: 'completed', resourcesReleased: true })
  await vi.waitFor(() => { expect(recovered.started.has(second.experimentId)).toBe(true) })
  expect(recovered.started.has(first.experimentId)).toBe(false)
})
