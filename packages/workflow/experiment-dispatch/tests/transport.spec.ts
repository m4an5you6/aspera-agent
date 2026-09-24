import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { copy, remote } from '../src/transport.ts'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

it.each([
  ['ssh', 3_600_000], ['scp', 3_600_000], ['ssh', 60_000], ['scp', 60_000],
] as const)('bounds %s by the configured %i ms setup timeout', async (program, toolTimeoutMs) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => { child.emit('close', null) }); return true }),
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
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
