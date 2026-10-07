/** Generation 6 management records; remote protocol 4 is unchanged. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { fleetRegistryV5Schema } from './fleet-schema-v5.ts'
import type { DeletionOperationId } from './types.ts'

const probeSchema = fleetRegistryV5Schema.shape.probes.unwrap().valueType
const operationIdSchema = z.uuid().transform(value => brandString<DeletionOperationId>(value))

/** A check belongs to the exact server configuration observed when it began. */
export const serverConnectionCheckSchema = z.object({
  status: z.enum(['unchecked', 'checking', 'passed', 'failed', 'interrupted']), configuration: z.string(),
  startedAt: z.number().optional(), checkedAt: z.number().optional(), error: z.string().optional(),
  result: probeSchema.optional(), lastSuccess: z.object({ checkedAt: z.number(), result: probeSchema }).optional(),
  gpu: z.enum(['passed', 'unavailable']).optional(), control: z.enum(['passed', 'unavailable']).optional(),
}).strict()

/** No content or credentials are retained in a deletion identity. */
export const deletedExperimentSchema = z.object({ experimentId: experimentIdSchema, requestHash: z.string(), deletedAt: z.number(),
  sourceGoal: z.object({ sessionId: z.string(), id: z.string(), revision: z.number().int() }).optional() }).strict()

/** Cleanup progress survives local interruptions and preserves each successful node. */
export const experimentDeletionSchema = z.object({ experimentId: experimentIdSchema, operationId: operationIdSchema, cleanupRemote: z.boolean(), started: z.boolean(),
  state: z.enum(['deleting', 'failed', 'deleted']), updatedAt: z.number(), detail: z.string().optional(),
  nodes: z.array(z.object({ serverId: serverIdSchema, path: z.string(), state: z.enum(['pending', 'cleaned']), detail: z.string().optional() }).strict()),
}).strict()

/** Confirmed batches use stable identities and bounded, unique experiment selections. */
export const deleteRequestSchema = z.object({ operationId: operationIdSchema, cleanupRemote: z.boolean(), allowUnconfirmed: z.boolean().default(false),
  experimentIds: z.array(experimentIdSchema).min(1).max(100) }).strict()
  .refine(value => new Set(value.experimentIds).size === value.experimentIds.length, 'Duplicate experiment selection')
