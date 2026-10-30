/** Decode current and explicitly supported legacy node inspection responses. */
import { z } from 'zod'
import { environmentInspectionResponseSchema, environmentStorageNodeSchema, environmentOperationSchema, environmentLaunchSchema } from '@aspera/experiments'
import type { EnvironmentInspectionResponse, ExperimentId, ExperimentServerId } from '@aspera/experiments'

const legacy = z.object({ operations: z.array(environmentOperationSchema), launches: z.array(environmentLaunchSchema),
  storage: environmentStorageNodeSchema.optional(), error: z.string().optional() }).strict()
/** @param raw - authenticated node response. @param experimentId - requested allocation. @param serverId - requested node.
 * @returns a typed observation retaining errors and conservative legacy process state.
 */
export function readEnvironmentInspection(raw: unknown, experimentId: ExperimentId, serverId: ExperimentServerId): EnvironmentInspectionResponse {
  let value: EnvironmentInspectionResponse
  const current = environmentInspectionResponseSchema.safeParse(raw)
  if (current.success) value = current.data
  else {
    const wrapped = legacy.safeParse(raw)
    if (!wrapped.success) throw new Error('Unsupported environment inspection response: ' + current.error.message)
    const row = wrapped.data
    value = environmentInspectionResponseSchema.parse({ version: 1, experimentId, serverId, checkedAt: row.storage?.checkedAt ?? 0,
      ...row, operations: row.storage?.operations ?? row.operations.map(operation => ({ experimentId: operation.experimentId,
        serverId: operation.serverId, operationId: operation.operationId, state: 'unknown', operation,
        launch: row.launches.find(launch => launch.operationId === operation.operationId), checkedAt: 0, elapsedMs: 0,
        processState: 'unknown', admissionReleased: false, detail: 'Legacy inspection does not independently confirm process exit' })) })
  }
  const statuses = [...value.operations, ...(value.storage?.operations ?? [])]
  const owned = statuses.flatMap(row => [row, ...[row.operation, row.operation?.preflight, row.runtime, row.launch, row.reusePlan].filter(row => row !== undefined)])
  if (value.experimentId !== experimentId || value.serverId !== serverId || value.storage?.serverId !== undefined && value.storage.serverId !== serverId
    || [...owned, ...value.launches, ...(value.storage?.environments ?? []), ...(value.storage?.repairPlans ?? []), ...(value.storage?.diagnostics ?? [])]
      .some(row => row.experimentId !== experimentId || row.serverId !== serverId)) throw new Error('Environment inspection belongs to another experiment or node')
  return value
}
