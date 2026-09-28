import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, expect, it, vi } from 'vitest'
import { GoalId } from '@deepseek-ai/dsh-goal'
import type { GoalRef } from '@deepseek-ai/dsh-goal'
import { submissionHash } from '@deepseek-ai/dsh-experiment-worker'
import type { ExperimentRecord, ExperimentSubmission } from '@deepseek-ai/dsh-experiment-worker'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { apply, ExperimentDispatcher } from '../src/index.ts'
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
  const config: DeploymentConfig = {
    host: 'gpu.example', sshPort: 22, remotePort: 43019, remoteRoot: '/worker',
    localRepo: '/repo', allowedSystemPackages: [], dataRoots: [],
    tokenRef: 'DSH_EXPERIMENT_TOKEN', agentCredentialRefs: [], toolTimeoutMs: 60_000,
  }
  const preparationId = createHash('sha256').update(deploymentId + '\0' + JSON.stringify(config)).digest('hex')
  const prepared: PreparedEnvironment = {
    state: 'ready', deploymentId, preparationId, backend: 'bwrap', backendPath: '/usr/bin/bwrap',
    sandboxWriteProbe: 'passed', cudaProbe: 'passed', devicePaths: ['/dev/nvidia1'],
    hiddenPaths: ['/worker/secrets'], workspaceRoot: '/worker/workspace',
  }
  const preparations = new Map<string, unknown>([[preparationId, { ...prepared, createdAt: 1, target: config }]])
  const submissions = new Map<string, unknown>()
  const table = (name: string) => ({
    get: (key: string) => name === 'preparations' ? preparations.get(key) : submissions.get(key),
    put: async (key: string, value: unknown) => { (name === 'preparations' ? preparations : submissions).set(key, value) },
    delete: async (key: string) => (name === 'preparations' ? preparations : submissions).delete(key),
    entries: () => (name === 'preparations' ? preparations : submissions).entries(),
  })
  const store = { table } as unknown as ConstructorParameters<typeof ExperimentDispatcher>[2]
  const ctx = {
    get: () => undefined,
    credentials: { resolve: async () => ({ value: 'test-receiver-token' }) },
    logger: { warn: vi.fn() },
  } as unknown as Context
  const health = { deploymentId, ready: true, busy: false }
  vi.mocked(snapshotSource).mockResolvedValue({ directory: '/snapshot', archive: '/snapshot/source.tar', digest: deploymentId, archiveHash: 'a'.repeat(64), dispose: vi.fn() })
  vi.mocked(deploy).mockResolvedValue(prepared)
  vi.mocked(request).mockImplementation(async (_target, _token, path, _method, body) => {
    if (path.endsWith('/health')) return { status: 200, value: health }
    return { status: 200, value: receipt(body as ExperimentSubmission) }
  })
  return {
    dispatcher: new ExperimentDispatcher(ctx, config, store), preparationId, preparations, submissions, health, config, store, ctx,
    input: { objective: 'train a small model', datasetRefs: [], constraints: [], requiredGpus: 1 },
  }
}

function goal(id = 'goal-1', revision = 2): GoalRef {
  return { id: GoalId(id), revision }
}

function submissionKey(ref: GoalRef): string {
  return createHash('sha256').update(ref.id + '\0' + String(ref.revision)).digest('hex')
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
  const result = await dispatcher.submit('local-session', goal(), preparationId, input)
  expect(result.state).toBe('complete')
  expect(result.goalId).toBe('goal-1')
  expect(seen).toHaveLength(2)
  expect(seen[0]).toBe(seen[1])
  expect(submissions.size).toBe(1)
  expect(submissions.get(submissionKey(goal()))).toMatchObject({
    handover: '本机派发完成，远端实验已接管', receipt: result, latest: result, goalRevision: 2,
  })
  expect(dispatcher.list()).toMatchObject([{
    handover: '本机派发完成，远端实验已接管', receipt: result, latest: result,
  }])
})

it('completes the original local Goal only after the matching receipt is saved', async () => {
  const { preparationId, submissions, input, config, store } = fixture()
  const agent = { id: 'local-session' }
  const complete = vi.fn(() => {
    expect(submissions.get(submissionKey(goal()))).toMatchObject({
      handover: '本机派发完成，远端实验已接管', receipt: { goalId: 'goal-1' },
    })
  })
  const goals = { get: () => ({ id: 'goal-1', revision: 2, phase: 'active' as const }), complete }
  const withGoals = new ExperimentDispatcher({
    get: (name: string) => name === 'agents' ? { get: () => agent } : name === 'goals' ? goals : undefined,
    credentials: { resolve: async () => ({ value: 'test-receiver-token' }) },
    logger: { warn: vi.fn() },
    agents: { get: () => agent },
    goals,
  } as unknown as Context, config, store)
  await withGoals.submit('local-session', goal(), preparationId, input)
  expect(complete).toHaveBeenCalledWith(agent, { id: 'goal-1', revision: 2 })
  expect(submissions.get(submissionKey(goal()))).toMatchObject({ receipt: { state: 'complete', goalId: 'goal-1' } })
  complete.mockClear()
  goals.get = () => ({ id: 'goal-2', revision: 1, phase: 'active' })
  await withGoals.submit('local-session', goal(), preparationId, input)
  expect(complete).not.toHaveBeenCalled()
})

it('returns the handover notice in the submit tool result recorded by the local Session', async () => {
  const agent = { id: 'local-session' }
  const tools = new Map<string, ToolDefinition>()
  const accepted = receipt({
    submissionId: 'a'.repeat(64), deploymentId: 'd'.repeat(64),
    spec: { objective: 'train', datasetRefs: [], constraints: [], outputPath: 'artifacts/run' },
  })
  const agents = {
    get: () => agent, currentInitiator: () => agent, roots: () => [agent],
  }
  const ctx = {
    agents, goals: { get: () => ({ id: 'goal-1', revision: 2, phase: 'active' }) },
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => {} } },
    systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    storageDomain: { open: async () => ({ close: async () => {} }) },
    provide: () => {}, reflect: { provide: () => {} }, inject: () => {}, effect: () => {},
  } as unknown as Context
  const submit = vi.spyOn(ExperimentDispatcher.prototype, 'submit').mockResolvedValue(accepted)
  try {
    await apply(ctx, {})
    const tool = tools.get('submit_experiment')
    if (tool === undefined) throw new Error('submit tool was not registered')
    const result = await tool.execute({ preparation_id: 'prepared', objective: 'train' }, {
      agent, signal: new AbortController().signal,
    } as ToolRunContext)
    expect(result).toMatchObject({
      submissionId: accepted.submissionId, handover: '本机派发完成，远端实验已接管',
    })
  } finally {
    submit.mockRestore()
  }
})

it('reads status from the target saved on the submission', async () => {
  const { dispatcher, submissions } = fixture()
  const submissionId = 'a'.repeat(64)
  submissions.set('goal-1', {
    submissionId, preparationId: 'd'.repeat(64), specHash: 'h',
    spec: { objective: 'train', outputPath: `artifacts/${submissionId}`, datasetRefs: [], constraints: [] },
    target: {
      host: 'old.example', sshPort: 22, remotePort: 9, remoteRoot: '/old',
      localRepo: '/repo', allowedSystemPackages: [], dataRoots: [],
      tokenRef: 'DSH_EXPERIMENT_TOKEN', agentCredentialRefs: [], toolTimeoutMs: 60_000,
    },
  })
  const hosts: string[] = []
  vi.mocked(request).mockImplementation(async (target) => {
    hosts.push(target.host)
    return { status: 200, value: receipt({
      submissionId, deploymentId: 'd'.repeat(64),
      spec: { objective: 'train', outputPath: `artifacts/${submissionId}`, datasetRefs: [], constraints: [] },
    }) }
  })
  await dispatcher.status(submissionId)
  expect(hosts).toEqual(['old.example'])
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

  await expect(dispatcher.submit('local-session', goal(), preparationId, input, controller.signal)).rejects.toBe(reason)
  expect(seen).toHaveLength(1)
  expect(submissions.size).toBe(1)
  const resumed = await dispatcher.submit('local-session', goal(), preparationId, input)
  expect(resumed.submissionId).toBe(seen[0])
  expect(seen).toHaveLength(2)
  expect(submissions.size).toBe(1)
})

it('does not contact the worker for an already cancelled submission', async () => {
  const { dispatcher, preparationId, submissions, input } = fixture()
  const signal = AbortSignal.abort(new Error('already cancelled'))
  await expect(dispatcher.submit('local-session', goal(), preparationId, input, signal)).rejects.toBe(signal.reason)
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
  await expect(dispatcher.submit('local-session', goal(), preparationId, input)).rejects.toThrow()
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

it('keeps preparation, submission retry, and status on the original server after settings change', async () => {
  const { ctx, config, store, preparationId, input } = fixture()
  let host = config.host
  const dispatcher = new ExperimentDispatcher(ctx, config, store, () => ({ host }))
  expect((await dispatcher.prepare()).preparationId).toBe(preparationId)
  host = 'new.example'
  const receiptRecord = await dispatcher.submit('local-session', goal(), preparationId, input)
  vi.mocked(request).mockResolvedValueOnce({ status: 200, value: receiptRecord })
  await dispatcher.status(receiptRecord.submissionId)
  expect(vi.mocked(request).mock.calls.map(([target]) => target.host)).toEqual([
    'gpu.example', 'gpu.example', 'gpu.example', 'gpu.example',
  ])
  const next = await dispatcher.prepare()
  expect(next.preparationId).not.toBe(preparationId)
  expect(vi.mocked(deploy).mock.calls[0]?.[0].host).toBe('new.example')
})

it('does not complete a Goal edited while the worker accepts its earlier revision', async () => {
  const { ctx, config, store, preparationId, input, submissions } = fixture()
  const agent = { id: 'local-session' }
  let revision = 2
  const complete = vi.fn()
  const goals = { get: () => ({ id: GoalId('goal-1'), revision, phase: 'active' as const }), complete }
  const context = {
    get: (name: string) => name === 'agents' ? { get: () => agent } : name === 'goals' ? goals : undefined,
    agents: { get: () => agent }, goals, credentials: ctx.credentials, logger: ctx.logger,
  } as unknown as Context
  const dispatcher = new ExperimentDispatcher(context, config, store)
  vi.mocked(request).mockImplementation(async (_target, _token, path, _method, body) => {
    if (path.endsWith('/health')) return { status: 200, value: { deploymentId: 'd'.repeat(64), ready: true, busy: false } }
    revision = 3
    return { status: 200, value: receipt(body as ExperimentSubmission) }
  })
  await dispatcher.submit('local-session', goal(), preparationId, input)
  expect(complete).not.toHaveBeenCalled()
  expect(submissions.get(submissionKey(goal()))).toMatchObject({ goalRevision: 2, receipt: { goalId: 'goal-1' } })
  const edited = await dispatcher.submit('local-session', goal('goal-1', 3), preparationId, input)
  expect(edited.submissionId).not.toBe(dispatcher.list().find(entry => entry.goalRevision === 2)?.submissionId)
  expect(submissions.get(submissionKey(goal('goal-1', 3)))).toMatchObject({ goalRevision: 3, receipt: edited })
  expect(complete).toHaveBeenCalledExactlyOnceWith(agent, goal('goal-1', 3))
})

it('leaves a session-keyed legacy record separate from a new Goal', async () => {
  const { dispatcher, preparationId, input, submissions } = fixture()
  submissions.set('local-session', {
    submissionId: 'a'.repeat(64), preparationId, specHash: 'legacy',
    spec: { ...input, outputPath: 'artifacts/legacy' },
  })
  await dispatcher.submit('local-session', goal(), preparationId, input)
  expect(submissions.has('local-session')).toBe(true)
  expect(submissions.has(submissionKey(goal()))).toBe(true)
  expect(submissions.size).toBe(2)
  await expect(dispatcher.status('a'.repeat(64))).rejects.toThrow(/legacy submission/)
})

it('retries a goal-keyed record only for its saved revision', async () => {
  const { dispatcher, preparationId, input, submissions } = fixture()
  const first = await dispatcher.submit('local-session', goal(), preparationId, input)
  const saved = submissions.get(submissionKey(goal()))
  submissions.delete(submissionKey(goal()))
  submissions.set('goal-1', saved)

  const retried = await dispatcher.submit('local-session', goal(), preparationId, input)
  expect(retried.submissionId).toBe(first.submissionId)
  expect(submissions.has(submissionKey(goal()))).toBe(false)

  const edited = await dispatcher.submit('local-session', goal('goal-1', 3), preparationId, input)
  expect(edited.submissionId).not.toBe(first.submissionId)
  expect(submissions.has('goal-1')).toBe(true)
  expect(submissions.has(submissionKey(goal('goal-1', 3)))).toBe(true)
})
