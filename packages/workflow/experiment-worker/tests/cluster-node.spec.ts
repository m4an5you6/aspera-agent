/** Node ownership tests use isolated files and explicitly settled managed-process doubles. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { createClusterNode } from '../src/cluster-node.ts'
import { clusterNodeSchema, experimentIdSchema } from '../src/cluster-protocol.ts'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const absolute = mkdtempSync(resolve('.artifacts', 'cluster-node-'))
  const root = process.platform === 'win32' ? absolute.slice(2).replaceAll('\\', '/') : absolute
  const tables = new Map<string, Map<string, unknown>>()
  const disposers: (() => Promise<void>)[] = []
  const handles: { stdout: PassThrough; stderr: PassThrough; settle: () => void; terminate: ReturnType<typeof vi.fn> }[] = []
  const spawn = vi.fn(() => {
    const done = Promise.withResolvers<{ exitCode: number; signal: null }>()
    const stdout = new PassThrough(); const stderr = new PassThrough()
    const terminate = vi.fn(() => {})
    handles.push({ stdout, stderr, terminate, settle: () => { stdout.end(); stderr.end(); done.resolve({ exitCode: 0, signal: null }) } })
    return { stdout, stderr, done: done.promise, terminate, waitForExit: async () => true }
  })
  const confine = vi.fn(async (argv: string[], _options: unknown) => ({ argv }))
  const ctx = { storageDomain: { open: async () => ({ table: (name: string) => {
    let table = tables.get(name); if (table === undefined) { table = new Map(); tables.set(name, table) }
    return { get: (key: string) => table.get(key), entries: () => table.entries(), put: async (key: string,
      value: unknown) => { table.set(key, value) } }
  }, close: async () => {} }) }, subprocess: { spawn }, sandbox: { confine },
  effect: (setup: () => () => Promise<void>) => { disposers.push(setup()) }, logger: { error: vi.fn() },
  } as unknown as Context
  const config = { root, bootId: 'boot-1', chunkBytes: 1024, fileLimit: 10, cleanupTimeoutMs: 1000, devicePaths: ['/dev/nvidia0'] }
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
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), node: f.node })
  const command = { experimentId: id, commandId: 'training', command: 'python train.py' }
  await f.handler('run', command); await f.handler('run', command)
  expect(f.spawn).toHaveBeenCalledOnce()
  await expect(f.handler('run', { ...command, command: 'different' })).rejects.toThrow('different content')
  const stopping = f.handler('release', { experimentId: id })
  await vi.waitFor(() => { expect(f.handles[0]!.terminate).toHaveBeenCalledOnce() })
  await expect(f.handler('run', { ...command, commandId: 'late' })).rejects.toThrow('unavailable')
  await expect(f.handler('allocate', { experimentId: another, deploymentId: 'a'.repeat(64),
    node: f.node })).rejects.toThrow('another experiment')
  f.handles[0]!.settle()
  expect(await stopping).toEqual({ released: true })
  expect(await f.handler('allocate', { experimentId: another, deploymentId: 'a'.repeat(64), node: f.node })).toEqual({ allocated: true })
  expect(f.confine.mock.calls[0]![1]).toMatchObject({ mode: 'workspace-write', devicePaths: ['/dev/nvidia0'],
    hiddenPaths: [resolve(f.config.root, 'runs'), resolve(f.config.root, 'secrets'), resolve(f.config.root, 'state')] })
})
it('holds ambiguous allocations after node restart and never launches a retry', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  const allocation = { experimentId: id, deploymentId: 'a'.repeat(64), node: f.node }
  await f.handler('allocate', allocation)
  const restarted = await createClusterNode(f.ctx, { ...f.config, bootId: 'boot-2' })
  await expect(restarted('allocate', allocation)).rejects.toThrow('interrupted')
  expect(await restarted('release', { experimentId: id })).toMatchObject({ released: false })
  expect(f.spawn).not.toHaveBeenCalled()
})
it('refuses excess GPU grants and verifies staged input content before execution', async () => {
  const f = await fixture(); const id = experimentIdSchema.parse(randomUUID())
  await expect(f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), node: { ...f.node,
    devicePaths: ['/dev/nvidia1'] } })).rejects.toThrow('granted GPU')
  await f.handler('allocate', { experimentId: id, deploymentId: 'a'.repeat(64), node: f.node })
  const input = { experimentId: id, path: 'inputs/data.txt', offset: 0, data: Buffer.from('abc').toString('base64') }
  expect(await f.handler('input', input)).toEqual({ nextOffset: 3 })
  expect(await f.handler('input', input)).toEqual({ nextOffset: 3 })
  await expect(f.handler('input', { ...input, data: Buffer.from('xyz').toString('base64') })).rejects.toThrow('different bytes')
  await expect(f.handler('verify-input', { experimentId: id, name: 'data.txt', sha256: 'b'.repeat(64) })).rejects.toThrow('digest mismatch')
})
