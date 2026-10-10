/** External tool versions and actual sandbox failures determine environment readiness. */
import { afterEach, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { checkEnvironment, inspectEnvironment, installedEnvironmentRequirements } from '../src/environment.ts'
import { remote, remoteResult, RemoteCommandError } from '../src/transport.ts'
import { verifySavedRelease, SavedReleaseUnavailable } from '../src/cluster-deploy.ts'
import { readyEnvironment } from './environment-fixture.ts'

vi.mock('../src/transport.ts', async importOriginal => ({ ...await importOriginal<typeof import('../src/transport.ts')>(), remoteResult: vi.fn(), remote: vi.fn() }))
afterEach(() => { vi.resetAllMocks() })
const requirements = { node: '^22.19.0 || >=24.0.0', pnpm: '11.7.0' }
const target = { host: 'node', sshPort: 22, remotePort: 43019, toolTimeoutMs: 1000 }
const digest = 'a'.repeat(64)

it.each([['v22.18.0', false], ['v22.19.0', true], ['v23.0.0', false], ['v24.1.0', true]])('checks release support for Node %s', (version, ready) => {
  const observation = readyEnvironment()
  observation.programs[0]!.version = version
  expect(checkEnvironment(observation, requirements).ready).toBe(ready)
})

it('checks the pinned package manager and actual bubblewrap probe, not binary presence alone', () => {
  const observation = readyEnvironment()
  observation.programs[1]!.version = '10.0.0'
  observation.sandboxExitCode = 1; observation.diagnostics = 'Creating new namespace failed: Operation not permitted'
  const result = checkEnvironment(observation, requirements)
  expect(result).toMatchObject({ ready: false })
  if (result.ready) throw new Error('fixture unexpectedly passed')
  expect(result.failures.join('\n')).toContain('pnpm must be 11.7.0')
  expect(result.failures.join('\n')).toContain('Operation not permitted')
})

it('returns shell observations even when none of the required tools exists', async () => {
  vi.mocked(remoteResult).mockResolvedValue({ exitCode: 0, signal: null, timedOut: false, cancelled: false, exitConfirmed: true,
    stdout: 'ASPERA_HOME=/home/trainer\nASPERA_SYSTEM=Linux\nASPERA_ARCH=x86_64\nASPERA_ID=uid=1000\nASPERA_SANDBOX=127\n', stderr: '' })
  const observed = await inspectEnvironment({ host: 'node', sshPort: 22, remotePort: 43019, toolTimeoutMs: 1000 })
  expect(observed.programs.every(program => program.path === '')).toBe(true)
  expect(checkEnvironment(observed, requirements).ready).toBe(false)
})

it('detects a proc mount denial with execution namespaces before admitting the toolchain', async () => {
  vi.mocked(remoteResult).mockImplementation(async (_target, command) => {
    const denied = command.includes('--unshare-user')
    return { exitCode: 0, signal: null, timedOut: false, cancelled: false, exitConfirmed: true,
      stdout: 'ASPERA_HOME=/root\nASPERA_SYSTEM=Linux\nASPERA_ARCH=x86_64\nASPERA_ID=uid=0\n'
        + 'ASPERA_PATH_node=/usr/bin/node\nASPERA_VERSION_node=v24.1.0\n'
        + 'ASPERA_PATH_pnpm=/usr/bin/pnpm\nASPERA_VERSION_pnpm=11.7.0\n'
        + 'ASPERA_PATH_python3=/usr/bin/python3\nASPERA_VERSION_python3=Python 3.12.0\n'
        + 'ASPERA_PATH_bwrap=/usr/bin/bwrap\nASPERA_VERSION_bwrap=bubblewrap 0.6.1\n'
        + `ASPERA_SANDBOX=${denied ? 1 : 0}\n`,
      stderr: denied ? "bwrap: Can't mount proc on /newroot/proc: Operation not permitted\n" : '' }
  })
  const observed = await inspectEnvironment(target)
  expect(observed.sandboxExitCode).toBe(1)
  const checked = checkEnvironment(observed, requirements)
  expect(checked).toMatchObject({ ready: false })
  if (checked.ready) throw new Error('Unsupported execution namespaces were admitted')
  expect(checked.failures.join('\n')).toContain("Can't mount proc")
})

it('pins discovered executable directories for subsequent non-interactive connections', () => {
  const observation = readyEnvironment()
  observation.programs[0]!.path = '/opt/aspera/node/bin/node'
  const result = checkEnvironment(observation, requirements, ['/opt/aspera/pnpm'])
  if (!result.ready) throw new Error('fixture did not pass')
  expect(result.toolchain.pathEntries).toEqual(['/opt/aspera/pnpm', '/opt/aspera/node/bin', '/usr/bin'])
})

it('reads an old release and its original engine requirement before Node is available', async () => {
  vi.mocked(remote).mockResolvedValueOnce(JSON.stringify({ version: 1, deploymentId: digest, dsh: '0.2.0-rc.2', extension: '0.1.1' }))
    .mockResolvedValueOnce(JSON.stringify({ packageManager: 'pnpm@10.20.0', dependencies: { '@deepseek-ai/dsh': '0.2.0-rc.2' } }))
    .mockResolvedValueOnce(JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.0-rc.2', engines: { node: '>=22.19.0' } }))
  expect(await installedEnvironmentRequirements(target, '/original/release', digest)).toEqual({ node: '>=22.19.0', pnpm: '10.20.0' })
  expect(vi.mocked(remote).mock.calls.every(([, command]) => !command.includes('node --'))).toBe(true)
})

it('retries the published protocol-4 release whose application and DSH manifests both omit engines', async () => {
  const publishedDsh = readFileSync(new URL('../../../node_modules/@deepseek-ai/dsh/package.json', import.meta.url), 'utf8')
  expect(JSON.parse(publishedDsh)).not.toHaveProperty('engines')
  vi.mocked(remote).mockResolvedValueOnce(JSON.stringify({ version: 1, deploymentId: digest, dsh: '0.2.0-rc.2', extension: '0.1.1' }))
    .mockResolvedValueOnce(JSON.stringify({ name: 'aspera-installed-release', packageManager: 'pnpm@11.7.0',
      dependencies: { '@deepseek-ai/dsh': '0.2.0-rc.2' } }))
    .mockResolvedValueOnce(publishedDsh)
  expect(await installedEnvironmentRequirements(target, '/original/release', digest)).toEqual(requirements)
  expect(vi.mocked(remote).mock.calls.every(([, command]) => !command.includes('node --'))).toBe(true)
})

it('uses the saved application engines without consulting the local or installed DSH requirement', async () => {
  vi.mocked(remote).mockResolvedValueOnce(JSON.stringify({ version: 1, deploymentId: digest, dsh: '0.2.0-rc.2', extension: '0.1.1' }))
    .mockResolvedValueOnce(JSON.stringify({ packageManager: 'pnpm@10.20.0', engines: { node: '>=26.0.0' },
      dependencies: { '@deepseek-ai/dsh': '0.2.0-rc.2' } }))
  expect(await installedEnvironmentRequirements(target, '/original/release', digest)).toEqual({ node: '>=26.0.0', pnpm: '10.20.0' })
  expect(remote).toHaveBeenCalledTimes(2)
})

it.each(['unknown release', 'changed installed version', 'changed dependency', 'invalid engines'])('rejects %s instead of guessing a requirement', async failure => {
  const dsh = failure === 'unknown release' ? '0.9.0' : '0.2.0-rc.2'
  vi.mocked(remote).mockResolvedValueOnce(JSON.stringify({ version: 1, deploymentId: digest, dsh, extension: '0.1.1' }))
    .mockResolvedValueOnce(JSON.stringify({ packageManager: 'pnpm@11.7.0',
      dependencies: { '@deepseek-ai/dsh': failure === 'changed dependency' ? '0.9.0' : dsh },
      ...(failure === 'invalid engines' ? { engines: { node: 'unknown' } } : {}) }))
    .mockResolvedValueOnce(JSON.stringify({ name: '@deepseek-ai/dsh', version: failure === 'changed installed version' ? '0.9.0' : dsh }))
  await expect(installedEnvironmentRequirements(target, '/original/release', digest)).rejects.toBeInstanceOf(SavedReleaseUnavailable)
})

it.each(['changed identity', 'missing fields', 'invalid JSON'])('rejects saved release %s without installing a replacement', async failure => {
  vi.mocked(remote).mockResolvedValue(failure === 'invalid JSON' ? '{' : JSON.stringify(failure === 'missing fields'
    ? { deploymentId: digest } : { version: 1, deploymentId: 'b'.repeat(64), dsh: '0.2.0-rc.2', extension: '0.1.1' }))
  await expect(verifySavedRelease(target, '/original/release', digest)).rejects.toBeInstanceOf(SavedReleaseUnavailable)
  expect(remote).toHaveBeenCalledOnce()
})

it('distinguishes missing release entries from interrupted SSH verification', async () => {
  const result = { stdout: '', stderr: 'Saved release entry is missing: .ready', exitCode: 1, signal: null, timedOut: false, cancelled: false, exitConfirmed: true }
  vi.mocked(remote).mockRejectedValueOnce(new RemoteCommandError(result))
  await expect(verifySavedRelease(target, '/original/release', digest)).rejects.toThrow('copy this experiment')
  const interrupted = new RemoteCommandError({ ...result, exitCode: null, stderr: 'connection lost', exitConfirmed: false })
  vi.mocked(remote).mockRejectedValueOnce(interrupted)
  await expect(verifySavedRelease(target, '/original/release', digest)).rejects.toBe(interrupted)
})
