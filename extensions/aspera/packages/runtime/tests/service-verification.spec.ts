/** Durable public checks retain one request and refuse concurrent or substituted results. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { experimentIdSchema, serviceSchema, serviceVerificationInputSchema, serviceVerificationClaimIdSchema } from '@aspera/experiments'
import { ServiceVerifications } from '../src/service-verification.ts'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts/service-verification-')); roots.push(root)
  const id = experimentIdSchema.parse(randomUUID())
  const service = serviceSchema.parse({ id: randomUUID(), experimentId: id, serverId: randomUUID(), commandId: 'service-test', command: 'synthetic-backend',
    modelPath: 'checkpoint-230', modelName: 'fixture', port: 18000, healthPath: '/health', state: 'healthy', createdAt: 1, updatedAt: 1, released: false,
    external: { url: 'https://fixture.invalid:8443', port: 3000, state: 'unchecked' } })
  const input = serviceVerificationInputSchema.parse({ operationId: randomUUID(), serviceId: service.id, maxTokens: 16 })
  const claim = serviceVerificationClaimIdSchema.parse(randomUUID())
  return { id, root, service, input, claim, journal: new ServiceVerifications(experiment => resolve(root, experiment), 'a'.repeat(64), 60000) }
}
it('restores the same request after restart and does not transfer a claimed generation to another Host', async () => {
  const f = fixture(), original = await f.journal.submit(f.id, f.input, f.service)
  expect(await f.journal.submit(f.id, f.input, f.service)).toEqual(original)
  const claimed = await f.journal.claim(f.id, f.input.operationId, f.claim)
  const restored = new ServiceVerifications(experiment => resolve(f.root, experiment), 'a'.repeat(64), 60000)
  expect(await restored.claim(f.id, f.input.operationId, serviceVerificationClaimIdSchema.parse(randomUUID()))).toEqual(claimed)
  expect(restored.read(f.id, f.input.operationId)).toEqual(claimed)
  await expect(restored.submit(f.id, { ...f.input, maxTokens: 32 }, f.service)).rejects.toThrow('content changed')
  await expect(restored.submit(f.id, f.input, { ...f.service, experimentId: experimentIdSchema.parse(randomUUID()) })).rejects.toThrow('owned healthy')
  expect(() => new ServiceVerifications(() => resolve(f.root, f.id), 'b'.repeat(64), 60000).read(f.id, f.input.operationId)).toThrow('ownership')
})
it('cannot pass missing checks and retains an unknown response without replaying it', async () => {
  const f = fixture(); await f.journal.submit(f.id, f.input, f.service); await f.journal.claim(f.id, f.input.operationId, f.claim)
  await expect(f.journal.complete(f.id, f.input.operationId, f.claim, { state: 'passed', checks: [], detail: 'Agent says done', finishedAt: 2 })).rejects.toThrow('every independent check')
  const result = { state: 'unknown' as const, checks: [], detail: 'Response was lost', finishedAt: Date.now() }
  const saved = await f.journal.complete(f.id, f.input.operationId, f.claim, result)
  expect(await f.journal.submit(f.id, f.input, f.service)).toEqual(saved)
  expect(await f.journal.complete(f.id, f.input.operationId, f.claim, result)).toEqual(saved)
  await expect(f.journal.complete(f.id, f.input.operationId, serviceVerificationClaimIdSchema.parse(randomUUID()), result)).rejects.toThrow('another Host')
})
