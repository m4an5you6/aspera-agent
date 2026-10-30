/** Command groups submit participants before waiting and retain unresolved launch identities. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { fromAny } from '@total-typescript/shoehorn'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { installExecutionCommands } from '../src/execution-commands.ts'
import { clusterNodeRequest, ClusterNodeOperationError } from '../src/cluster-runtime.ts'
import { CommandAdmissionRejected } from '../src/command-admission.ts'
import type { ClusterPrivate, ClusterRuntimeConfig } from '../src/cluster-runtime.ts'

vi.mock('../src/cluster-runtime.ts', async original => ({ ...await original<typeof import('../src/cluster-runtime.ts')>(), clusterNodeRequest: vi.fn() }))
const roots: string[] = []
afterEach(() => { vi.mocked(clusterNodeRequest).mockReset(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true }); const root = mkdtempSync(resolve('.artifacts', 'groups-')); roots.push(root)
  const id = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID()), tools = new Map<string, ToolDefinition>()
  const ctx = fromAny<Context, object>({ effect: (install: () => void) => install(), tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => {} } } })
  const runtime = fromAny<ClusterPrivate, object>({ submission: { experimentId: id, coordinator: { remoteRoot: root }, nodes: [{ server: { id: serverId } }] } })
  installExecutionCommands(ctx, runtime, fromAny<ClusterRuntimeConfig, object>({ finalization: { pollIntervalMs: 10, readTimeoutMs: 10, reconnectTimeoutMs: 10 } }))
  const group = { operationId: randomUUID(), commands: ['one', 'two'].map(commandId => ({ serverId, commandId, command: 'true' })) }
  const execution = fromAny<ToolRunContext, object>({ signal: new AbortController().signal })
  const call = () => tools.get('run_experiment_command_group')!.execute({ json: JSON.stringify(group) }, execution)
  const observations: string[] = []
  vi.mocked(clusterNodeRequest).mockImplementation(async (_runtime, _server, operation, raw) => {
    const input = raw as { commandId: string }
    observations.push(operation + ':' + input.commandId)
    if (operation === 'run') return { state: 'running' }
    return { experimentId: id, serverId, requestHash: createHash('sha256').update('true').digest('hex'), result: { commandId: input.commandId, state: 'completed', exitCode: 0, released: true }, checkedAt: 1 }
  })
  return { id, serverId, group, call, observations, execution, tools, root }
}
it('starts all rendezvous members before the first status read and rejects altered duplicate requests', async () => {
  const f = fixture(); await f.call()
  expect(f.observations.slice(0, 2)).toEqual(['run:one', 'run:two'])
  f.group.commands[0]!.command = 'different'
  await expect(f.call()).rejects.toThrow('different contents')
})
it('rejects an unauthorized group node before starting any member', async () => {
  const f = fixture(); f.group.commands[1]!.serverId = serverIdSchema.parse(randomUUID())
  await expect(f.call()).rejects.toThrow('outside'); expect(f.observations).toEqual([])
})
it('refuses an ordinary command impersonating a managed service before launch', async () => {
  const f = fixture()
  await expect(f.tools.get('run_experiment_command')!.execute({ server_id: f.serverId, run_id: 'service-fake', command: 'true' }, f.execution)).rejects.toThrow('reserved')
  expect(f.observations).toEqual([])
})
it('returns readable stream references after diagnostic exit without resubmitting it', async () => {
  const f = fixture(), original = vi.mocked(clusterNodeRequest).getMockImplementation()!
  vi.mocked(clusterNodeRequest).mockImplementation(async (...args) => args[2] === 'diagnostic' ? { state: 'running' }
    : { ...await original(...args) as object, experimentId: f.id, serverId: f.serverId, requestHash: createHash('sha256').update('true').digest('hex'),
      result: { commandId: 'readonly', state: 'completed', exitCode: 0, released: true, purpose: 'diagnostic' }, checkedAt: 1 })
  const result = JSON.parse(String(await f.tools.get('run_experiment_diagnostic')!.execute({ server_id: f.serverId, run_id: 'readonly', command: 'true' }, f.execution)))
  expect(result).toMatchObject({ state: 'settled', result: { released: true }, logs: {
    stdout: { tool: 'read_experiment_file', server_id: f.serverId, command_id: 'readonly', stream: 'stdout', offset: 0 },
    stderr: { command_id: 'readonly', stream: 'stderr' },
  } })
  expect(vi.mocked(clusterNodeRequest).mock.calls.filter(call => call[2] === 'diagnostic')).toHaveLength(1)
})

it('does not submit changed ordinary command contents or overwrite the successful original wait', async () => {
  const f = fixture(), tool = f.tools.get('run_experiment_command')!
  const args = { server_id: f.serverId, run_id: 'first', command: 'true' }
  expect(JSON.parse(String(await tool.execute(args, f.execution)))).toMatchObject({ state: 'completed' })
  const path = resolve(f.root, 'runs', f.id, 'command-waits-v1', f.serverId + '_first.json')
  const before = readFileSync(path, 'utf8'), calls = f.observations.length
  await expect(tool.execute({ ...args, command: 'printf changed' }, f.execution)).rejects.toThrow('different content')
  expect(f.observations).toHaveLength(calls); expect(readFileSync(path, 'utf8')).toBe(before)
})
it('stops matching members after a confirmed launch rejection, with content hashes', async () => {
  const f = fixture(), original = vi.mocked(clusterNodeRequest).getMockImplementation()!
  vi.mocked(clusterNodeRequest).mockImplementation(async (...args) => {
    if (args[2] === 'run' && (args[3] as { commandId: string }).commandId === 'two') throw new CommandAdmissionRejected({ version: 1, formatVersion: '0.1.3',
      experimentId: f.id, serverId: f.serverId, commandId: 'two', requestHash: createHash('sha256').update('true').digest('hex'),
      state: 'rejected', processState: 'not-started', checkedAt: Date.now(), detail: 'admission refused' })
    return original(...args)
  })
  expect(JSON.parse(String(await f.call()))).toMatchObject({ state: 'startup-failed' })
  expect(vi.mocked(clusterNodeRequest).mock.calls.filter(call => call[2] === 'stop-command')).toHaveLength(1)
  for (const call of vi.mocked(clusterNodeRequest).mock.calls.filter(call => call[2] === 'stop-command')) expect(call[3]).toMatchObject({ commandHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
})
it('reconciles a lost launch response without stopping or resubmitting the original group', async () => {
  const f = fixture(), original = vi.mocked(clusterNodeRequest).getMockImplementation()!
  vi.mocked(clusterNodeRequest).mockImplementation(async (...args) => {
    if (args[2] === 'run' && (args[3] as { commandId: string }).commandId === 'two') throw new ClusterNodeOperationError(400, 'unstructured rejection cannot establish process absence')
    return original(...args)
  })
  expect(JSON.parse(String(await f.call()))).toMatchObject({ state: 'unknown', waits: [{ state: 'settled' }, { state: 'settled' }] })
  expect(vi.mocked(clusterNodeRequest).mock.calls.filter(call => call[2] === 'run')).toHaveLength(2)
  expect(vi.mocked(clusterNodeRequest).mock.calls.some(call => call[2] === 'stop-command')).toBe(false)
})
