/** Scheduling assertions synchronize on executor admission and durable state. */
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { ClusterQueue } from '../src/cluster-queue.ts'
import type { ClusterExecutor, ClusterOutcome } from '../src/cluster-queue.ts'
import { clusterSubmissionSchema, serverIdSchema } from '../src/cluster-protocol.ts'
import type { ClusterRecord, ExperimentId, ExperimentServerId } from '../src/cluster-protocol.ts'

const queues: ClusterQueue[] = []
afterEach(async () => { await Promise.all(queues.splice(0).map(queue => queue.close())) })

function submission(ids: ExperimentServerId[]) {
  const node = (id: ExperimentServerId) => ({ server: { id, name: id, host: 'gpu.example', username: 'trainer', sshPort: 22,
    remotePort: 43019, remoteRoot: '/experiment', authMode: 'password', trainingAddress: '10.0.0.1' },
  devicePaths: ['/dev/nvidia0'], backendPath: '/usr/bin/bwrap', hiddenPaths: ['/experiment/secrets'], gpuInfo: 'GPU 0' })
  return clusterSubmissionSchema.parse({ protocol: 2, experimentId: randomUUID(), deploymentId: 'a'.repeat(64),
    objective: 'one joint training',
    coordinator: node(ids[0]!).server, nodes: ids.map(node), inputs: [], createdAt: 1 })
}

function fixture(records = new Map<ExperimentId, ClusterRecord>()) {
  const started = new Map<ExperimentId, { signal: AbortSignal; settle: (outcome: ClusterOutcome) => void }>()
  const table = { get: (id: ExperimentId) => records.get(id), entries: () => records.entries(),
    keys: () => records.keys(), get size() { return records.size },
    put: async (id: ExperimentId, record: ClusterRecord) => { records.set(id, structuredClone(record)) },
    delete: async (id: ExperimentId) => records.delete(id),
    update: async (id: ExperimentId, change: (value: ClusterRecord) => ClusterRecord) => {
      const value = change(records.get(id)!); records.set(id, value); return value
    },
  } satisfies KvTable<ExperimentId, ClusterRecord>
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
