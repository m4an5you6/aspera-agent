/** Command groups submit participants before waiting and retain unresolved launch identities. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { fromAny } from '@total-typescript/shoehorn'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { installExecutionCommands } from '../src/execution-commands.ts'
import { clusterNodeRequest, ClusterNodeOperationError } from '../src/cluster-runtime.ts'
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
    return { experimentId: id, serverId, result: { commandId: input.commandId, state: 'completed', exitCode: 0, released: true }, checkedAt: 1 }
  })
  return { id, serverId, group, call, observations, execution, tools }
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
it('stops matching members after a confirmed launch rejection, with content hashes', async () => {
  const f = fixture(), original = vi.mocked(clusterNodeRequest).getMockImplementation()!
  vi.mocked(clusterNodeRequest).mockImplementation(async (...args) => {
    if (args[2] === 'run' && (args[3] as { commandId: string }).commandId === 'two') throw new ClusterNodeOperationError(409, 'admission refused')
    return original(...args)
  })
  expect(JSON.parse(String(await f.call()))).toMatchObject({ state: 'startup-failed' })
  expect(vi.mocked(clusterNodeRequest).mock.calls.filter(call => call[2] === 'stop-command')).toHaveLength(2)
  for (const call of vi.mocked(clusterNodeRequest).mock.calls.filter(call => call[2] === 'stop-command')) expect(call[3]).toMatchObject({ commandHash: expect.stringMatching(/^[a-f0-9]{64}$/) })
})
it('reconciles a lost launch response without stopping or resubmitting the original group', async () => {
  const f = fixture(), original = vi.mocked(clusterNodeRequest).getMockImplementation()!
  vi.mocked(clusterNodeRequest).mockImplementation(async (...args) => {
    if (args[2] === 'run' && (args[3] as { commandId: string }).commandId === 'two') throw new Error('connection reset after acceptance')
    return original(...args)
  })
  expect(JSON.parse(String(await f.call()))).toMatchObject({ state: 'unknown', waits: [{ state: 'settled' }, { state: 'settled' }] })
  expect(vi.mocked(clusterNodeRequest).mock.calls.filter(call => call[2] === 'run')).toHaveLength(2)
  expect(vi.mocked(clusterNodeRequest).mock.calls.some(call => call[2] === 'stop-command')).toBe(false)
})
