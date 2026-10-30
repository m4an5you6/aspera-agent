/** Service operations remain bound to their original owner across navigation, deletion and uncertain exits. */
import { expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { ServiceInteractions } from '../src/client/service-interactions.ts'
import { collectServices } from '../src/client/inference-services.ts'
import { inferenceRow, inferenceService } from './inference-fixtures.ts'

function fixture() {
  const first = inferenceService()
  const second = inferenceService({ id: brandString<ReturnType<typeof inferenceService>['id']>('second') })
  let items = collectServices([inferenceRow('child', [first, second])])
  const owner = { items: () => items, request: vi.fn(async () => 'first result'), stop: vi.fn(async () => {}), report: vi.fn(), notify: vi.fn() }
  const actions = new ServiceInteractions(owner)
  return { owner, actions, items, replace: (next: typeof items) => { items = next; actions.reconcile() } }
}

it('keeps request fields and results per service and coalesces pending requests', async () => {
  const f = fixture(); const [first, second] = f.items
  const gate = Promise.withResolvers<string>(); f.owner.request.mockReturnValueOnce(gate.promise)
  f.actions.update(first!, { path: '/first', method: 'POST', body: '{"test":1}', requestOpen: true })
  const pending = f.actions.request(first!)
  expect(f.actions.request(first!)).toBe(pending)
  expect(f.actions.read(second!).path).toBe('/health')
  f.actions.select('services', second!.key)
  gate.resolve('first result'); await pending
  expect(f.owner.request).toHaveBeenCalledExactlyOnceWith(first, '/first', 'POST', '{"test":1}')
  expect(f.actions.read(first!)).toMatchObject({ result: 'first result', requesting: false })
  expect(f.actions.read(second!)).not.toHaveProperty('result')
  expect(f.actions.store.getSnapshot().selections.services).toBe(second!.key)
})

it('retains inputs and prior results on failure without sending a request to a different service', async () => {
  const f = fixture(); const first = f.items[0]!
  f.actions.update(first, { path: '/health', result: 'old result' })
  f.owner.request.mockRejectedValueOnce(new Error('network unavailable'))
  await f.actions.request(first)
  expect(f.actions.read(first)).toMatchObject({ path: '/health', result: 'old result', error: 'Error: network unavailable', requesting: false })
  expect(f.owner.report).toHaveBeenCalledOnce()
})

it('discards late success and failure after a target is deleted or its command identity changes', async () => {
  for (const failure of [false, true]) {
    const f = fixture(); const first = f.items[0]!
    const gate = Promise.withResolvers<string>(); f.owner.request.mockReturnValueOnce(gate.promise)
    const pending = f.actions.request(first)
    f.replace([])
    if (failure) gate.reject(new Error('late error')); else gate.resolve('late result')
    await pending
    expect(f.actions.store.getSnapshot().entries).toEqual({})
    expect(f.owner.report).not.toHaveBeenCalled()
    expect(f.owner.notify).not.toHaveBeenCalled()
  }
  const f = fixture(); const first = f.items[0]!
  const gate = Promise.withResolvers<string>(); f.owner.request.mockReturnValueOnce(gate.promise)
  const pending = f.actions.request(first)
  f.replace([{ ...first, service: { ...first.service, commandId: 'replacement' } }])
  gate.resolve('stale result'); await pending
  expect(f.actions.read(f.owner.items()[0]!)).not.toHaveProperty('result')
})

it('does not mark a service released just because a stop request returned', async () => {
  const f = fixture(); const first = f.items[0]!
  const gate = Promise.withResolvers<void>(); f.owner.stop.mockReturnValueOnce(gate.promise)
  const pending = f.actions.stop(first)
  expect(f.actions.stop(first)).toBe(pending)
  expect(f.actions.read(first).stopping).toBe(true)
  gate.resolve(); await pending
  expect(f.actions.read(first)).toMatchObject({ stopping: false, exitUnconfirmed: true })
  expect(f.owner.notify).toHaveBeenLastCalledWith('serviceStopUnconfirmed')
  f.replace([{ ...first, service: { ...first.service, released: true, state: 'stopped' } }])
  expect(f.actions.read(first).exitUnconfirmed).toBe(false)
})

it('confirms release from records and keeps an uncertain stop protected after connection failure', async () => {
  const f = fixture(); const first = f.items[0]!
  f.owner.stop.mockImplementationOnce(async () => { f.replace([{ ...first, service: { ...first.service, released: true, state: 'stopped' } }]) })
  await f.actions.stop(first)
  expect(f.owner.notify).toHaveBeenLastCalledWith('serviceStopConfirmed')
  const other = fixture(); other.owner.stop.mockRejectedValueOnce(new Error('lost stop response'))
  await other.actions.stop(other.items[0]!)
  expect(other.actions.read(other.items[0]!)).toMatchObject({ exitUnconfirmed: true, stopping: false })
  expect(other.owner.items()[0]?.service.released).toBe(false)
})
