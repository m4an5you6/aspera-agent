import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ExperimentReceiver, submissionHash } from '../src/index.ts'
import type { ExperimentRecord, ExperimentSubmission } from '../src/protocol.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-experiment-receiver-'))
  roots.push(root)
  const records = new Map<string, ExperimentRecord>()
  const handle = {
    agent: {
      session: { id: 'session' },
      followup: vi.fn(),
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => {}),
    },
    dispose: vi.fn(async () => {}),
  }
  const create = vi.fn(async () => handle)
  const ctx = {
    agentDefaultModel: { currentSelection: () => ({ provider: 'test', model: 'test' }) },
    agents: { create },
    goals: { create: () => ({ id: 'goal-1' }), get: () => ({ phase: 'active' }) },
    sessions: { flush: async () => true },
    on: () => () => {},
    logger: { error: vi.fn() },
  } as unknown as Context
  const store = {
    table: () => ({
      get: (id: string) => records.get(id),
      put: async (id: string, record: ExperimentRecord) => { records.set(id, record) },
      entries: () => records.entries(),
    }),
    close: async () => {},
  } as unknown as ConstructorParameters<typeof ExperimentReceiver>[2]
  const submission: ExperimentSubmission = {
    submissionId: 'a'.repeat(64), deploymentId: 'b'.repeat(64),
    spec: { objective: 'train', datasetRefs: [], constraints: [], requiredGpus: 1, outputPath: 'artifacts/run' },
  }
  const receiver = new ExperimentReceiver(ctx, {
    workspaceRoot: root, tokenFile: join(root, 'token'), logFile: join(root, 'worker.log'),
    deploymentId: submission.deploymentId, devicePaths: ['/dev/nvidia1'],
  }, store)
  return { receiver, records, create, handle, submission, root }
}

it('accepts concurrent identical submissions once and rejects changed requirements', async () => {
  const { receiver, create, submission } = fixture()
  try {
    const [first, second] = await Promise.all([receiver.submit(submission), receiver.submit(submission)])
    expect(first).toEqual(second)
    expect(first).toMatchObject({ state: 'accepted', goalId: 'goal-1' })
    expect(create).toHaveBeenCalledOnce()
    await expect(receiver.submit({ ...submission, spec: { ...submission.spec, objective: 'different' } }))
      .rejects.toThrow('different requirements')
  } finally {
    await receiver.close()
  }
})

it('marks an unfinished reservation interrupted and never starts it again', async () => {
  const { receiver, records, create, submission, root } = fixture()
  records.set(submission.submissionId, {
    ...submission, payloadHash: submissionHash(submission), sessionId: 'experiment-1',
    artifactPath: join(root, 'artifacts'), workerLogPath: join(root, 'worker.log'),
    state: 'reserved', createdAt: 1, updatedAt: 1,
  })
  try {
    await receiver.recover()
    expect(records.get(submission.submissionId)?.state).toBe('interrupted')
    expect(receiver.status(submission.submissionId)).toMatchObject({ state: 'interrupted', artifactFiles: [] })
    expect((await receiver.submit(submission)).state).toBe('interrupted')
    expect(create).not.toHaveBeenCalled()
  } finally {
    await receiver.close()
  }
})

it('rejects insufficient allocated GPUs and paths outside the experiment workspace before creating an Agent', async () => {
  const { receiver, create, submission } = fixture()
  try {
    await expect(receiver.submit({ ...submission, spec: { ...submission.spec, requiredGpus: 2 } }))
      .rejects.toThrow('requires 2 GPUs but only 1')
    await expect(receiver.submit({ ...submission, spec: { ...submission.spec, outputPath: '../outside' } }))
      .rejects.toThrow('outputPath may not traverse')
    expect(create).not.toHaveBeenCalled()
  } finally {
    await receiver.close()
  }
})

it('cancels the owned Agent before recording a terminal cancellation', async () => {
  const { receiver, handle, submission } = fixture()
  try {
    await receiver.submit(submission)
    const cancelled = await receiver.cancel(submission.submissionId)
    expect(cancelled?.state).toBe('cancelled')
    expect(handle.agent.cancel).toHaveBeenCalledWith({ kind: 'hook', reason: 'experiment receiver cancellation' })
    expect(handle.dispose).toHaveBeenCalledOnce()
  } finally {
    await receiver.close()
  }
})
