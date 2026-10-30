/** Non-secret service forms and pending actions survive selection and page changes. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ServiceView, ServiceViewId } from './inference-services.ts'
import { serviceRequestIdentity } from './inference-services.ts'

/** Client-only request state, independent of the remote process and experiment result. */
export interface ServiceRequestView {
  identity: string
  path: string
  method: 'GET' | 'POST'
  body: string
  result?: string
  error?: string
  requesting: boolean
  stopping: boolean
  exitUnconfirmed: boolean
  requestOpen: boolean
  diagnosticOpen: boolean
}
interface ServiceInteractionSnapshot {
  entries: Record<string, ServiceRequestView>
  selections: Record<string, ServiceViewId>
}
interface ServiceInteractionOwner {
  items(): ServiceView[]
  request(item: ServiceView, path: string, method: 'GET' | 'POST', body?: string): Promise<string>
  stop(item: ServiceView): Promise<void>
  report(error: unknown, item: ServiceView, operation: string): void
  notify(key: 'serviceRequestDone' | 'serviceStopConfirmed' | 'serviceStopUnconfirmed'): void
}

/** Coalesces mutations by actual service identity and rejects results after deletion or replacement. */
export class ServiceInteractions {
  /** Public UI state deliberately excludes calling credentials. */
  readonly store = createSnapshotStore<ServiceInteractionSnapshot>({ entries: {}, selections: {} })
  private readonly requests = new Map<ServiceViewId, Promise<void>>()
  private readonly stops = new Map<ServiceViewId, Promise<void>>()

  constructor(private readonly owner: ServiceInteractionOwner) {}

  /** @param item - selected service. @returns retained form state or its registered health-path defaults. */
  read(item: ServiceView): ServiceRequestView {
    const saved = this.store.getSnapshot().entries[item.key]
    return saved?.identity === serviceRequestIdentity(item.service) ? saved : { identity: serviceRequestIdentity(item.service), path: item.service.healthPath, method: 'GET', body: '',
      requesting: false, stopping: false, exitUnconfirmed: false, requestOpen: false, diagnosticOpen: false }
  }

  /** @param scope - page or detail identity. @param key - actual selected service. */
  select(scope: string, key: ServiceViewId): void { this.store.update(state => { state.selections[scope] = key }) }

  /** @param item - owned service. @param patch - form fields and operation status. */
  update(item: ServiceView, patch: Partial<ServiceRequestView>): void {
    if (!this.current(item)) return
    const value = { ...this.read(item), ...patch }
    this.store.update(state => { state.entries[item.key] = value })
  }

  /** Remove deleted targets while retaining forms for saved historical services. */
  reconcile(): void {
    const items = this.owner.items()
    const keys = new Set<string>(items.map(item => item.key))
    this.store.update(state => {
      for (const key of Object.keys(state.entries)) if (!keys.has(key)) delete state.entries[key]
      for (const [scope, key] of Object.entries(state.selections)) if (!keys.has(key)) delete state.selections[scope]
      for (const item of items) {
        const entry = state.entries[item.key]
        if (entry !== undefined && entry.identity !== serviceRequestIdentity(item.service)) { delete state.entries[item.key]; continue }
        if (item.service.released && entry !== undefined) { entry.stopping = false; entry.exitUnconfirmed = false }
      }
    })
  }

  private current(item: ServiceView): ServiceView | undefined {
    return this.owner.items().find(next => next.key === item.key && serviceRequestIdentity(next.service) === serviceRequestIdentity(item.service))
  }

  /** @param item - current service. @returns the original pending request or its bounded response. */
  request(item: ServiceView): Promise<void> {
    const pending = this.requests.get(item.key)
    if (pending !== undefined) return pending
    const current = this.current(item)
    if (current === undefined || current.service.released || current.service.state !== 'healthy') return Promise.resolve()
    const input = this.read(item)
    this.update(item, { requesting: true, error: undefined })
    const operation = (async () => {
      try {
        const result = await this.owner.request(item, input.path, input.method, input.method === 'POST' ? input.body : undefined)
        if (!this.current(item)) return
        this.update(item, { result }); this.owner.notify('serviceRequestDone')
      } catch (error) {
        if (!this.current(item)) return
        this.update(item, { error: String(error) }); this.owner.report(error, item, 'service-request')
      } finally {
        this.requests.delete(item.key)
        this.update(item, { requesting: false })
      }
    })()
    this.requests.set(item.key, operation)
    return operation
  }

  /** @param item - registered process. @returns one stop request; release is determined only from returned records. */
  stop(item: ServiceView): Promise<void> {
    const pending = this.stops.get(item.key)
    if (pending !== undefined) return pending
    const current = this.current(item)
    if (current === undefined || current.service.released) return Promise.resolve()
    this.update(item, { stopping: true, exitUnconfirmed: false, error: undefined })
    const operation = (async () => {
      try {
        await this.owner.stop(item)
        const next = this.current(item)
        if (next === undefined) return
        this.update(item, { exitUnconfirmed: !next.service.released })
        this.owner.notify(next.service.released ? 'serviceStopConfirmed' : 'serviceStopUnconfirmed')
      } catch (error) {
        if (!this.current(item)) return
        this.update(item, { exitUnconfirmed: true, error: String(error) }); this.owner.report(error, item, 'service-stop')
      } finally {
        this.stops.delete(item.key)
        this.update(item, { stopping: false })
      }
    })()
    this.stops.set(item.key, operation)
    return operation
  }
}
