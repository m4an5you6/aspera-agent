/** Service replacement retains the original stop identity until node cleanup is confirmed. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { fromAny } from '@total-typescript/shoehorn'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverIdSchema, serviceSchema } from '@aspera/experiments'
import { installInferenceServiceTools } from '../src/inference-service-tools.ts'
import { clusterNodeRequest } from '../src/cluster-runtime.ts'
import type { ClusterPrivate } from '../src/cluster-runtime.ts'

vi.mock('../src/cluster-runtime.ts', async original => ({ ...await original<typeof import('../src/cluster-runtime.ts')>(), clusterNodeRequest: vi.fn() }))
afterEach(() => { vi.mocked(clusterNodeRequest).mockReset() })

function fixture() {
  const id = experimentIdSchema.parse(randomUUID()), serverId = serverIdSchema.parse(randomUUID())
  const service = serviceSchema.parse({ id: randomUUID(), experimentId: id, serverId, commandId: 'service-test', command: 'python serve.py',
    modelPath: 'checkpoint-230', port: 18000, healthPath: '/health', state: 'stopped', createdAt: 1, updatedAt: 2, released: true })
  const tools = new Map<string, ToolDefinition>()
  const disposers: (() => unknown)[] = []
  const ctx = fromAny<Context, object>({ effect: (install: () => () => unknown) => { disposers.push(install()) },
    tools: { register: (tool: ToolDefinition) => { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } } } })
  const runtime = fromAny<ClusterPrivate, object>({ submission: { experimentId: id, nodes: [{ server: { id: serverId } }] } })
  const execution = fromAny<ToolRunContext, object>({ signal: new AbortController().signal })
  installInferenceServiceTools(ctx, runtime)
  const stop = (args = { server_id: serverId, service_id: service.id }) => tools.get('stop_inference_service')!.execute(args, execution)
  return { id, serverId, service, tools, disposers, execution, runtime, stop }
}

it('waits for the authenticated stop response and preserves the original identity on repeated stops', async () => {
  const f = fixture(), pending = Promise.withResolvers<unknown>()
  vi.mocked(clusterNodeRequest).mockReturnValue(pending.promise)
  let returned = false
  const stopped = f.stop().then(value => { returned = true; return value })
  await Promise.resolve()
  expect(returned).toBe(false)
  expect(clusterNodeRequest).toHaveBeenCalledWith(f.runtime, f.serverId, 'stop-service', { serviceId: f.service.id }, f.execution.signal)
  pending.resolve(f.service)
  expect(JSON.parse(String(await stopped))).toEqual(f.service)
  expect(JSON.parse(String(await f.stop()))).toEqual(f.service)
  expect(vi.mocked(clusterNodeRequest).mock.calls.every(call => call[2] === 'stop-service')).toBe(true)
})

it('retains an unconfirmed exit and propagates channel failure without issuing a replacement start', async () => {
  const f = fixture()
  vi.mocked(clusterNodeRequest).mockResolvedValue({ ...f.service, state: 'stopping', released: false })
  expect(JSON.parse(String(await f.stop()))).toMatchObject({ state: 'stopping', released: false })
  vi.mocked(clusterNodeRequest).mockRejectedValue(new Error('Connection lost after stop'))
  await expect(f.stop()).rejects.toThrow('Connection lost after stop')
  expect(vi.mocked(clusterNodeRequest).mock.calls.map(call => call[2])).toEqual(['stop-service', 'stop-service'])
})

it('refuses an unallocated server and rejects stop replies with another service, node or experiment identity', async () => {
  const f = fixture()
  await expect(f.stop({ server_id: serverIdSchema.parse(randomUUID()), service_id: f.service.id })).rejects.toThrow('outside')
  expect(clusterNodeRequest).not.toHaveBeenCalled()
  for (const changed of [{ id: randomUUID() }, { serverId: randomUUID() }, { experimentId: randomUUID() }]) {
    vi.mocked(clusterNodeRequest).mockResolvedValue({ ...f.service, ...changed })
    await expect(f.stop()).rejects.toThrow('different experiment, server or service')
  }
})

it('removes service and checkpoint tools when their owning Agent scope is disposed', () => {
  const f = fixture()
  expect([...f.tools.keys()]).toEqual(['start_inference_service', 'stop_inference_service', 'get_inference_services', 'inspect_inference_checkpoints', 'prepare_inference_checkpoint'])
  for (const dispose of f.disposers) dispose()
  expect(f.tools.size).toBe(0)
})
