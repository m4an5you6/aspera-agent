/** Preparation's account-side helper must not put its growing implementation in SSH argv. */
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import { experimentIdSchema, serverSettingsSchema } from '@aspera/experiments'
import type { ServerInventory, ServerSettings } from '@aspera/experiments'
import { managedEnvironmentPolicySchema } from '@aspera/runtime'
import { preparationStorage } from '../src/preparation-storage.ts'

it('streams the actual large managed program and complete request through one account invocation', async () => {
  const server = serverSettingsSchema.parse({ id: randomUUID(), name: 'fixture', host: 'localhost', username: 'root', sshPort: 22, remotePort: 43019, authMode: 'password' })
  const inventory = fromAny<ServerInventory, object>({ home: '/root', candidates: [] })
  const run = vi.fn(async (_server: ServerSettings, command: string, _signal: AbortSignal, input?: string) => {
    if (Buffer.byteLength(command) >= 4096) throw new Error('Argument list too long')
    const payload = JSON.parse(input!)
    expect(payload.program).toContain('class ReleasedAssets')
    expect(Buffer.byteLength(payload.program)).toBeGreaterThan(131072)
    expect(payload.request.action).toBe('history-assess')
    expect(payload.request.request.requirements).toEqual(['fixture==1'])
    return JSON.stringify({ state: 'fixture-confirmed' })
  })
  const result = await preparationStorage({ server, inventory, id: experimentIdSchema.parse(randomUUID()), deploymentId: 'a'.repeat(64),
    operation: 'history-assess', input: { request: { requirements: ['fixture==1'] } }, signal: new AbortController().signal,
    policy: managedEnvironmentPolicySchema.parse({}), transport: { run, inspect: async () => inventory } })
  expect(result.history).toEqual({ state: 'fixture-confirmed' })
  expect(run).toHaveBeenCalledTimes(1)
})
