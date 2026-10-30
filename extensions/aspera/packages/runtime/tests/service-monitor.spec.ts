/** Historical startup failures must not terminate a program-admitted replacement. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { serviceSchema } from '@aspera/experiments'
import { observeServingServices, readServingServiceKeys } from '../src/service-monitor.ts'

const roots: string[] = [], base = resolve('.artifacts')
afterEach(() => { for (const root of roots.splice(0)) {
  if (dirname(root) !== base || !root.startsWith(resolve(base, 'serving-admission-'))) throw new Error('Serving test cleanup escaped its root')
  rmSync(root, { recursive: true, force: true })
} })

function fixture() {
  const service = serviceSchema.parse({ id: randomUUID(), serverId: randomUUID(), experimentId: randomUUID(), commandId: 'service-current', command: 'python serve.py',
    modelPath: 'adapter', port: 18000, healthPath: '/health', state: 'healthy', released: false, createdAt: 1, updatedAt: 1 })
  return { service, admitted: [{ serverId: service.serverId, serviceId: service.id }] }
}
it('keeps the admitted healthy replacement serving when an earlier startup failed and released', () => {
  const f = fixture(), old = { ...f.service, id: serviceSchema.shape.id.parse(randomUUID()), state: 'failed' as const, released: true, detail: 'Old port was occupied' }
  expect(observeServingServices(f.admitted, [old, f.service])).toEqual({ state: 'serving' })
})

it('retains failures of admitted services across nodes without confusing identical UUIDs', () => {
  const f = fixture(), other = { ...f.service, serverId: serviceSchema.shape.serverId.parse(randomUUID()), state: 'failed' as const, released: true }
  expect(observeServingServices([...f.admitted, { serverId: other.serverId, serviceId: other.id }], [f.service, other])).toMatchObject({ state: 'failed' })
  expect(observeServingServices(f.admitted, [other])).toMatchObject({ state: 'interrupted', detail: expect.stringContaining('missing') })
})

it('completes stopped admitted services while retaining unrelated failed history', () => {
  const f = fixture(), stopped = { ...f.service, state: 'stopped' as const, released: true }
  const history = { ...f.service, id: serviceSchema.shape.id.parse(randomUUID()), state: 'failed' as const, released: true }
  expect(observeServingServices(f.admitted, [history, stopped])).toEqual({ state: 'completed' })
  expect(observeServingServices([], [f.service])).toMatchObject({ state: 'interrupted' })
})

it('restores exact durable admissions and refuses missing, empty or duplicated identities', () => {
  const f = fixture(); mkdirSync(base, { recursive: true }); const root = mkdtempSync(resolve(base, 'serving-admission-')); roots.push(root)
  expect(() => readServingServiceKeys(root)).toThrow()
  const path = resolve(root, 'outcome.json')
  writeFileSync(path, JSON.stringify({ state: 'serving', servingServices: f.admitted }))
  expect(readServingServiceKeys(root)).toEqual(f.admitted)
  for (const servingServices of [[], [...f.admitted, ...f.admitted]]) {
    writeFileSync(path, JSON.stringify({ state: 'serving', servingServices }))
    expect(() => readServingServiceKeys(root)).toThrow()
  }
})
