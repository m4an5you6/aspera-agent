import { experimentStoragePoliciesSchema, storagePolicyRecordSchema } from '@aspera/experiments'
import type { ExperimentStoragePolicies, StoragePolicyRecord } from '@aspera/experiments'
/** Host-owned storage observations and candidate-bound cleanup never rewrite submissions or training results. */
import { existsSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { managedEnvironmentConfig, redactObservation, pythonMainInput } from '@aspera/runtime'
import type { ManagedEnvironmentPolicy } from '@aspera/runtime'
import { environmentStorageNodeSchema, experimentStorageUsageSchema, experimentCacheCleanupSchema,
  experimentCachePreviewSchema, experimentCacheResultSchema, experimentStoragePlanSchema, inspectExperimentMaterialsSchema } from '@aspera/experiments'
import type { ExperimentStoragePlan } from '@aspera/experiments'
import { serverStorageCatalogSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentServerId, ExperimentStorageUsage, ExperimentCachePreview, ExperimentCacheCleanup,
  ExperimentCacheResult, EnvironmentStorageNode } from '@aspera/experiments'
import type { FleetExperiment } from './types.ts'
import { fetchCanonicalMaterialMetadata } from './material-metadata.ts'

/** Credential resolution and pinned node connections remain with the fleet. */
export interface EnvironmentStorageOwner {
  /** @returns retained experiments for program-owned background metadata requests. */
  list?(): FleetExperiment[]
  get(id: ExperimentId): FleetExperiment
  alive(id: ExperimentId): boolean
  node(record: FleetExperiment, serverId: ExperimentServerId, operation: string, body: object, signal: AbortSignal): Promise<unknown>
  ssh(record: FleetExperiment, serverId: ExperimentServerId, command: string, signal: AbortSignal, input?: string): Promise<string>
  program(): string
  secrets(record: FleetExperiment): Promise<string[]>
}

type Job = { abort: AbortController; done: Promise<ExperimentStorageUsage>; scanKey?: string }
const cleanupJournal = z.object({ version: z.literal(1), binding: z.string(), request: experimentCacheCleanupSchema,
  state: z.enum(['unconfirmed', 'settled']), result: experimentCacheResultSchema.optional() }).strict()

/** Version-1 local observations retain original remote check times during disconnection. */
export class ExperimentEnvironments {
  private readonly jobs = new Map<ExperimentId, Job>()
  private readonly cleanups = new Map<ExperimentId, { id: string; abort: AbortController; done: Promise<ExperimentCacheResult> }>()
  private readonly policyJobs = new Set<{ id: ExperimentId; abort: AbortController; done: Promise<unknown> }>()
  private readonly reconsiderations = new Map<string, Promise<StoragePolicyRecord>>()
  private readonly checked = new Map<ExperimentId, number>()
  private readonly removed = new Set<ExperimentId>()
  private closed = false
  private bridgeAbort: AbortController | undefined
  private bridgeDone: Promise<void> | undefined
  private readonly bridgeJobs = new Map<ExperimentId, { abort: AbortController; done: Promise<void> }>()
  constructor(private readonly root: string, private readonly owner: EnvironmentStorageOwner, private readonly policy: ManagedEnvironmentPolicy) {}

  /** Start one Host-owned loop; hiding the window does not stop fixed-revision metadata recovery. */
  start(): void {
    if (this.bridgeDone !== undefined || this.owner.list === undefined || this.closed) return
    const abort = new AbortController(); this.bridgeAbort = abort
    this.bridgeDone = (async () => {
      while (!abort.signal.aborted) {
        for (const record of this.owner.list?.() ?? []) {
          const id = record.request.experimentId
          if (record.submission?.protocol !== 4 || record.latest?.resourcesReleased || !this.owner.alive(id) || this.removed.has(id)) continue
          const job = new AbortController()
          const signal = AbortSignal.any([abort.signal, job.signal])
          const done = this.bridgeMetadata(record, signal)
          this.bridgeJobs.set(id, { abort: job, done })
          try { await done }
          catch (error) {
            // Network recovery is retried by this loop without invalidating the separately measured storage copy.
            if (signal.aborted && !abort.signal.aborted && !this.removed.has(id)) throw error
          } finally { this.bridgeJobs.delete(id) }
        }
        await delay(this.policy.storageIntervalMs, undefined, { signal: abort.signal })
      }
    })().catch((error: unknown) => { if (!abort.signal.aborted) throw error })
  }

  private async bridgeMetadata(record: FleetExperiment, signal: AbortSignal): Promise<void> {
    const id = record.request.experimentId
    const pendingSchema = z.array(z.object({ requestId: z.string().regex(/^[a-f0-9]{64}$/), request: inspectExperimentMaterialsSchema, deadline: z.number().int().optional() }).strict()).max(128)
    for (const server of record.servers) {
      this.check(id, signal)
      const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.policy.readTimeoutMs)])
      const pending = pendingSchema.parse(await this.owner.node(record, server.id, 'material-metadata-pending', { experimentId: id }, bounded))
      for (const item of pending) {
        this.check(id, signal)
        if (item.request.metadataSource === 'node' || item.request.metadataSource === 'cache'
          || item.deadline !== undefined && item.deadline <= Date.now()) continue
        const folder = resolve(this.root, id, 'canonical-manifests-v1')
        const path = resolve(folder, item.requestId + '.json')
        let canonical: unknown
        if (existsSync(path)) canonical = JSON.parse(readFileSync(path, 'utf8'))
        else {
          try { canonical = await fetchCanonicalMaterialMetadata({ request: item.request, readBytes: this.policy.readBytes, pollIntervalMs: this.policy.operationPollIntervalMs,
            readTimeoutMs: item.deadline === undefined ? this.policy.readTimeoutMs : Math.min(this.policy.readTimeoutMs, item.deadline - Date.now()), signal, fetcher: fetch }) }
          catch (error) {
            signal.throwIfAborted()
            const secrets = await this.owner.secrets(record)
            await this.owner.node(record, server.id, 'material-metadata-error', { experimentId: id, requestId: item.requestId,
              detail: redactObservation('Local Host canonical metadata check failed: ' + String(error), secrets) },
              AbortSignal.any([signal, AbortSignal.timeout(this.policy.readTimeoutMs)]))
            continue
          }
          this.check(id, signal); mkdirSync(folder, { recursive: true, mode: 0o700 })
          await writeFileAtomic(path, JSON.stringify(canonical) + '\n', { mode: 0o600 })
        }
        this.check(id, signal)
        await this.owner.node(record, server.id, 'material-manifest-import', { experimentId: id, ...item.request, canonical },
          AbortSignal.any([signal, AbortSignal.timeout(this.policy.readTimeoutMs)]))
      }
    }
  }

  private check(id: ExperimentId, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (this.closed || this.removed.has(id) || !this.owner.alive(id)) throw new Error('Environment observation belongs to a removed experiment')
  }
  private path(id: ExperimentId): string { return resolve(this.root, id, 'storage.v1.json') }
  private saved(record: FleetExperiment): ExperimentStorageUsage | undefined {
    const path = this.path(record.request.experimentId)
    if (!existsSync(path)) return undefined
    const value = z.object({ version: z.literal(1), binding: z.string(), usage: experimentStorageUsageSchema }).strict().parse(JSON.parse(readFileSync(path, 'utf8')))
    if (value.binding !== this.binding(record) || value.usage.experimentId !== record.request.experimentId
      || value.usage.nodes.some(node => !record.servers.some(server => server.id === node.serverId))) throw new Error('Saved environment observations differ from the original experiment')
    return value.usage
  }
  private binding(record: FleetExperiment): string {
    return createHash('sha256').update(JSON.stringify(record.submission ?? record.request)).digest('hex')
  }

  /** @param id - retained experiment. @returns fresh bounded observations or an unchanged, explicitly offline local copy. */
  usage(id: ExperimentId): Promise<ExperimentStorageUsage> {
    const record = this.owner.get(id)
    const pending = this.jobs.get(id)
    if (pending !== undefined) return pending.done
    if (Date.now() - (this.checked.get(id) ?? 0) < this.policy.storageIntervalMs) {
      const saved = this.saved(record)
      if (saved !== undefined) return Promise.resolve(saved)
    }
    const abort = new AbortController()
    const done = this.observe(record, abort.signal).finally(() => { this.jobs.delete(id) })
    this.jobs.set(id, { abort, done }); return done
  }
  /** @param id - retained experiment. @returns original approved policies and pending proposals on assigned nodes. */
  storagePolicies(id: ExperimentId): Promise<ExperimentStoragePolicies> {
    return this.policyOperation(id, signal => this.readPolicies(id, signal))
  }
  /** @param id - retained task. @param proposalId - rejected Agent proposal. @param expectedRevision - current approved revision. @returns a new Host-approved successor preserving the original rejection and contents. */
  reconsiderStoragePolicy(id: ExperimentId, proposalId: string, expectedRevision: number): Promise<StoragePolicyRecord> {
    const key = id + ':' + proposalId, pending = this.reconsiderations.get(key)
    if (pending !== undefined) return pending
    const done = this.policyOperation(id, async signal => {
      const record = this.owner.get(id), policies = await this.readPolicies(id, signal)
      const matches = policies.flatMap(node => node.proposals.filter(proposal => proposal.proposalId === proposalId).map(proposal => ({ node, proposal })))
      if (matches.length !== 1 || matches[0]!.proposal.state !== 'rejected') throw new Error('Storage reconsideration requires one retained rejected proposal')
      const { node, proposal } = matches[0]!, result = record.latest ?? record.receipt
      if (result?.sessionId === undefined || result.plan?.revision !== proposal.planRevision) throw new Error('Rejected proposal belongs to another approved plan')
      const reason = 'Host reconsideration of rejected Agent proposal ' + proposalId + '; original reason and decision remain in that proposal.'
      const prior = node.proposals.find(value => value.reason === reason)
      if ((prior === undefined || prior.state !== 'approved') && (node.current?.revision ?? 0) !== expectedRevision) throw new Error('Storage policy revision changed before reconsideration')
      if (prior !== undefined && (JSON.stringify(prior.policy) !== JSON.stringify(proposal.policy) || prior.expectedRevision !== expectedRevision)) throw new Error('Storage reconsideration contents changed')
      const evidenceContext = { sessionId: result.sessionId, planRevision: result.plan.revision }
      const successor = prior ?? storagePolicyRecordSchema.parse(await this.owner.node(record, node.serverId, 'storage-policy-propose', {
        experimentId: id, operationId: randomUUID(), expectedRevision, policy: proposal.policy, reason, evidenceContext }, signal))
      if (successor.experimentId !== id || successor.serverId !== node.serverId || successor.planRevision !== proposal.planRevision
        || JSON.stringify(successor.policy) !== JSON.stringify(proposal.policy)) throw new Error('Storage reconsideration successor changed the Agent proposal')
      this.check(id, signal)
      const approved = storagePolicyRecordSchema.parse(await this.owner.node(record, node.serverId, 'storage-policy-decide', {
        experimentId: id, proposalId: successor.proposalId, expectedRevision, approve: true, evidenceContext }, signal))
      this.check(id, signal)
      if (approved.experimentId !== id || approved.serverId !== node.serverId || approved.proposalId !== successor.proposalId || approved.state !== 'approved') throw new Error('Storage reconsideration decision differs from the requested successor')
      return approved
    }).finally(() => { this.reconsiderations.delete(key) })
    this.reconsiderations.set(key, done); return done
  }
  private async readPolicies(id: ExperimentId, signal: AbortSignal): Promise<ExperimentStoragePolicies> {
    const record = this.owner.get(id)
    const values = await Promise.all(record.servers.map(async server => {
      this.check(id, signal)
      const value = await this.owner.node(record, server.id, 'storage-policy-status', { experimentId: id }, signal)
      this.check(id, signal)
      const parsed = z.object({ current: storagePolicyRecordSchema.nullable(), proposals: z.array(storagePolicyRecordSchema) }).strict().parse(value)
      if ([...(parsed.current === null ? [] : [parsed.current]), ...parsed.proposals].some(row => row.experimentId !== id || row.serverId !== server.id)) throw new Error('Storage policy observation belongs to another allocation')
      return { ...parsed, serverId: server.id }
    }))
    return experimentStoragePoliciesSchema.parse(values)
  }
  /** @param id - retained experiment. @param proposalId - original proposal. @param expectedRevision - approved revision. @param approve - explicit operator decision. @returns the saved decision. */
  decideStoragePolicy(id: ExperimentId, proposalId: string, expectedRevision: number, approve: boolean): Promise<StoragePolicyRecord> {
    return this.policyOperation(id, async signal => {
    const record = this.owner.get(id), policies = await this.readPolicies(id, signal)
    const found = policies.filter(row => row.proposals.some(proposal => proposal.proposalId === proposalId))
    if (found.length !== 1) throw new Error('Storage proposal does not identify one assigned node')
    this.check(id, signal)
    const result = storagePolicyRecordSchema.parse(await this.owner.node(record, found[0]!.serverId, 'storage-policy-decide',
      { experimentId: id, proposalId, expectedRevision, approve }, signal))
    this.check(id, signal)
    if (result.experimentId !== id || result.serverId !== found[0]!.serverId) throw new Error('Storage decision belongs to another experiment')
    return result
    })
  }
  private policyOperation<T>(id: ExperimentId, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const abort = new AbortController(), signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.policy.readTimeoutMs)])
    this.check(id, signal)
    const done = Promise.resolve().then(() => { this.check(id, signal); return operation(signal) }).finally(() => { this.policyJobs.delete(job) })
    const job = { id, abort, done }; this.policyJobs.add(job)
    return done
  }
  /** @param id - retained experiment. @returns saved per-node plans with their original measurement times. */
  async plans(id: ExperimentId): Promise<ExperimentStoragePlan[]> {
    const usage = await this.usage(id)
    return usage.nodes.flatMap(node => node.storagePlan === undefined ? [] : [experimentStoragePlanSchema.parse(node.storagePlan)])
  }
  /** @param id - retained experiment. @param serverId - selected node. @param cursor - previous bounded scan. @returns refreshed usage after a program-owned account-side scan. */
  refresh(id: ExperimentId, serverId: ExperimentServerId, cursor?: string): Promise<ExperimentStorageUsage> {
    const record = this.owner.get(id)
    if (!record.servers.some(server => server.id === serverId)) throw new Error('Storage scan server is outside this experiment')
    const pending = this.jobs.get(id)
    const scanKey = JSON.stringify([serverId, cursor])
    if (pending !== undefined) return pending.scanKey === scanKey ? pending.done : pending.done.then(() => this.refresh(id, serverId, cursor))
    const abort = new AbortController()
    const fields = { refresh: true, ...(cursor === undefined ? {} : { cursor }) }
    const done = (async () => {
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(this.policy.readTimeoutMs)])
      this.check(id, signal)
      let value: unknown
      try { value = await this.owner.node(record, serverId, 'storage-inspect', { experimentId: id, ...fields }, signal) }
      catch (_controlError) {
        // observe retains control connection failures independently from this SSH inventory result.
        signal.throwIfAborted(); value = await this.readOverSsh(record, serverId, 'storage-inspect', fields, signal)
      }
      serverStorageCatalogSchema.parse(value)
      this.check(id, signal); this.checked.delete(id)
      return this.observe(record, abort.signal)
    })().finally(() => { this.jobs.delete(id) })
    this.jobs.set(id, { abort, done, scanKey })
    return done
  }

  private async readOverSsh(record: FleetExperiment, serverId: ExperimentServerId, action: string, fields: object, signal: AbortSignal): Promise<unknown> {
    const node = record.submission?.protocol === 4 ? record.submission.nodes.find(value => value.server.id === serverId) : undefined
    if (node?.server.storagePlacement === undefined) throw new Error('SSH storage inspection requires the saved protocol-4 placement')
    const config = { ...managedEnvironmentConfig({ experimentId: record.request.experimentId, node, deploymentId: record.submission!.deploymentId,
      controlRoot: node.server.remoteRoot, hiddenPaths: [node.server.remoteRoot, node.server.storagePlacement.namespaceRoot] }, this.policy, action),
      reuseVerificationVersion: 0, ...fields }
    const program = this.owner.program().split('if __name__ == "__main__":')[0]!
    const invocation = pythonMainInput(program, config)
    return JSON.parse(await this.owner.ssh(record, serverId, invocation.command, signal, invocation.input))
  }
  private async observe(record: FleetExperiment, signal: AbortSignal): Promise<ExperimentStorageUsage> {
    const id = record.request.experimentId
    this.check(id, signal)
    const saved = this.saved(record); const secrets = await this.owner.secrets(record)
    const nodes: EnvironmentStorageNode[] = []
    for (const server of record.servers) {
      this.check(id, signal)
      try {
        const input = { experimentId: id }
        let value: unknown; let connectionError: string | undefined
        try { value = await this.owner.node(record, server.id, 'environment-storage', input, signal) }
        catch (error) {
          signal.throwIfAborted(); connectionError = redactObservation(String(error), secrets)
          if (record.submission?.protocol !== 4) throw error
          value = await this.readOverSsh(record, server.id, 'inspect', {}, signal)
        }
        const observed = environmentStorageNodeSchema.parse(value)
        const rows = [...observed.environments, ...(observed.reusePlans ?? []), ...(observed.cleanups ?? []), ...(observed.recoveries ?? []), ...(observed.operations ?? []),
          ...(observed.borrowings ?? []), ...(observed.materialOperations ?? []), ...(observed.storagePlan === undefined ? [] : [observed.storagePlan]), ...(observed.arrangement === undefined ? [] : [observed.arrangement])]
        if (observed.serverId !== server.id || rows.some(row => row.experimentId !== id || row.serverId !== server.id)) throw new Error('Remote environment observations belong to another experiment')
        if (observed.catalog?.serverId !== undefined && observed.catalog.serverId !== server.id || observed.assets?.some(row => row.serverId !== server.id)) throw new Error('Storage catalog or material belongs to another server')
        nodes.push({ ...observed, source: connectionError === undefined ? 'remote' : 'ssh', ...(connectionError === undefined ? {} : { error: connectionError }) })
      } catch (error) {
        signal.throwIfAborted()
        const previous = saved?.nodes.find(node => node.serverId === server.id)
        nodes.push({ ...(previous ?? { serverId: server.id, name: server.name, checkedAt: 0, availableBytes: 0, capacityBytes: 0,
          workspaceBytes: 0, sharedBytes: 0, reclaimableBytes: 0, environments: [], legacy: [] }),
          source: 'local', complete: false, error: redactObservation(String(error), secrets) })
      }
    }
    this.check(id, signal)
    const usage = experimentStorageUsageSchema.parse({ version: 1, experimentId: id, nodes, updatedAt: Date.now() })
    mkdirSync(resolve(this.root, id), { recursive: true })
    await writeFileAtomic(this.path(id), JSON.stringify({ version: 1, binding: this.binding(record), usage }) + '\n', { mode: 0o600 })
    this.check(id, signal); this.checked.set(id, Date.now())
    return usage
  }

  /** @param id - retained experiment. @returns safe candidates or a per-node capability/connection blocker. */
  async preview(id: ExperimentId): Promise<ExperimentCachePreview> {
    await this.resume(id)
    const record = this.owner.get(id); const signal = AbortSignal.timeout(this.policy.readTimeoutMs)
    const secrets = await this.owner.secrets(record); const nodes: ExperimentCachePreview['nodes'] = []
    for (const server of record.servers) {
      this.check(id, signal)
      try {
        const value = experimentCachePreviewSchema.shape.nodes.element.parse(await this.owner.node(record, server.id, 'environment-preview', { experimentId: id }, signal))
        if (value.serverId !== server.id) throw new Error('Cleanup preview belongs to another node')
        nodes.push(value)
      } catch (error) { nodes.push({ serverId: server.id, checkedAt: Date.now(), fingerprint: createHash('sha256').update('unavailable').digest('hex'),
        candidates: [], eligible: false, detail: redactObservation(String(error), secrets) }) }
    }
    this.check(id, signal); return { experimentId: id, nodes }
  }

  /** @param raw - original preview identities. @returns durable results; repeated clicks share the same operation. */
  cleanup(raw: ExperimentCacheCleanup): Promise<ExperimentCacheResult> {
    const request = experimentCacheCleanupSchema.parse(raw); const id = request.experimentId
    this.owner.get(id)
    const pending = this.cleanups.get(id)
    if (pending !== undefined) {
      if (pending.id !== JSON.stringify(request)) throw new Error('Another cleanup operation is pending for this experiment')
      return pending.done
    }
    const abort = new AbortController()
    const done = this.clean(request, abort.signal).finally(() => { this.cleanups.delete(id); this.checked.delete(id) })
    this.cleanups.set(id, { id: JSON.stringify(request), abort, done }); return done
  }
  private async clean(request: ExperimentCacheCleanup, signal: AbortSignal): Promise<ExperimentCacheResult> {
    const record = this.owner.get(request.experimentId); const secrets = await this.owner.secrets(record)
    if (new Set(request.nodes.map(node => node.serverId)).size !== request.nodes.length
      || request.nodes.some(node => !record.servers.some(server => server.id === node.serverId))) throw new Error('Cleanup selects an unassigned or duplicate server')
    mkdirSync(resolve(this.root, request.experimentId), { recursive: true })
    const journal = resolve(this.root, request.experimentId, request.operationId + '.cleanup.v1.json')
    if (existsSync(journal)) {
      const original = cleanupJournal.parse(JSON.parse(readFileSync(journal, 'utf8')))
      if (original.binding !== this.binding(record) || JSON.stringify(original.request) !== JSON.stringify(request)) throw new Error('Cleanup operation identity is bound to another request')
      if (original.state === 'settled' && original.result?.nodes.every(node => node.state === 'completed')) return original.result
      return this.recover(request, signal)
    }
    this.check(request.experimentId, signal)
    await writeFileAtomic(journal, JSON.stringify({ version: 1, binding: this.binding(record), request, state: 'unconfirmed' }) + '\n', { mode: 0o600 })
    const nodes: ExperimentCacheResult['nodes'] = []
    let unconfirmed = false
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.policy.timeoutMs)])
    for (const node of request.nodes) {
      this.check(request.experimentId, bounded)
      try {
        let result: ExperimentCacheResult['nodes'][number]
        for (;;) {
          result = experimentCacheResultSchema.shape.nodes.element.parse(await this.owner.node(record, node.serverId, 'environment-cleanup', { ...request, nodes: [node] }, bounded))
          if (result.serverId !== node.serverId) throw new Error('Cleanup result belongs to another server')
          if (result.state === 'completed' || !result.detail?.startsWith('Cleanup started') && !result.detail?.startsWith('Cleanup remains pending')) break
          await delay(this.policy.operationPollIntervalMs, undefined, { signal: bounded })
        }
        nodes.push(result)
      } catch (error) { unconfirmed = true; nodes.push({ serverId: node.serverId, state: 'blocked', reclaimedBytes: 0, checkedAt: Date.now(), detail: redactObservation(String(error), secrets) }) }
    }
    this.check(request.experimentId, signal)
    const result = { experimentId: request.experimentId, operationId: request.operationId, nodes }
    await writeFileAtomic(journal, JSON.stringify({ version: 1, binding: this.binding(record), request, result, state: unconfirmed ? 'unconfirmed' : 'settled' }) + '\n', { mode: 0o600 })
    this.check(request.experimentId, signal); return result
  }

  /** Resume exit verification of retained cleanup requests; this never submits another deletion. @param id - retained experiment. @returns after bounded status reads finish. */
  async resume(id: ExperimentId): Promise<void> {
    const pending = this.cleanups.get(id)
    if (pending !== undefined) { await pending.done; return }
    const record = this.owner.get(id); const folder = resolve(this.root, id)
    if (!existsSync(folder)) return
    for (const name of readdirSync(folder).filter(name => name.endsWith('.cleanup.v1.json'))) {
      const journal = cleanupJournal.parse(JSON.parse(readFileSync(resolve(folder, name), 'utf8')))
      if (journal.binding !== this.binding(record) || journal.request.experimentId !== id) throw new Error('Cleanup journal belongs to another experiment')
      if (journal.state === 'settled') continue
      const abort = new AbortController()
      const done = this.recover(journal.request, abort.signal).finally(() => { this.cleanups.delete(id); this.checked.delete(id) })
      this.cleanups.set(id, { id: JSON.stringify(journal.request), abort, done }); await done
    }
  }
  private async recover(request: ExperimentCacheCleanup, signal: AbortSignal): Promise<ExperimentCacheResult> {
    const record = this.owner.get(request.experimentId); const secrets = await this.owner.secrets(record)
    const nodes: ExperimentCacheResult['nodes'] = []; let unconfirmed = false
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(this.policy.readTimeoutMs)])
    for (const node of request.nodes) {
      try {
        this.check(request.experimentId, bounded)
        const response = z.object({ state: z.enum(['not-started', 'running', 'settled', 'unknown']), detail: z.string().optional(), result: experimentCacheResultSchema.shape.nodes.element.optional() }).strict()
          .parse(await this.owner.node(record, node.serverId, 'environment-cleanup-status', { ...request, nodes: [node] }, bounded))
        if (response.state === 'settled' && response.result !== undefined) {
          if (response.result.serverId !== node.serverId) throw new Error('Cleanup recovery belongs to another server')
          nodes.push(response.result)
        } else {
          unconfirmed ||= response.state === 'running' || response.state === 'unknown'
          nodes.push({ serverId: node.serverId, state: 'blocked', reclaimedBytes: 0, checkedAt: Date.now(),
            detail: response.state === 'unknown' ? response.detail ?? 'Original cleanup outcome cannot be confirmed; no replacement was submitted'
              : response.state === 'running' ? 'Original cleanup is still running; no replacement was submitted' : 'Original cleanup was not started; refresh the preview before a new request' })
        }
      } catch (error) {
        unconfirmed = true; nodes.push({ serverId: node.serverId, state: 'blocked', reclaimedBytes: 0, checkedAt: Date.now(), detail: redactObservation(String(error), secrets) })
      }
    }
    this.check(request.experimentId, signal)
    const result = { experimentId: request.experimentId, operationId: request.operationId, nodes }
    await writeFileAtomic(resolve(this.root, request.experimentId, request.operationId + '.cleanup.v1.json'),
      JSON.stringify({ version: 1, binding: this.binding(record), request, result, state: unconfirmed ? 'unconfirmed' : 'settled' }) + '\n', { mode: 0o600 })
    this.check(request.experimentId, signal); return result
  }
  /** @param id - retained experiment. @returns whether every cache-operation exit is confirmed before remote deletion. */
  async readyToDelete(id: ExperimentId): Promise<boolean> {
    await this.resume(id)
    const folder = resolve(this.root, id)
    if (!existsSync(folder)) return true
    return readdirSync(folder).filter(name => name.endsWith('.cleanup.v1.json')).every(name => cleanupJournal.parse(JSON.parse(readFileSync(resolve(folder, name), 'utf8'))).state === 'settled')
  }

  /** @param id - deletion-marked experiment. @returns after reads and cleanup calls stop, before removing its local observations. */
  async remove(id: ExperimentId): Promise<void> {
    const bridge = this.bridgeJobs.get(id)
    bridge?.abort.abort(new Error('Experiment deleted'))
    this.removed.add(id); this.jobs.get(id)?.abort.abort(new Error('Experiment deleted')); this.cleanups.get(id)?.abort.abort(new Error('Experiment deleted'))
    const policyJobs = [...this.policyJobs].filter(job => job.id === id)
    for (const job of policyJobs) job.abort.abort(new Error('Experiment deleted'))
    await Promise.allSettled([this.jobs.get(id)?.done, this.cleanups.get(id)?.done, bridge?.done, ...policyJobs.map(job => job.done)])
    const path = resolve(this.root, id)
    if (existsSync(path)) rmSync(path, { recursive: true })
    this.checked.delete(id)
  }
  /** Stop owned I/O and committed writes before Host shutdown. */
  async close(): Promise<void> {
    this.closed = true
    this.bridgeAbort?.abort(new Error('Host stopped'))
    for (const job of [...this.jobs.values(), ...this.cleanups.values(), ...this.policyJobs]) job.abort.abort(new Error('Host stopped'))
    await Promise.allSettled([...this.jobs.values(), ...this.cleanups.values(), ...this.policyJobs].map(job => job.done))
    await this.bridgeDone
  }
}
