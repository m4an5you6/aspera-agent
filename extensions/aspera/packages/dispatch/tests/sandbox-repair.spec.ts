/** Repair tools retain ambiguous SSH outcomes and admit only complete launcher evidence. */
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { SandboxRepair, sandboxRepairPolicySchema } from '../src/sandbox-repair.ts'
import { RemoteCommandError } from '../src/transport.ts'
import type { RemoteCommandResult } from '../src/transport.ts'
import type { EnvironmentDriver } from '../src/environment-preparation.ts'
import { readyEnvironment } from './environment-fixture.ts'

function fixture() {
  const serverId = serverIdSchema.parse(randomUUID())
  const experimentId = experimentIdSchema.parse(randomUUID())
  const diagnostic = { version: 1, strategy: 'private-proc', state: 'available', reason: 'Measured full private-proc launch',
    stdout: 'zero capabilities', stderr: '', exitCode: 0, requiresPlatformAction: false }
  const result: RemoteCommandResult = { stdout: JSON.stringify(diagnostic), stderr: '', exitCode: 0,
    signal: null, timedOut: false, cancelled: false, exitConfirmed: true }
  const remoteResult = vi.fn<EnvironmentDriver['remoteResult']>(async () => result)
  const tools = new SandboxRepair({ serverId, experimentId, password: 'private-account-secret',
    policy: sandboxRepairPolicySchema.parse({}) }, { remoteResult })
  const target = { host: 'node', sshPort: 22, remotePort: 43019, toolTimeoutMs: 30000 }
  const signal = new AbortController().signal
  return { tools, remoteResult, result, diagnostic, target, signal, serverId, experimentId, observation: readyEnvironment() }
}

it('resolves all repair locations and preserves shared isolation without putting credentials into the script', async () => {
  const f = fixture()
  expect(await f.tools.inspect(f.target, f.observation, f.signal)).toMatchObject({ state: 'available', requiresPlatformAction: false })
  const call = vi.mocked(f.remoteResult).mock.calls[0]
  expect(call).toBeDefined()
  const serialized = JSON.stringify(call)
  expect(serialized).toContain(f.serverId)
  expect(serialized).toContain(f.experimentId)
  expect(serialized).toContain('--unshare-user')
  expect(serialized).toContain('--cap-drop')
  expect(serialized).toContain('sandbox-repair-receipt')
  // The SSH credential is a private transport argument, never part of the remote program or model result.
  const script = call?.[1]
  expect(script).not.toContain('private-account-secret')
})

it('keeps missing user-space tools distinct from a measured platform restriction', async () => {
  const f = fixture()
  f.observation.programs = f.observation.programs.map(program => program.name === 'python3' ? { ...program, path: '' } : program)
  expect(await f.tools.inspect(f.target, f.observation, f.signal)).toMatchObject({ state: 'unavailable', requiresPlatformAction: false })
  expect(f.remoteResult).not.toHaveBeenCalled()
})

it('runs installation through the preparation-owned foreground executor', async () => {
  const f = fixture()
  const command = vi.fn(async () => f.result)
  await f.tools.repair(f.target, f.observation, command, f.signal)
  expect(command).toHaveBeenCalledOnce()
  expect(f.remoteResult).not.toHaveBeenCalled()
})

it.each([{ timedOut: true }, { cancelled: true }, { exitConfirmed: false }])('preserves unconfirmed transport evidence %j', async value => {
  const f = fixture()
  Object.assign(f.result, value)
  await expect(f.tools.inspect(f.target, f.observation, f.signal)).rejects.toBeInstanceOf(RemoteCommandError)
})

it.each([
  { stdout: 'download failed', exitCode: 1 },
  { stdout: '{"version":1,"state":"configured"}', exitCode: 0 },
  { exitCode: 7 },
])('refuses incomplete or contradictory repair receipts %j', async value => {
  const f = fixture()
  Object.assign(f.result, value)
  expect(await f.tools.inspect(f.target, f.observation, f.signal)).toMatchObject({ state: 'unknown', requiresPlatformAction: false })
})

it('requires cancellation before dispatching an installation', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort()
  const command = vi.fn(async () => f.result)
  await expect(f.tools.repair(f.target, f.observation, command, controller.signal)).rejects.toThrow()
  expect(command).not.toHaveBeenCalled()
})

it.runIf(process.platform === 'linux')('checks Linux ownership, idempotence, corruption refusal and supervised cleanup', () => {
  expect(() => execFileSync('python3', [fileURLToPath(new URL('./sandbox_repair_test.py', import.meta.url))], { timeout: 30000 })).not.toThrow()
})
