/** Deployment admission uses the namespaces required by managed experiment commands. */
import { afterEach, expect, it, vi } from 'vitest'
import { validateEnvironment } from '../src/deploy.ts'
import type { DeploymentConfig } from '../src/deploy.ts'
import { remote, RemoteCommandError } from '../src/transport.ts'

vi.mock('../src/transport.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/transport.ts')>(), remote: vi.fn() }))
afterEach(() => { vi.resetAllMocks() })
const target: DeploymentConfig = { host: 'node', sshPort: 22, remotePort: 43019, toolTimeoutMs: 1000,
  remoteRoot: '/controls/node', localRepo: '/source', dataRoots: [], agentCredentialRefs: [], tokenRef: 'private-reference', controlPollIntervalMs: 100 }
const discovery = { backendPath: '/usr/bin/bwrap', devicePaths: ['/dev/nvidia3', '/dev/nvidiactl'],
  hiddenPaths: ['/controls/node/secrets', '/controls/node/state', '/root/.ssh'], namespaceRoots: [] }
const passed = 'DSH_DEVICES=/dev/nvidia3,/dev/nvidiactl\nDSH_BWRAP=/usr/bin/bwrap\n'
  + 'DSH_HIDDEN=["/controls/node/secrets","/controls/node/state","/root/.ssh"]\n'
  + 'DSH_GPU_BEGIN\nGPU-11111111-1111-1111-1111-111111111111, CPU fixture GPU, 3\nDSH_GPU_END\n'

it('checks workspace, credential and CUDA access through the same complete launch', async () => {
  vi.mocked(remote).mockResolvedValueOnce(JSON.stringify(discovery)).mockResolvedValueOnce(passed)
  await expect(validateEnvironment(target, 'a'.repeat(64))).resolves.toMatchObject({ sandboxWriteProbe: 'passed', cudaProbe: 'passed' })
  const script = vi.mocked(remote).mock.calls[1]![1]
  const probes = script.split('\n').filter(line => line.startsWith("'/usr/bin/bwrap'"))
  expect(probes).toHaveLength(6)
  for (const probe of probes) {
    for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--clearenv', '--dev-bind', '--chdir']) expect(probe).toContain(flag)
    expect(probe).toContain("'--tmpfs' '/controls/node'")
    expect(probe).toContain("'--bind' '/controls/node/workspace' '/controls/node/workspace'")
  }
  expect(script).toContain('"$sandbox_probe" probe-sandbox')
  expect(script).toContain('"$gpu_probe"')
})

it('returns the actual proc mount refusal instead of passing a weaker deployment probe', async () => {
  vi.mocked(remote).mockImplementation(async (_target, command) => {
    if (command.includes('json.dumps')) return JSON.stringify(discovery)
    if (!command.includes('--unshare-user')) return passed
    throw new RemoteCommandError({ exitCode: 1, exitConfirmed: true, signal: null, timedOut: false, cancelled: false,
      stdout: '', stderr: "ASPERA_VERIFY_STAGE=sandbox-launch\nbwrap: Can't mount proc on /newroot/proc: Operation not permitted\n" })
  })
  await expect(validateEnvironment(target, 'a'.repeat(64))).rejects.toMatchObject({
    diagnostic: { stage: 'sandbox-launch', exitCode: 1, stderr: expect.stringContaining("Can't mount proc"),
      requiresPlatformAction: true } })
})

it.each(['workspace-isolation', 'credential-isolation', 'gpu-access'])('retains the independent %s failure', async stage => {
  const error = new RemoteCommandError({ exitCode: 1, exitConfirmed: true, signal: null, timedOut: false, cancelled: false,
    stdout: 'Probe output', stderr: `ASPERA_VERIFY_STAGE=sandbox-launch\nASPERA_VERIFY_STAGE=${stage}\nProbe refused\n` })
  vi.mocked(remote).mockResolvedValueOnce(JSON.stringify(discovery)).mockRejectedValueOnce(error)
  await expect(validateEnvironment(target, 'a'.repeat(64))).rejects.toMatchObject({ diagnostic: {
    stage, stdout: 'Probe output', stderr: error.result.stderr, requiresPlatformAction: false } })
})

it('leaves interrupted checks unconfirmed instead of classifying them as platform refusals', async () => {
  const error = new RemoteCommandError({ exitCode: null, exitConfirmed: false, signal: null, timedOut: true, cancelled: false,
    stdout: '', stderr: 'Connection interrupted' })
  vi.mocked(remote).mockResolvedValueOnce(JSON.stringify(discovery)).mockRejectedValueOnce(error)
  await expect(validateEnvironment(target, 'a'.repeat(64))).rejects.toBe(error)
})
