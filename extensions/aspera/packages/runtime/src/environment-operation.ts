/** Keep the exclusive Agent tool pending until the node confirms installation and admission release. */
import { setTimeout as delay } from 'node:timers/promises'
import { environmentOperationStatusSchema } from '@aspera/experiments'
import type { EnvironmentOperationId, EnvironmentOperationStatus, ExperimentId, ClusterNode } from '@aspera/experiments'
import type { ManagedEnvironmentPolicy } from './managed-environment.ts'

/** Authentication and node selection belong to the caller; these operations always address one saved request. */
export interface EnvironmentOperationTransport {
  /** @param signal - individual request lifetime. @returns acceptance of the original request, never installation success. */
  submit(signal: AbortSignal): Promise<unknown>
  /** @param signal - individual read lifetime. @returns a lightweight status observation for that same operation. */
  read(signal: AbortSignal): Promise<unknown>
}

/**
 * Submit once and reconnect reads without extending the node's persisted deadline.
 * @param options - scoped operation, resolved policy, caller cancellation and authenticated transport.
 * @returns confirmed completion, confirmed failure, or an unresolved result retaining its fence.
 */
export async function prepareEnvironmentAndWait(options: {
  experimentId: ExperimentId; serverId: ClusterNode['server']['id']; operationId: EnvironmentOperationId;
  policy: ManagedEnvironmentPolicy; signal: AbortSignal; transport: EnvironmentOperationTransport;
}): Promise<EnvironmentOperationStatus> {
  const { signal, policy, transport, experimentId, serverId, operationId } = options
  let last: EnvironmentOperationStatus | undefined
  let failureSince: number | undefined
  let error: unknown
  const started = Date.now()
  const readSignal = () => AbortSignal.any([signal, AbortSignal.timeout(Math.min(policy.readTimeoutMs,
    failureSince === undefined ? policy.readTimeoutMs : Math.max(1, policy.operationReconnectTimeoutMs - (Date.now() - failureSince))))])
  const unknown = (detail: string): EnvironmentOperationStatus => ({ experimentId, serverId, operationId,
    checkedAt: Date.now(), elapsedMs: Date.now() - started, processState: 'unknown', admissionReleased: false, ...last, state: 'unknown', detail })
  signal.throwIfAborted()
  try { await transport.submit(readSignal()) }
  catch (caught) { signal.throwIfAborted(); error = caught; failureSince = Date.now() }
  for (;;) {
    signal.throwIfAborted()
    try {
      const status = environmentOperationStatusSchema.parse(await transport.read(readSignal()))
      if (status.experimentId !== experimentId || status.serverId !== serverId || status.operationId !== operationId) {
        return unknown('Operation status belongs to another experiment, server or operation; admission remains unconfirmed')
      }
      if ([status.operation, status.runtime, status.launch, status.reusePlan].some(record => record !== undefined
        && (record.experimentId !== experimentId || record.serverId !== serverId || record.operationId !== operationId))) {
        return unknown('Operation evidence belongs to another experiment, server or operation; admission remains unconfirmed')
      }
      last = status; failureSince = undefined
      if (status.state === 'completed' || status.state === 'failed') {
        if (!(status.processState === 'exited' || status.state === 'failed' && status.processState === 'not-started') || !status.admissionReleased || status.runtime?.exitConfirmed !== true
          || !status.runtime.admissionReleased || status.operation?.exitConfirmed !== true) return unknown('Final receipt, process exit and admission release disagree')
        return status
      }
      if (status.state === 'unknown') return status
      if (status.runtime === undefined) return unknown('This operation has no persisted installation deadline; inspect or recover its original release')
      if (Date.now() >= status.runtime.deadline + policy.stopTimeoutMs) return unknown('Installation budget expired; remote process-group exit has not been confirmed')
    } catch (caught) {
      signal.throwIfAborted(); error = caught; failureSince ??= Date.now()
      if (Date.now() - failureSince >= policy.operationReconnectTimeoutMs) return unknown('Connection recovery budget exhausted; query the original operation before any retry: ' + String(error))
    }
    await delay(Math.min(policy.operationPollIntervalMs, failureSince === undefined ? policy.operationPollIntervalMs
      : Math.max(1, policy.operationReconnectTimeoutMs - (Date.now() - failureSince))), undefined, { signal })
  }
}
