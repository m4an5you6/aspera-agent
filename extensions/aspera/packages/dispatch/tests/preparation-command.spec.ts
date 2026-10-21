/** Preparation recovery follows one remote identity and imports complete, deduplicated logs. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, observationSourceIdSchema, serverIdSchema } from '@aspera/experiments'
import { readObservation } from '@aspera/runtime'
import type { ObservationSource } from '@aspera/experiments'
import { preparationCommandPolicySchema, recoverPreparationCommand } from '../src/preparation-command.ts'
import type { PreparationCommandDriver } from '../src/preparation-command.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), 'aspera-preparation-recovery-')); roots.push(root)
  const source: ObservationSource = { version: 1, id: observationSourceIdSchema.parse('preparation-' + randomUUID()),
    experimentId: experimentIdSchema.parse(randomUUID()), serverId: serverIdSchema.parse(randomUUID()),
    commandId: randomUUID(), sessionId: 'fixture-session', toolCallId: 'fixture-tool-call', kind: 'preparation', phase: 'preparation',
    streams: ['stdout', 'stderr'], createdAt: 1, complete: false, label: 'Preparation fixture' }
  const page = { status: { version: 1, experimentId: source.experimentId, serverId: source.serverId, commandId: source.commandId,
    sessionId: source.sessionId, toolCallId: source.toolCallId, exitCode: 2, exitConfirmed: true, timedOut: false, cancelled: false, signal: null },
  lines: [{ seq: 0, time: 10, stream: 'stderr', text: 'download failed password=private-secret\n' }], offset: 100, hasMore: false }
  const driver: PreparationCommandDriver = { remote: vi.fn(async () => JSON.stringify(page)), remoteResult: vi.fn() }
  const policy = preparationCommandPolicySchema.parse({ pollIntervalMs: 1, recoveryTimeoutMs: 10 })
  const signal = new AbortController().signal
  const recover = (stop = false) => recoverPreparationCommand(driver, { host: 'fixture', sshPort: 22, remotePort: 43019, toolTimeoutMs: 1000 },
    '/owned/preparation/' + source.commandId, root, source, policy, 'private-secret', signal, stop)
  return { root, source, page, driver, recover }
}

it('reconnects only to read the original command and preserves its failure and redacted logs', async () => {
  const f = fixture()
  vi.mocked(f.driver.remote).mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(JSON.stringify(f.page))
  expect(await f.recover()).toMatchObject({ exitCode: 2, exitConfirmed: true, supervised: true })
  expect(f.driver.remoteResult).not.toHaveBeenCalled()
  expect(f.driver.remote).toHaveBeenCalledTimes(2)
  const logs = readObservation(f.root, { experimentId: f.source.experimentId, serverId: f.source.serverId, sourceId: f.source.id, stream: 'stderr', limit: 65536 })
  expect(JSON.stringify(logs)).not.toContain('private-secret')
  expect(JSON.stringify(logs)).toContain('download failed')
})

it('does not duplicate recovered lines after a local restart or repeat status read', async () => {
  const f = fixture()
  await f.recover(); await f.recover()
  const logs = readObservation(f.root, { experimentId: f.source.experimentId, serverId: f.source.serverId, sourceId: f.source.id, stream: 'stderr', limit: 65536 })
  expect(logs.lines).toHaveLength(1)
})

it('makes output readable locally while the original command is still running', async () => {
  const f = fixture(), reading = Promise.withResolvers<void>(), finish = Promise.withResolvers<string>()
  vi.mocked(f.driver.remote).mockResolvedValueOnce(JSON.stringify({ ...f.page,
    status: { ...f.page.status, exitCode: null, exitConfirmed: false } })).mockImplementationOnce(async () => { reading.resolve(); return finish.promise })
  let settled = false
  const running = f.recover().finally(() => { settled = true })
  try {
    await reading.promise
    const logs = readObservation(f.root, { experimentId: f.source.experimentId, serverId: f.source.serverId, sourceId: f.source.id, stream: 'stderr', limit: 65536 })
    expect(logs.lines).toHaveLength(1)
    expect(settled).toBe(false)
    expect(f.driver.remoteResult).not.toHaveBeenCalled()
  } finally { finish.resolve(JSON.stringify({ ...f.page, lines: [], offset: 100 })) }
  expect(await running).toMatchObject({ exitCode: 2, exitConfirmed: true })
})

it.each(['experimentId', 'serverId', 'commandId', 'sessionId', 'toolCallId'] as const)('refuses another %s before importing output', async key => {
  const f = fixture()
  vi.mocked(f.driver.remote).mockResolvedValue(JSON.stringify({ ...f.page, status: { ...f.page.status, [key]: randomUUID() } }))
  await expect(f.recover()).rejects.toThrow('another invocation')
})

it('requests stop against the original operation and waits for real exit confirmation', async () => {
  const f = fixture()
  vi.mocked(f.driver.remote).mockResolvedValueOnce(JSON.stringify({ ...f.page, lines: [], offset: 0,
    status: { ...f.page.status, exitCode: null, exitConfirmed: false, cancelled: true } })).mockResolvedValueOnce(JSON.stringify(f.page))
  await f.recover(true)
  expect(vi.mocked(f.driver.remote).mock.calls[0]?.[1]).toContain(' stop ')
  expect(vi.mocked(f.driver.remote).mock.calls[1]?.[1]).toContain(' read ')
  expect(f.driver.remoteResult).not.toHaveBeenCalled()
})

it('keeps an unconfirmed supervisor outcome fenced', async () => {
  const f = fixture()
  vi.mocked(f.driver.remote).mockResolvedValue(JSON.stringify({ ...f.page, status: { ...f.page.status,
    exitConfirmed: false, finishedAt: 100, reason: 'process identity changed' } }))
  await expect(f.recover()).rejects.toThrow('exit remains unconfirmed')
})
