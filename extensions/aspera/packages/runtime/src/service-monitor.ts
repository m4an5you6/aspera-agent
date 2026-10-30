/** Serving monitors follow admitted service identities rather than earlier failed attempts. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { serverIdSchema, serviceIdSchema } from '@aspera/experiments'
import type { InferenceService } from '@aspera/experiments'

/** Exact node/service identities accepted by the execution completion check. */
export const servingServiceKeySchema = z.object({ serverId: serverIdSchema, serviceId: serviceIdSchema }).strict()
/** Persisted serving identity for one original managed process. */
export type ServingServiceKey = z.infer<typeof servingServiceKeySchema>
/** A serving allocation completes only after its admitted processes release. */
export type ServingObservation = { state: 'serving' | 'completed' } | { state: 'failed' | 'interrupted'; detail: string }

/** @param root - original private run. @returns admitted identities; absent or malformed admission never selects arbitrary old services. */
export function readServingServiceKeys(root: string): ServingServiceKey[] {
  const saved = z.object({ state: z.literal('serving'), servingServices: z.array(servingServiceKeySchema).min(1) }).parse(JSON.parse(readFileSync(resolve(root, 'outcome.json'), 'utf8')))
  if (new Set(saved.servingServices.map(row => row.serverId + '/' + row.serviceId)).size !== saved.servingServices.length) throw new Error('Serving admission contains duplicate identities')
  return saved.servingServices
}

/** @param admitted - identities saved at successful completion. @param services - current authenticated node observations. @returns current lifecycle outcome. */
export function observeServingServices(admitted: readonly ServingServiceKey[], services: readonly InferenceService[]): ServingObservation {
  if (admitted.length === 0) return { state: 'interrupted', detail: 'Serving admission identities are missing; no process was restarted.' }
  const selected = admitted.map(key => services.find(service => service.serverId === key.serverId && service.id === key.serviceId))
  if (selected.some(service => service === undefined)) return { state: 'interrupted', detail: 'An admitted service identity is missing; no replacement was inferred.' }
  const current = selected.filter((service): service is InferenceService => service !== undefined)
  const failed = current.find(service => ['failed', 'interrupted'].includes(service.state))
  if (failed !== undefined) return { state: failed.state === 'interrupted' ? 'interrupted' : 'failed', detail: failed.detail ?? 'Inference service failed.' }
  if (current.every(service => service.released)) return { state: 'completed' }
  return { state: 'serving' }
}
