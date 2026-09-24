import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, expect, it, vi } from 'vitest'
import { submissionHash } from '@deepseek-ai/dsh-experiment-worker'
import type { ExperimentRecord, ExperimentSubmission } from '@deepseek-ai/dsh-experiment-worker'
import { ExperimentDispatcher } from '../src/index.ts'
import { deploy } from '../src/deploy.ts'
import type { DeploymentConfig, PreparedEnvironment } from '../src/deploy.ts'
import { snapshotSource } from '../src/snapshot.ts'
import { request } from '../src/transport.ts'

vi.mock('../src/transport.ts', () => ({ request: vi.fn() }))
vi.mock('../src/deploy.ts', () => ({ deploy: vi.fn() }))
vi.mock('../src/snapshot.ts', () => ({ snapshotSource: vi.fn() }))

beforeEach(() => { vi.resetAllMocks() })

function fixture() {
  const deploymentId = 'd'.repeat(64)
  const preparationId = deploymentId
  const prepared: PreparedEnvironment = {
    state: 'ready', deploymentId, preparationId, backend: 'bwrap', backendPath: '/usr/bin/bwrap',
    sandboxWriteProbe: 'passed', cudaProbe: 'passed', devicePaths: ['/dev/nvidia1'],
    hiddenPaths: ['/worker/secrets'], workspaceRoot: '/worker/workspace',
  }
  const submissions = new Map<string, unknown>()
  const table = (name: string) => ({
    get: (key: string) => name === 'preparations' ? key === preparationId ? prepared : undefined : submissions.get(key),
    put: async (key: string, value: unknown) => { submissions.set(key, value) },
  })
  const store = { table } as unknown as ConstructorParameters<typeof ExperimentDispatcher>[2]
  const ctx = {
    credentials: { resolve: async () => ({ value: 'test-receiver-token' }) },
    logger: { warn: vi.fn() },
  } as unknown as Context
  const config: DeploymentConfig = {
    host: 'gpu.example', sshPort: 22, remotePort: 43019, remoteRoot: '/worker',
    localRepo: '/repo', dataRoots: [], allowedSystemPackages: [], agentCredentialRefs: [],
    tokenRef: 'DSH_EXPERIMENT_TOKEN', toolTimeoutMs: 60_000,
  }
  const health = { deploymentId, ready: true, busy: false }
  vi.mocked(snapshotSource).mockResolvedValue({ directory: '/snapshot', archive: '/snapshot/source.tar', digest: deploymentId, archiveHash: 'a'.repeat(64), dispose: vi.fn() })
  vi.mocked(deploy).mockResolvedValue(prepared)
  vi.mocked(request).mockImplementation(async (_target, _token, path, _method, body) => {
    if (path.endsWith('/health')) return { status: 200, value: health }
    return { status: 200, value: receipt(body as ExperimentSubmission) }
  })
  return {
    dispatcher: new ExperimentDispatcher(ctx, config, store), preparationId, submissions, health,
    input: { objective: 'train a small model', datasetRefs: [], constraints: [], requiredGpus: 1 },
  }
}

function receipt(submitted: ExperimentSubmission): ExperimentRecord {
  return {
    ...submitted, payloadHash: submissionHash(submitted), sessionId: `experiment-${submitted.submissionId}`,
    goalId: 'goal-1', state: 'complete', artifactPath: '/worker/workspace/artifacts/run',
    workerLogPath: '/worker/logs/worker.log', createdAt: 1, updatedAt: 2,
  }
}

it('retries a lost acceptance receipt with the same id even after the remote Goal completes', async () => {
  const { dispatcher, preparationId, submissions, health, input } = fixture()
  const seen: string[] = []
  vi.mocked(request).mockImplementation(async (_target, _token, path, _method, body) => {
    if (path.endsWith('/health')) return { status: 200, value: health }
    const submitted = body as ExperimentSubmission
    seen.push(submitted.submissionId)
    if (seen.length === 1) throw new Error('receipt lost')
    return { status: 200, value: receipt(submitted) }
  })
  const result = await dispatcher.submit('local-session', preparationId, input)
  expect(result.state).toBe('complete')
  expect(result.goalId).toBe('goal-1')
  expect(seen).toHaveLength(2)
  expect(seen[0]).toBe(seen[1])
  expect(submissions.size).toBe(1)
})

it('stops retrying after cancellation and preserves the submission id for a later query or retry', async () => {
  const { dispatcher, preparationId, submissions, health, input } = fixture()
  const controller = new AbortController()
  const reason = new Error('user cancelled submission')
  const seen: string[] = []
  vi.mocked(request).mockImplementation(async (_target, _token, path, _method, body) => {
    if (path.endsWith('/health')) return { status: 200, value: health }
    const submitted = body as ExperimentSubmission
    seen.push(submitted.submissionId)
    if (seen.length === 1) {
      controller.abort(reason)
      throw reason
    }
    return { status: 200, value: receipt(submitted) }
  })

  await expect(dispatcher.submit('local-session', preparationId, input, controller.signal)).rejects.toBe(reason)
  expect(seen).toHaveLength(1)
  expect(submissions.size).toBe(1)
  const resumed = await dispatcher.submit('local-session', preparationId, input)
  expect(resumed.submissionId).toBe(seen[0])
  expect(seen).toHaveLength(2)
  expect(submissions.size).toBe(1)
})

it('does not contact the worker for an already cancelled submission', async () => {
  const { dispatcher, preparationId, submissions, input } = fixture()
  const signal = AbortSignal.abort(new Error('already cancelled'))
  await expect(dispatcher.submit('local-session', preparationId, input, signal)).rejects.toBe(signal.reason)
  expect(request).not.toHaveBeenCalled()
  expect(submissions.size).toBe(0)
})

it.each([
  ['missing readiness', { deploymentId: 'd'.repeat(64), busy: false }],
  ['missing busy state', { deploymentId: 'd'.repeat(64), ready: true }],
  ['unready worker', { deploymentId: 'd'.repeat(64), ready: false, busy: false }],
  ['non-boolean busy state', { deploymentId: 'd'.repeat(64), ready: true, busy: 'false' }],
  ['unknown field', { deploymentId: 'd'.repeat(64), ready: true, busy: false, unexpected: true }],
  ['non-object', null],
])('rejects health with %s before recording or sending an experiment', async (_name, value) => {
  const { dispatcher, preparationId, submissions, input } = fixture()
  vi.mocked(request).mockResolvedValueOnce({ status: 200, value })
  await expect(dispatcher.submit('local-session', preparationId, input)).rejects.toThrow()
  expect(request).toHaveBeenCalledOnce()
  expect(submissions.size).toBe(0)
})

it('reuses a cached preparation only after a complete health response', async () => {
  const { dispatcher } = fixture()
  expect(await dispatcher.prepare()).toMatchObject({ state: 'ready' })
  expect(deploy).not.toHaveBeenCalled()
})

it('reruns deployment probes when cached health omits required fields', async () => {
  const { dispatcher, preparationId } = fixture()
  vi.mocked(request).mockResolvedValueOnce({ status: 200, value: { deploymentId: preparationId } })
  expect(await dispatcher.prepare()).toMatchObject({ state: 'ready' })
  expect(deploy).toHaveBeenCalledOnce()
})
