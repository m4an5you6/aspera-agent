/** Offline observations and cleanup preserve ownership, errors and quiescent deletion. */
import { fromAny } from '@total-typescript/shoehorn'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema, environmentOperationIdSchema } from '@aspera/experiments'
import { managedEnvironmentPolicySchema, managedEnvironmentProgram } from '@aspera/runtime'
import { ExperimentEnvironments } from '../src/managed-environments.ts'
import type { EnvironmentStorageOwner } from '../src/managed-environments.ts'
import type { FleetExperiment } from '../src/types.ts'

const base = resolve('.artifacts'); mkdirSync(base, { recursive: true })
const fixtures: { service: ExperimentEnvironments; root: string }[] = []
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.service.close()
    if (dirname(f.root) !== base) throw new Error('Fixture deletion escaped its owned directory')
    rmSync(f.root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(resolve(base, 'managed-environments-'))
  const id = experimentIdSchema.parse(randomUUID()); const serverId = serverIdSchema.parse(randomUUID())
  const server = { id: serverId, name: 'fixture', host: 'localhost', username: 'test', remoteRoot: '/control', remotePort: 31002,
    storagePlacement: { experimentId: id, serverId, namespaceRoot: '/data/.aspera/' + serverId,
      runRoot: '/data/.aspera/' + serverId + '/runs/' + id, workspaceRoot: '/data/.aspera/' + serverId + '/runs/' + id + '/workspace', controlRoot: '/control' } }
  const record = fromAny<FleetExperiment, object>({ request: { experimentId: id }, servers: [server], coordinator: server,
    submission: { protocol: 4, experimentId: id, deploymentId: 'a'.repeat(64), nodes: [{ server, backendPath: '/usr/bin/bwrap', devicePaths: [], hiddenPaths: [] }] } })
  const usage = { serverId, name: 'fixture', checkedAt: 123, source: 'remote', availableBytes: 20, capacityBytes: 100,
    workspaceBytes: 10, sharedBytes: 15, reclaimableBytes: 3, environments: [], legacy: [], complete: true }
  let alive = true
  const owner: EnvironmentStorageOwner = { get: () => record, alive: () => alive, secrets: async () => ['ssh-private'], program: managedEnvironmentProgram,
    node: vi.fn(async (_record, _server, operation) => {
      if (operation === 'environment-preview') return { serverId, checkedAt: 123, fingerprint: 'b'.repeat(64), candidates: [{ id: 'c'.repeat(64), kind: 'package', bytes: 3, reason: 'Unused' }], eligible: true }
      if (operation === 'environment-cleanup') return { serverId, checkedAt: 124, state: 'completed', reclaimedBytes: 3 }
      return usage
    }), ssh: vi.fn(async () => JSON.stringify(usage)) }
  const service = new ExperimentEnvironments(root, owner, managedEnvironmentPolicySchema.parse({ storageIntervalMs: 1000 }))
  fixtures.push({ service, root }); return { service, root, id, serverId, record, usage, owner, remove: () => { alive = false } }
}

it('coalesces page refreshes and reuses unchanged checked time within the measurement interval', async () => {
  const f = fixture(); const first = f.service.usage(f.id); const repeated = f.service.usage(f.id)
  expect(repeated).toBe(first); const result = await first
  expect(result.nodes[0]?.checkedAt).toBe(123)
  expect(await f.service.usage(f.id)).toEqual(result)
  expect(f.owner.node).toHaveBeenCalledTimes(1)
})

it('performs an explicitly requested inventory after a concurrent saved-state read and coalesces matching scans', async () => {
  const f = fixture()
  let release: () => void = () => { throw new Error('Observation gate was not installed') }
  const gate = new Promise<void>(done => { release = done })
  let refreshed = false
  const catalog = { version: 1, serverId: f.serverId, checkedAt: 124, complete: true, entriesScanned: 0, roots: [], volumes: [], historicalEnvironments: [], diagnostics: [] }
  vi.mocked(f.owner.node).mockImplementation(async (_record, _server, operation) => {
    if (operation === 'storage-inspect') { refreshed = true; return catalog }
    if (!refreshed) await gate
    return { ...f.usage, ...(refreshed ? { catalog } : {}) }
  })
  const reading = f.service.usage(f.id), first = f.service.refresh(f.id, f.serverId), second = f.service.refresh(f.id, f.serverId)
  release(); await reading
  expect((await first).nodes[0]?.catalog?.checkedAt).toBe(124)
  expect(await second).toEqual(await first)
  expect(vi.mocked(f.owner.node).mock.calls.filter(call => call[2] === 'storage-inspect')).toHaveLength(1)
})

it('uses read-only SSH when the fixed controller is unavailable and retains that connection error', async () => {
  const f = fixture(); vi.mocked(f.owner.node).mockRejectedValue(new Error('offline ssh-private'))
  const result = await f.service.usage(f.id)
  expect(result.nodes[0]).toMatchObject({ source: 'ssh', checkedAt: 123, error: 'Error: offline [redacted]' })
  const command = vi.mocked(f.owner.ssh).mock.calls[0]?.[2]
  expect(command).toContain('python3 -c'); expect(command).not.toContain('ssh-private')
  expect(readFileSync(resolve(f.root, f.id, 'storage.v1.json'), 'utf8')).not.toContain('ssh-private')
})

it('restores a locally saved observation on restart without presenting it as a new remote check', async () => {
  const f = fixture(); await f.service.usage(f.id); await f.service.close()
  vi.mocked(f.owner.node).mockRejectedValue(new Error('controller unavailable')); vi.mocked(f.owner.ssh).mockRejectedValue(new Error('SSH unavailable'))
  const restarted = new ExperimentEnvironments(f.root, f.owner, managedEnvironmentPolicySchema.parse({}))
  fixtures.push({ service: restarted, root: mkdtempSync(resolve(base, 'environment-empty-')) })
  const result = await restarted.usage(f.id)
  expect(result.nodes[0]).toMatchObject({ source: 'local', checkedAt: 123, workspaceBytes: 10, complete: false })
  expect(result.nodes[0]?.error).toContain('SSH unavailable')
})

it('rejects another node or experiment in a remote observation', async () => {
  const f = fixture(); vi.mocked(f.owner.node).mockResolvedValue({ ...f.usage, serverId: serverIdSchema.parse(randomUUID()) })
  const result = await f.service.usage(f.id)
  expect(result.nodes[0]).toMatchObject({ complete: false, checkedAt: 0 })
  expect(result.nodes[0]?.error).toContain('another experiment')
})

it('rejects cleanup or recovery diagnostics from another experiment without storing them', async () => {
  for (const kind of ['cleanups', 'recoveries']) {
    const f = fixture()
    const record = kind === 'cleanups' ? { version: 1, experimentId: randomUUID(), serverId: f.serverId, operationId: randomUUID(), environmentId: 'training', generation: randomUUID(),
      state: 'pending', paths: ['/owned/tmp'], packages: [], createdAt: 1, updatedAt: 2 } : { version: 1, experimentId: randomUUID(), serverId: f.serverId, operationId: randomUUID(), environmentId: 'training',
      sourceReceiptHash: 'a'.repeat(64), state: 'prepare-required', createdAt: 1, updatedAt: 2, detail: 'Wrong experiment' }
    vi.mocked(f.owner.node).mockResolvedValue({ ...f.usage, [kind]: [record] })
    const value = await f.service.usage(f.id)
    expect(value.nodes[0]?.error).toContain('another experiment')
    expect(value.nodes[0]?.[kind === 'cleanups' ? 'cleanups' : 'recoveries']).toBeUndefined()
  }
})

it('prevents a delayed response and committed write from restoring a removed experiment', async () => {
  const f = fixture(); let release: (value: unknown) => void = () => { throw new Error('Read barrier has not been installed') }
  vi.mocked(f.owner.node).mockImplementation(() => new Promise(resolveRead => { release = resolveRead }))
  const pending = f.service.usage(f.id); await Promise.resolve(); await Promise.resolve()
  f.remove(); const removed = f.service.remove(f.id); release(f.usage)
  await expect(pending).rejects.toThrow(); await removed
  expect(existsSync(resolve(f.root, f.id))).toBe(false)
})

it('cleanup rejects unassigned and duplicate nodes before sending any mutation', async () => {
  const f = fixture(); const operationId = environmentOperationIdSchema.parse(randomUUID())
  await expect(f.service.cleanup({ experimentId: f.id, operationId, nodes: [{ serverId: serverIdSchema.parse(randomUUID()), fingerprint: 'b'.repeat(64) }] })).rejects.toThrow('unassigned')
  await expect(f.service.cleanup({ experimentId: f.id, operationId, nodes: [{ serverId: f.serverId, fingerprint: 'b'.repeat(64) }, { serverId: f.serverId, fingerprint: 'b'.repeat(64) }] })).rejects.toThrow('duplicate')
  expect(f.owner.node).not.toHaveBeenCalled()
})

it('repeated cleanup requests share their operation and blocked nodes retain the training record', async () => {
  const f = fixture(); const preview = await f.service.preview(f.id)
  vi.mocked(f.owner.node).mockResolvedValue({ serverId: f.serverId, checkedAt: 125, state: 'blocked', reclaimedBytes: 0, detail: 'An active inference service still uses this environment' })
  const request = { experimentId: f.id, operationId: environmentOperationIdSchema.parse(randomUUID()), nodes: preview.nodes.map(node => ({ serverId: node.serverId, fingerprint: node.fingerprint })) }
  const first = f.service.cleanup(request); expect(f.service.cleanup(request)).toBe(first)
  const result = await first; expect(result.nodes[0]?.state).toBe('blocked'); expect(f.record).not.toHaveProperty('latest')
})

it('restart verifies the original cleanup result without submitting a new deletion', async () => {
  const f = fixture(); const preview = await f.service.preview(f.id)
  const request = { experimentId: f.id, operationId: environmentOperationIdSchema.parse(randomUUID()), nodes: preview.nodes.map(node => ({ serverId: node.serverId, fingerprint: node.fingerprint })) }
  vi.mocked(f.owner.node).mockRejectedValueOnce(new Error('Connection reset after cleanup admission'))
  const interrupted = await f.service.cleanup(request); expect(interrupted.nodes[0]?.state).toBe('blocked')
  await f.service.close()
  vi.mocked(f.owner.node).mockResolvedValue({ state: 'settled', result: { serverId: f.serverId, state: 'completed', reclaimedBytes: 3, checkedAt: 125 } })
  const restarted = new ExperimentEnvironments(f.root, f.owner, managedEnvironmentPolicySchema.parse({}))
  fixtures.push({ service: restarted, root: mkdtempSync(resolve(base, 'environment-empty-')) })
  await restarted.resume(f.id)
  const calls = vi.mocked(f.owner.node).mock.calls
  expect(calls.at(-1)?.[2]).toBe('environment-cleanup-status')
  expect(calls.filter(call => call[2] === 'environment-cleanup')).toHaveLength(1)
  expect(await restarted.readyToDelete(f.id)).toBe(true)
})

it('an unresolved cleanup blocks remote deletion while preserving all local records', async () => {
  const f = fixture(); const preview = await f.service.preview(f.id)
  const request = { experimentId: f.id, operationId: environmentOperationIdSchema.parse(randomUUID()), nodes: preview.nodes.map(node => ({ serverId: node.serverId, fingerprint: node.fingerprint })) }
  vi.mocked(f.owner.node).mockRejectedValue(new Error('SSH unavailable'))
  await f.service.cleanup(request)
  expect(await f.service.readyToDelete(f.id)).toBe(false)
  expect(existsSync(resolve(f.root, f.id, request.operationId + '.cleanup.v1.json'))).toBe(true)
})
