import { fromAny } from '@total-typescript/shoehorn'
const budget = { maxRuntimeSeconds: 3600, maxServiceSeconds: 3600, maxCommands: 100, maxGoalRounds: 100 }
const deadline = Date.now() + 3600000
/** Node ownership tests use isolated files and explicitly settled managed-process doubles. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { createServer } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { createClusterNode } from '../src/cluster-node.ts'
import { clusterNodeSchema, experimentIdSchema } from '@aspera/experiments'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function loopbackPort(hold = false): Promise<number> {
  const listener = createServer()
  await new Promise<void>((ready, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', ready) })
  const address = listener.address()
  if (address === null || typeof address === 'string') throw new Error('test port was not assigned')
  const close = () => new Promise<void>((done) => { listener.close(() => { done() }) })
  if (hold) cleanup.push(close)
  else await close()
  return address.port
}
async function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const absolute = mkdtempSync(resolve('.artifacts', 'cluster-node-'))
  const root = process.platform === 'win32' ? absolute.slice(2).replaceAll('\\', '/') : absolute
  const tables = new Map<string, Map<string, unknown>>()
  const disposers: (() => Promise<void>)[] = []
  const handles: { stdout: PassThrough; stderr: PassThrough; settle: () => void; terminate: ReturnType<typeof vi.fn>; waitForExit: ReturnType<typeof vi.fn<() => Promise<boolean>>> }[] = []
  const spawn = vi.fn((_spec: import('@deepseek-ai/dsh-subprocess').SubprocessSpawnSpec) => {
    const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
    const stdout = new PassThrough(); const stderr = new PassThrough()
    const terminate = vi.fn(() => {})
    const waitForExit = vi.fn(async () => true)
    handles.push({ stdout, stderr, terminate, waitForExit, settle: () => { stdout.end(); stderr.end(); done.resolve({ exitCode: 0, signal: null }) } })
    return { stdout, stderr, done: done.promise, terminate, waitForExit }
  })
  const confine = vi.fn(async (argv: string[], _options: unknown) => ({ argv }))
  const ctx = fromAny<Context, object>({ storage: { domain: { open: async () => ({ table: (name: string) => {
    let table = tables.get(name); if (table === undefined) { table = new Map(); tables.set(name, table) }
    return { get: (key: string) => table.get(key), entries: () => table.entries(), put: async (key: string,
      value: unknown) => { table.set(key, value) } }
  }, close: async () => {} }) } }, subprocess: { spawn }, sandbox: { confine },
  effect: (setup: () => () => Promise<void>) => { disposers.push(setup()) }, logger: { error: vi.fn(), debug: vi.fn() },
  })
  const config = { root, backendPath: '/usr/bin/bwrap', hiddenPaths: [], bootId: 'boot-1', chunkBytes: 1024, fileLimit: 10, cleanupTimeoutMs: 1000, devicePaths: ['/dev/nvidia0'] }
  const handler = await createClusterNode(ctx, config)
  const node = clusterNodeSchema.parse({ server: { id: randomUUID(), name: 'node', username: 'trainer', host: 'gpu', sshPort: 22,
    remotePort: 43019, remoteRoot: root, authMode: 'password' }, devicePaths: ['/dev/nvidia0'],
  backendPath: '/usr/bin/bwrap', hiddenPaths: [], gpuInfo: 'GPU 0' })
  cleanup.push(async () => {
    for (const handle of handles) handle.settle()
    for (const dispose of disposers.reverse()) await dispose()
    rmSync(absolute, { recursive: true, force: true })
  })
  return { handler, node, handles, confine, spawn, ctx, config }
}
it('deduplicates commands and keeps the node allocated until cancellation settles the managed range', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID()); const another = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  const command = { experimentId: id, commandId: 'training', command: 'python train.py' }
  await f.handler('run', command); await f.handler('run', command)
  expect(f.spawn).toHaveBeenCalledOnce()
  await expect(f.handler('run', { ...command, command: 'different' })).rejects.toThrow('different content')
  const stopping = f.handler('release', { experimentId: id })
  await vi.waitFor(() => { expect(f.handles[0]!.terminate).toHaveBeenCalledOnce() })
  await expect(f.handler('run', { ...command, commandId: 'late' })).rejects.toThrow('unavailable')
  await expect(f.handler('allocate', { experimentId: another, deploymentId: 'a'.repeat(64), budget, deadline,
    node: f.node })).rejects.toThrow('another experiment')
  f.handles[0]!.settle()
  expect(await stopping).toEqual({ released: true })
  expect(await f.handler('allocate', { experimentId: another, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })).toEqual({ allocated: true })
  expect(f.spawn.mock.calls[0]![0]).toMatchObject({ argv: expect.arrayContaining([f.node.backendPath, '--clearenv', '--dev-bind', '/dev/nvidia0', resolve(f.config.root, 'secrets')]) })

})

it('runs beyond the released command limit without creating aggregate timers in v2', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), node: f.node, protocol: 2 })
  for (let index = 0; index < 105; index++) {
    await f.handler('run', { experimentId: id, commandId: `command-${index}`, command: 'python small_step.py' })
    f.handles.at(-1)!.settle()
  }
  expect(f.spawn).toHaveBeenCalledTimes(105)
  expect(f.handles.every(handle => handle.terminate.mock.calls.length === 0)).toBe(true)
  expect(f.spawn.mock.calls.every(([spec]) => spec.argv[0] === '/usr/bin/bwrap' && spec.argv.includes('--dev-bind'))).toBe(true)
})

it('refuses an allocation that omits the policy discriminator as well as the legacy limits', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await expect(f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), node: f.node })).rejects.toThrow('policy is incomplete')
  await expect(f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), node: f.node, protocol: 2, budget, deadline })).rejects.toThrow('policy is incomplete')
  expect(f.spawn).not.toHaveBeenCalled()
})
it('holds ambiguous allocations after node restart and never launches a retry', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const allocation = { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node }
  await f.handler('allocate', allocation)
  await f.handler('run', { experimentId: id, commandId: 'training', command: 'python train.py' })
  const restarted = await createClusterNode(f.ctx, { ...f.config, bootId: 'boot-2' })
  await expect(restarted('allocate', allocation)).rejects.toThrow('interrupted')
  expect(await restarted('release', { experimentId: id })).toMatchObject({ released: false })
  expect(f.spawn).toHaveBeenCalledOnce()
})
it('releases a restarted allocation only when every recorded process was already confirmed drained', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  await f.handler('run', { experimentId: id, commandId: 'smoke', command: 'python smoke.py' })
  f.handles[0]!.settle()
  await vi.waitFor(async () => { expect(await f.handler('status', { experimentId: id })).toMatchObject([{ released: true }]) })
  const restarted = await createClusterNode(f.ctx, { ...f.config, bootId: 'boot-2' })
  expect(await restarted('release', { experimentId: id })).toEqual({ released: true })
  expect(f.spawn).toHaveBeenCalledOnce()
})
it('refuses excess GPU grants and verifies staged input content before execution', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await expect(f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: { ...f.node,
    devicePaths: ['/dev/nvidia1'] } })).rejects.toThrow('granted GPU')
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  const input = { experimentId: id, path: 'inputs/data.txt', offset: 0, data: Buffer.from('abc').toString('base64') }
  expect(await f.handler('input', input)).toEqual({ nextOffset: 3 })
  expect(await f.handler('input', input)).toEqual({ nextOffset: 3 })
  await expect(f.handler('input', { ...input, data: Buffer.from('xyz').toString('base64') })).rejects.toThrow('different bytes')
  await expect(f.handler('verify-input', { experimentId: id, name: 'data.txt', sha256: 'b'.repeat(64) })).rejects.toThrow('digest mismatch')
})

it('retains a process handle after incomplete cleanup and confirms it on a later cancellation', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  await f.handler('run', { experimentId: id, commandId: 'smoke', command: 'python smoke.py' })
  f.handles[0]!.waitForExit.mockResolvedValue(false)
  f.handles[0]!.settle()
  await vi.waitFor(async () => { expect(await f.handler('status', { experimentId: id })).toMatchObject([{ state: 'failed', released: false }]) })
  expect(await f.handler('release', { experimentId: id })).toEqual({ released: false })
  f.handles[0]!.waitForExit.mockResolvedValue(true)
  expect(await f.handler('release', { experimentId: id })).toEqual({ released: true })
  expect(f.handles[0]!.terminate).toHaveBeenCalledTimes(2)
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('deduplicates service launches and ignores an old health reply after confirmed stop', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  const request = { experimentId: id, id: randomUUID(), command: 'python serve.py', modelPath: 'model', port: await loopbackPort(), healthPath: '/health' }
  await Promise.all([f.handler('register-service', request), f.handler('register-service', request)])
  expect(f.spawn).toHaveBeenCalledOnce()
  const reply = Promise.withResolvers<Response>()
  const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(reply.promise)
  try {
    const checking = f.handler('services', { experimentId: id })
    await vi.waitFor(() => { expect(fetchMock).toHaveBeenCalledOnce() })
    const stopping = f.handler('stop-service', { experimentId: id, serviceId: request.id })
    await vi.waitFor(() => { expect(f.handles[0]!.terminate).toHaveBeenCalledOnce() })
    f.handles[0]!.settle()
    expect(await stopping).toMatchObject({ state: 'stopped', released: true })
    reply.resolve(new Response('healthy'))
    expect(await checking).toMatchObject([{ state: 'stopped', released: true }])
    await f.handler('register-service', request)
    expect(f.spawn).toHaveBeenCalledOnce()
    await expect(f.handler('register-service', { ...request, command: 'different' })).rejects.toThrow('different content')
  } finally { reply.resolve(new Response()); fetchMock.mockRestore() }
})

it('holds an unverified service after node restart and never restarts its command', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  const request = { experimentId: id, id: randomUUID(), command: 'python serve.py', modelPath: 'model', port: await loopbackPort(), healthPath: '/health' }
  await f.handler('register-service', request)
  const restarted = await createClusterNode(f.ctx, { ...f.config, bootId: 'boot-2' })
  expect(await restarted('services', { experimentId: id })).toMatchObject([{ state: 'interrupted', released: false }])
  expect(await restarted('release', { experimentId: id })).toEqual(expect.objectContaining({ released: false }))
  expect(f.spawn).toHaveBeenCalledOnce()
})

it('refuses an occupied loopback port before launching or accepting another process health', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline, node: f.node })
  await expect(f.handler('register-service', { experimentId: id, id: randomUUID(), command: 'python serve.py', modelPath: 'model',
    port: await loopbackPort(true), healthPath: '/health' })).rejects.toThrow('already occupied')
  expect(f.spawn).not.toHaveBeenCalled()
})

it('rejects backend changes, exhausted command budgets and expired runtime grants before launching', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await expect(f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget, deadline,
    node: { ...f.node, backendPath: '/tmp/allow-everything' } })).rejects.toThrow('node policy')
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), budget: { ...budget, maxCommands: 1 }, deadline, node: f.node })
  await f.handler('run', { experimentId: id, commandId: 'first', command: 'python smoke.py' })
  await expect(f.handler('run', { experimentId: id, commandId: 'second', command: 'python train.py' })).rejects.toThrow('budget exhausted')
  f.handles[0]!.settle()
  await vi.waitFor(async () => { expect(await f.handler('release', { experimentId: id })).toEqual({ released: true }) })
  const expired = experimentIdSchema.parse(randomUUID())
  await f.handler('allocate', { experimentId: expired, deploymentId: 'a'.repeat(64), budget, deadline: Date.now() - 1, node: f.node })
  await expect(f.handler('run', { experimentId: expired, commandId: 'late', command: 'python train.py' })).rejects.toThrow('budget expired')
  expect(f.spawn).toHaveBeenCalledOnce()
})
