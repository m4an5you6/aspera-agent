/** Private worker-to-coordinator requests resolve account material outside tool arguments. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import type { ClusterPrivate, ClusterRuntimeConfig } from './cluster-runtime.ts'

/** Send one experiment-bound request; model inputs and results never include the token.
 * @param runtime - immutable experiment owner. @param config - private controller root.
 * @param operation - fixed coordinator route. @param body - operation arguments without credentials.
 * @param signal - tool cancellation. @returns parsed JSON; rejects transport and coordinator failures.
 */
export async function clusterCoordinatorRequest(runtime: ClusterPrivate, config: ClusterRuntimeConfig,
  operation: string, body: object, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(`http://127.0.0.1:${runtime.submission.coordinator.remotePort + 1}/aspera/v4/${operation}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${readFileSync(resolve(config.root, 'secrets/coordinator.token'), 'utf8').trim()}` },
    body: JSON.stringify({ ...body, experimentId: runtime.submission.experimentId }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(runtime.toolTimeoutMs)]), redirect: 'error',
  })
  const result: unknown = await response.json()
  if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(result).error)
  return result
}
