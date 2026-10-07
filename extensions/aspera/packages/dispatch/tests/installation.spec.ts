/** Recovery budgets survive reconnects; candidate sources never bypass identity or exit checks. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { fromAny } from '@total-typescript/shoehorn'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { placement } from '../../experiments/tests/fixtures.ts'
import { InstallationRecovery } from '../src/installation.ts'
import type { InstallationDriver } from '../src/installation.ts'
import { installationPolicySchema, preparationRecordSchema } from '../src/installation-model.ts'
import type { InstallationStatus, PreparationRecord } from '../src/installation-model.ts'
import type { DeploymentConfig } from '../src/deploy.ts'

const owners: { close: () => Promise<void> }[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.close()))
  for (const directory of directories.splice(0)) rmSync(directory, { force: true, recursive: true })
})

async function fixture(outcomes: ('failed' | 'completed' | 'unconfirmed' | 'running')[] = ['failed', 'completed'], warning?: string) {
  const root = resolve('.artifacts'); mkdirSync(root, { recursive: true })
  const home = mkdtempSync(resolve(root, 'installation-')); directories.push(home)
  const id = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const records = new Map<string, PreparationRecord>()
  const ctx = fromAny<Context, object>({ storage: { domain: { open: async () => ({ table: () => ({
    get: (id: string) => records.get(id), entries: () => records.entries(),
    put: async (id: string, value: object) => { records.set(id, preparationRecordSchema.parse(value)) }, delete: async (id: string) => { records.delete(id) },
  }), close: async () => {} }) } } })
  const files = new Map<string, string>(), statuses = new Map<string, InstallationStatus>()
  const launched: string[] = []
  let failConnection = false
  const driver: InstallationDriver = {
    copy: vi.fn(async () => ''), installPrivateFile: vi.fn(async (_target, path, content) => { files.set(path, content) }),
    verifyServerStorage: vi.fn(async () => placement(serverId, id, '/fixture').candidate),
    remote: vi.fn(async (_target, command, signal, password) => {
      signal?.throwIfAborted()
      expect(password).toBe('private-password')
      const path = [...files.keys()].find(path => path.endsWith('/config.json') && command.includes(path))
      if (!path) return ''
      const config = JSON.parse(files.get(path)!)
      if (command.includes(' launch ')) {
        launched.push(config.attemptId)
        const state = outcomes.shift() ?? 'failed'
        statuses.set(config.attemptId, { version: 1, attemptId: config.attemptId, experimentId: id, serverId,
          digest: config.digest, archiveHash: config.archiveHash, state, phase: 'installing-dependencies',
          startedAt: Date.now(), deadline: config.deadline, updatedAt: Date.now(), lastProgressAt: Date.now(),
          progress: { bytes: 1024, packages: 4, cpuTicks: 0, ioBytes: 0 }, pid: 1234, startTicks: '123', bootId: 'test-boot',
          exitCode: state === 'running' ? null : state === 'completed' ? 0 : 1, exitConfirmed: state !== 'unconfirmed' && state !== 'running', reason: state === 'failed' ? 'download stalled' : undefined })
        return JSON.stringify(statuses.get(config.attemptId))
      }
      if (command.includes(' probe ')) return JSON.stringify({ version: '0.2.0-rc.2', available: !command.includes('missing.example'), bytes: 65536, elapsedMs: 50, detail: 'server download probe' })
      if (failConnection) throw new Error('SSH unreachable')
      const status = statuses.get(config.attemptId)!
      if (command.includes(' stop ')) return JSON.stringify(status)
      const offset = Number(/--offset (\d+)/.exec(command)?.[1] ?? 0)
      return JSON.stringify({ status, lines: offset === 0 || warning ? [{ seq: 0, time: 1234, stream: 'stderr', text: warning ?? 'password=private-password download stalled\n' }] : [], offset: 128, hasMore: false })
    }),
  }
  const policy = installationPolicySchema.parse({ installationTotalTimeoutMs: 60000, installationIdleTimeoutMs: 10000, installationMaxRetries: 2 })
  const open = async () => { const manager = await InstallationRecovery.open(ctx, policy, driver, home); owners.push(manager); return manager }
  const manager = await open()
  await manager.pin(id, [serverId, serverId]); await manager.startBudget(id, serverId)
  const archive = resolve(home, 'original.tar'); writeFileSync(archive, 'immutable')
  const digest = 'a'.repeat(64), archiveHash = createHash('sha256').update('immutable').digest('hex')
  await manager.retain(id, { archive, directory: home, archiveHash, digest, dispose: () => {} }, { node: '^22.19.0 || >=24.0.0', pnpm: '11.7.0' })
  const target: DeploymentConfig = { host: 'node.example', sshPort: 22, remotePort: 43019, remoteRoot: '/control',
    toolTimeoutMs: 1000, controlPollIntervalMs: 1, localRepo: '/original', dataRoots: [], agentCredentialRefs: [], tokenRef: 'private',
    storagePlacement: { ...placement(serverId, id, '/fixture'), releaseRoot: '/releases/' + digest } }
  const signal = new AbortController().signal
  return { manager, open, ctx, id, serverId, target, signal, home, records, statuses, driver, launched,
    run: (owner = manager) => owner.ensure(id, serverId, target, 'private-password', signal),
    tools: manager.tools(id, serverId, target, 'private-password'),
    offline: () => { failConnection = true },
    finishCurrent: () => { const status = statuses.get(launched.at(-1)!)!; status.state = 'completed'; status.exitConfirmed = true; status.exitCode = 0 },
  }
}

it('validates finite limits and their ordering', () => {
  expect(installationPolicySchema.parse({})).toEqual({ installationTotalTimeoutMs: 1800000, installationIdleTimeoutMs: 300000, installationMaxRetries: 2 })
  for (const value of [Infinity, NaN, 0, -1]) expect(() => installationPolicySchema.parse({ installationTotalTimeoutMs: value })).toThrow()
  expect(() => installationPolicySchema.parse({ installationTotalTimeoutMs: 100, installationIdleTimeoutMs: 101 })).toThrow('must not exceed')
  expect(() => installationPolicySchema.parse({ installationMaxRetries: 1.5 })).toThrow()
})

it('reuses pinned materials, budget and cache across an Agent repair and application restart', async () => {
  const f = await fixture()
  const first = f.run()
  expect(f.run()).toBe(first)
  await expect(first).rejects.toThrow('download stalled')
  const original = f.manager.progress([f.id])[0]!
  const restarted = await f.open()
  await restarted.startBudget(f.id, f.serverId)
  await f.run(restarted); await restarted.verified(f.id, f.serverId)
  const progress = restarted.progress([f.id])[0]!
  expect(progress.round.deadline).toBe(original.round.deadline)
  expect(progress.round.attempts).toHaveLength(2)
  expect(progress.round.state).toBe('verified')
  expect(f.launched).toHaveLength(2)
  const configs = vi.mocked(f.driver.installPrivateFile).mock.calls.filter(call => call[1].endsWith('/config.json')).map(call => JSON.parse(call[2]))
  expect(configs[0].stage).toBe(configs[1].stage)
  expect(configs[0].cache).toBe(configs[1].cache)
  expect(configs[0].deadline).toBe(configs[1].deadline)
  const output = readFileSync(resolve(f.home, 'aspera-observations', f.id, 'observations-v1', `installation-${original.round.attempts[0]!.id}.jsonl`), 'utf8')
  expect(output).not.toContain('private-password')
  expect(JSON.parse(output.trim()).time).toBe(1234)
})

it('lets the Agent probe and apply a source once without resetting limits or passing credentials', async () => {
  const f = await fixture()
  await expect(f.run()).rejects.toThrow()
  const before = f.manager.progress([f.id])[0]!.round
  const probe = await f.tools.probe('npm', 'https://mirror.example/npm/', f.signal)
  const parsed = JSON.parse(JSON.stringify(probe))
  await f.tools.switchSource(parsed.id, 'Original registry download made no progress', f.signal)
  await f.tools.switchSource(parsed.id, 'duplicate', f.signal)
  const after = f.manager.progress([f.id])[0]!.round
  expect(after.attempts).toHaveLength(2)
  expect(after.deadline).toBe(before.deadline)
  expect(after.changes).toHaveLength(1)
  expect(after.changes[0]).toMatchObject({ previous: before.sources, next: { npm: 'https://mirror.example/npm/' }, applied: true })
  const config = vi.mocked(f.driver.installPrivateFile).mock.calls.filter(call => call[1].endsWith('/config.json')).at(-1)![2]
  expect(config).not.toContain('private-password')
  expect(config).not.toContain('tokenRef')
  await expect(f.tools.probe('npm', 'http://mirror.example/', f.signal)).rejects.toThrow('HTTPS')
  await expect(f.tools.probe('npm', 'https://user:password@mirror.example/', f.signal)).rejects.toThrow('HTTPS')
})

it('rejects unavailable candidates and exhausts exactly two additional attempts', async () => {
  const f = await fixture(['failed', 'failed', 'failed', 'completed'])
  await expect(f.run()).rejects.toThrow()
  const missing = JSON.parse(JSON.stringify(await f.tools.probe('npm', 'https://missing.example/', f.signal)))
  await expect(f.tools.switchSource(missing.id, 'unavailable', f.signal)).rejects.toThrow('pass a probe')
  await expect(f.run()).rejects.toThrow()
  await expect(f.run()).rejects.toThrow()
  await expect(f.run()).rejects.toThrow('retry budget exhausted')
  expect(f.launched).toHaveLength(3)
})

it('blocks duplicate installation when remote exit is unknown and retains offline ownership', async () => {
  const f = await fixture(['unconfirmed', 'completed'])
  await expect(f.run()).rejects.toThrow()
  await expect(f.run()).rejects.toThrow('exit remains unconfirmed')
  expect(f.manager.pending(f.id)).toEqual([f.serverId])
  f.offline()
  await expect(f.manager.stop(f.id, f.serverId, f.target, 'private-password', f.signal)).rejects.toThrow('unreachable')
  const restarted = await f.open()
  expect(restarted.pending(f.id)).toEqual([f.serverId])
  expect(f.launched).toHaveLength(1)
  await restarted.forget(f.id)
  expect(restarted.has(f.id)).toBe(true)
})

it('starts an explicit new budget while retaining previous attempts, then removes settled private material', async () => {
  const f = await fixture()
  await expect(f.run()).rejects.toThrow()
  await f.manager.failed(f.id, 'original failed attempt')
  const before = f.manager.progress([f.id])[0]!.round
  await f.manager.startBudget(f.id, f.serverId, true)
  await f.run(); await f.manager.verified(f.id, f.serverId)
  const after = f.manager.progress([f.id])[0]!
  expect(after.history).toEqual([before])
  expect(after.round.id).not.toBe(before.id)
  expect(after.round.attempts).toHaveLength(1)
  const material = f.manager.material(f.id)!.archive
  const recovered = resolve(f.home, 'aspera-preparation', 'recover', f.id)
  mkdirSync(recovered, { recursive: true })
  writeFileSync(resolve(recovered, 'partial.tar'), 'original archive fragment')
  await f.manager.forget(f.id)
  expect(f.manager.has(f.id)).toBe(false)
  expect(() => readFileSync(material)).toThrow()
  expect(() => readFileSync(resolve(recovered, 'partial.tar'))).toThrow()
})

it('retains an exhausted total budget and rejects replacement of the original material', async () => {
  const f = await fixture()
  const record = f.records.get(f.id)!
  record.nodes[0]!.rounds[0]!.deadline = Date.now() - 1
  await expect(f.run()).rejects.toThrow('total budget exhausted')
  expect(f.launched).toHaveLength(0)
  const material = f.manager.material(f.id)!
  writeFileSync(material.archive, 'changed')
  await expect(f.manager.recover(f.id, material.digest, { ...f.target, pathEntries: [...(f.target.pathEntries ?? [])], dataRoots: [], preparationOutputChars: 1024, agentCredentialRefs: [] }, 'private-password', f.signal)).rejects.toThrow('missing or has changed')
})

it.each([
  { event: { level: 'warn', name: 'pnpm:global', message: 'Tarball download average speed 2 KiB/s is below 50 KiB/s; password=private-password' }, code: 'download-slow' },
  { event: { level: 'debug', name: 'pnpm:request-retry', error: { code: 'ETIMEDOUT' }, url: 'https://registry.example/' }, code: 'download-retry' },
])('returns one live $code to the Agent and continues the same installer after restart', async ({ event, code }) => {
  const f = await fixture(['running'], JSON.stringify(event))
  await expect(f.run()).rejects.toThrow('remains running')
  const before = f.manager.progress([f.id])[0]!.round
  expect(before.state).toBe('diagnosing')
  expect(before.attempts[0]!.notices).toMatchObject([{ code, delivered: true, time: 1234 }])
  expect(before.detail).not.toContain('private-password')
  await f.tools.inspect(f.signal)
  expect(f.manager.progress([f.id])[0]!.round.attempts[0]!.notices).toHaveLength(1)
  const restarted = await f.open()
  f.finishCurrent()
  await f.run(restarted); await restarted.verified(f.id, f.serverId)
  const after = restarted.progress([f.id])[0]!.round
  expect(after.deadline).toBe(before.deadline)
  expect(after.attempts[0]!.notices).toEqual(before.attempts[0]!.notices)
  expect(after.state).toBe('verified')
  expect(f.launched).toHaveLength(1)
})

it('keeps reading ordinary package progress without returning a diagnostic to the model', async () => {
  const f = await fixture(['running'], JSON.stringify({ level: 'debug', name: 'pnpm:progress', message: 'download progress' }))
  const task = f.run()
  await vi.waitFor(() => { expect(f.manager.progress([f.id])[0]!.round.attempts[0]?.status?.state).toBe('running') })
  f.finishCurrent()
  await task
  expect(f.manager.progress([f.id])[0]!.round.attempts[0]!.notices).toEqual([])
  expect(f.launched).toHaveLength(1)
})
