import { spawn } from 'node:child_process'
import { fromAny } from '@total-typescript/shoehorn'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { copy, remote, remoteResult } from '../src/transport.ts'

vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

it.each([7, 255])('preserves remote exit %i separately from SSH connection failures', async exitCode => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  vi.mocked(spawn).mockReturnValue(fromAny<ReturnType<typeof spawn>, typeof child>(child))
  const pending = remoteResult({ host: 'gpu.example', sshPort: 22, remotePort: 43019, toolTimeoutMs: 30000 }, 'failing command')
  const command = String(vi.mocked(spawn).mock.calls[0]?.[1]?.at(-1))
  const marker = /ASPERA_EXIT_[a-f0-9-]+=/.exec(command)?.[0]
  expect(marker).toBeDefined()
  child.stdout.end('partial output')
  child.stderr.end(`command diagnostic\n${marker}${exitCode}\n`)
  child.emit('close', 0, null)
  expect(await pending).toEqual({ stdout: 'partial output', stderr: 'command diagnostic', exitCode, signal: null,
    timedOut: false, cancelled: false, exitConfirmed: true })
})

it('reports SSH authentication errors separately from command exits', async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() })
  vi.mocked(spawn).mockReturnValue(fromAny<ReturnType<typeof spawn>, typeof child>(child))
  const pending = remoteResult({ host: 'gpu.example', sshPort: 22, remotePort: 43019, toolTimeoutMs: 30000 }, 'command')
  const settled = expect(pending).rejects.toMatchObject({ name: 'SshConnectionError', message: expect.stringContaining('Permission denied') })
  child.stderr.end('Permission denied (publickey)')
  child.emit('close', 255, null)
  await settled
  child.stdout.destroy()
})

it.each([
  ['ssh', 3_600_000], ['scp', 3_600_000], ['ssh', 60_000], ['scp', 60_000],
] as const)('bounds %s by the configured %i ms setup timeout', async (program, toolTimeoutMs) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => { child.emit('close', null) }); return true }),
  })
  vi.mocked(spawn).mockReturnValue(fromAny<ReturnType<typeof spawn>, typeof child>(child))
  const target = { host: 'gpu.example', sshPort: 22, remotePort: 43019, toolTimeoutMs }
  const pending = program === 'ssh'
    ? remote(target, 'pnpm install --frozen-lockfile && pnpm run build')
    : copy(target, 'source.tar', '/worker/incoming/source.tar')
  const settled = Promise.allSettled([pending])
  try {
    await vi.advanceTimersByTimeAsync(toolTimeoutMs - 1)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(child.kill).toHaveBeenCalledOnce()
    expect((await settled)[0]?.status).toBe('rejected')
  } finally {
    child.emit('close', 0)
    await settled
    child.stdout.destroy()
    child.stderr.destroy()
    vi.useRealTimers()
  }
})
