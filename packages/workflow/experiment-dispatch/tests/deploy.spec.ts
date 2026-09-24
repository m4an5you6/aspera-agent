import { beforeEach, expect, it, vi } from 'vitest'
import { deploy } from '../src/deploy.ts'
import type { DeploymentConfig } from '../src/deploy.ts'
import { copy, remote, request } from '../src/transport.ts'

vi.mock('../src/transport.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/transport.ts')>(),
  copy: vi.fn(), remote: vi.fn(), request: vi.fn(),
}))

beforeEach(() => { vi.resetAllMocks() })

function fixture(previous: string) {
  const deploymentId = 'd'.repeat(64)
  const config: DeploymentConfig = {
    host: 'gpu.example', sshPort: 22, remotePort: 43019, remoteRoot: '/worker',
    localRepo: '/repo', dataRoots: [], allowedSystemPackages: [], agentCredentialRefs: [],
    tokenRef: 'DSH_EXPERIMENT_TOKEN', toolTimeoutMs: 3_600_000,
  }
  const snapshot = { directory: '/snapshot', archive: '/snapshot/source.tar', digest: deploymentId, archiveHash: 'a'.repeat(64), dispose() {} }
  const launches: string[] = []
  vi.mocked(copy).mockResolvedValue('')
  vi.mocked(remote).mockImplementation(async (_target, script) => {
    if (script.includes('DSH_DEVICES=')) return 'DSH_DEVICES=/dev/nvidia1\nDSH_BWRAP=/usr/bin/bwrap\nDSH_HIDDEN=/worker/secrets,/worker/state\n'
    if (script.startsWith('if [ -f ')) return previous
    if (script.includes('setsid node')) launches.push(script)
    return ''
  })
  const responses: unknown[] = []
  vi.mocked(request).mockImplementation(async (_target, _token, path) => {
    if (path.endsWith('/shutdown')) return { status: 200, value: { stopping: true } }
    if (responses.length === 0) throw new Error('unexpected health request')
    return { status: 200, value: responses.shift() }
  })
  return {
    deploymentId, launches, responses,
    prepare: () => deploy(config, snapshot, 'test-receiver-token', {}),
    stopped: () => vi.mocked(request).mock.calls.filter(call => call[2].endsWith('/shutdown')),
  }
}

it.each([
  ['missing busy state', { ready: true }],
  ['unready worker', { ready: false, busy: false }],
  ['occupied worker', { ready: true, busy: true }],
])('leaves the previous worker running when health reports %s', async (_name, fields) => {
  const previous = 'b'.repeat(64)
  const test = fixture(previous)
  test.responses.push({ deploymentId: previous, ...fields })
  await expect(test.prepare()).rejects.toThrow('previous worker is busy or unhealthy')
  expect(test.stopped()).toHaveLength(0)
  expect(test.launches).toHaveLength(0)
})

it('does not activate a new worker with incomplete health', async () => {
  const test = fixture('')
  test.responses.push({ deploymentId: test.deploymentId })
  await expect(test.prepare()).rejects.toThrow('new worker did not return valid health')
  expect(test.launches).toHaveLength(1)
})

it('validates readiness before returning a prepared release', async () => {
  const test = fixture('')
  test.responses.push({ deploymentId: test.deploymentId, ready: true, busy: false })
  await expect(test.prepare()).resolves.toMatchObject({ state: 'ready', deploymentId: test.deploymentId })
  expect(test.launches).toHaveLength(1)
})

it.each([true, false])('checks restored worker health after activation fails (valid response: %s)', async (valid) => {
  const previous = 'b'.repeat(64)
  const test = fixture(previous)
  test.responses.push(
    { deploymentId: previous, ready: true, busy: false },
    { deploymentId: test.deploymentId },
    valid ? { deploymentId: previous, ready: true, busy: false } : { deploymentId: previous },
  )
  if (valid) {
    await expect(test.prepare()).rejects.toThrow('new worker did not return valid health')
  } else {
    await expect(test.prepare()).rejects.toThrow(AggregateError)
  }
  expect(test.stopped()).toHaveLength(1)
  expect(test.launches).toHaveLength(2)
  expect(test.launches[0]).toContain(test.deploymentId)
  expect(test.launches[1]).toContain(previous)
  expect(test.responses).toHaveLength(0)
})
