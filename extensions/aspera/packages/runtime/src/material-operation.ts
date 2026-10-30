/** Keep the DSH tool pending while node-owned material acquisition runs. */
import { setTimeout as delay } from 'node:timers/promises'
import { materialOperationSchema } from '@aspera/experiments'
import type { MaterialOperation, ExperimentId, ExperimentServerId, StorageOperationId, StorageObjectId } from '@aspera/experiments'
import type { ManagedEnvironmentPolicy } from './managed-environment.ts'
import { ClusterNodeOperationError } from './cluster-runtime.ts'

/** A lost connection preserves available evidence without inventing a material ID or byte counters. */
export interface UnconfirmedMaterialOperation {
  state: 'unknown'; experimentId: ExperimentId; serverId: ExperimentServerId; operationId: StorageOperationId;
  materialId: StorageObjectId;
  detail: string; last?: MaterialOperation
}

/**
 * Submit once and recover the connection by reading the same durable operation.
 * @param options - authenticated destination, original operation, transport and caller cancellation.
 * @returns confirmed termination or an unresolved result retaining the original identity.
 */
export async function prepareMaterialAndWait(options: {
  experimentId: ExperimentId; serverId: ExperimentServerId; operationId: StorageOperationId; policy: ManagedEnvironmentPolicy; signal: AbortSignal;
  materialId: StorageObjectId;
  submit(signal: AbortSignal): Promise<unknown>; read(signal: AbortSignal): Promise<unknown>;
}): Promise<MaterialOperation | UnconfirmedMaterialOperation> {
  const { experimentId, serverId, operationId, materialId, signal, policy } = options
  let last: MaterialOperation | undefined
  let failedSince: number | undefined
  let failure: unknown
  const requestSignal = () => AbortSignal.any([signal, AbortSignal.timeout(policy.readTimeoutMs)])
  const unknown = (detail: string): UnconfirmedMaterialOperation => ({ experimentId, serverId, operationId, materialId, state: 'unknown', detail,
    ...(last === undefined ? {} : { last }) })
  signal.throwIfAborted()
  try { await options.submit(requestSignal()) }
  catch (error) {
    signal.throwIfAborted()
    if (error instanceof ClusterNodeOperationError && error.status >= 400 && error.status < 500) throw error
    failure = error; failedSince = Date.now()
  }
  for (;;) {
    signal.throwIfAborted()
    try {
      const raw = await options.read(requestSignal())
      if (raw === null) throw new Error('Material receipt has not been observed; the original request remains unconfirmed')
      const value = materialOperationSchema.parse(raw)
      if (value.experimentId !== experimentId || value.serverId !== serverId || value.operationId !== operationId || value.materialId !== materialId) return unknown('Material result belongs to another experiment, node, operation or content')
      if (last !== undefined && (last.deadline !== value.deadline || last.startedAt !== value.startedAt || last.requestHash !== value.requestHash)) return unknown('Original material request or deadline changed; inspect the retained acquisition receipts')
      last = value; failedSince = undefined
      if ((value.state === 'completed' || value.state === 'blocked') && value.exitConfirmed && value.admissionReleased) return value
      if (value.settlementError !== undefined) return unknown('Material process settlement requires recovery of this original operation: ' + value.settlementError)
      if (Date.now() >= value.deadline + policy.stopTimeoutMs) return unknown('Material budget expired; original process exit and admission release still require recovery')
    } catch (error) {
      signal.throwIfAborted(); failure = error; failedSince ??= Date.now()
      if (Date.now() - failedSince >= policy.operationReconnectTimeoutMs) return unknown('Material connection recovery budget exhausted; recover the original operation: ' + String(failure))
    }
    await delay(policy.operationPollIntervalMs, undefined, { signal })
  }
}
