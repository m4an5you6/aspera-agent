/** Program-owned interruption receipts are independent from experiment and Session generations. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { clusterRecordSchema, experimentIdSchema, serverIdSchema } from './cluster-protocol.ts'

/** One durable interruption operation, retained across disconnected requests. */
export type ExperimentInterruptionId = string & Branded<'ExperimentInterruptionId'>
/** Validate operation identities at tool, file and Remote inputs. */
export const interruptionIdSchema = z.uuid().transform(value => brandString<ExperimentInterruptionId>(value))
/** Each node retains its measured release facts independently. */
export const interruptionNodeSchema = z.object({ serverId: serverIdSchema, name: z.string(),
  phase: z.enum(['pending', 'stopping', 'verifying', 'released', 'blocked']),
  agentsExited: z.boolean(), commandsReleased: z.boolean(), servicesReleased: z.boolean(),
  updatedAt: z.number().int().nonnegative(), detail: z.string().optional(),
}).strict()
/** Version-1 journal; a released operation is not evidence of successful training. */
export const experimentInterruptionSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema,
  operationId: interruptionIdSchema, submissionHash: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.enum(['user', 'controller-recovery']), stopRequested: z.boolean(),
  phase: z.enum(['requested', 'stopping', 'verifying', 'released', 'blocked']),
  resumeVerification: z.boolean().optional(),
  startedAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  nodes: z.array(interruptionNodeSchema).min(1), detail: z.string().optional(), result: clusterRecordSchema.optional(),
}).strict().refine(value => new Set(value.nodes.map(node => node.serverId)).size === value.nodes.length, 'Interruption nodes must be unique')
  .refine(value => value.phase !== 'released' || value.nodes.every(node => node.phase === 'released' && node.agentsExited && node.commandsReleased && node.servicesReleased),
    'Released interruption requires complete node exit evidence')
  .refine(value => value.phase !== 'released' || value.result === undefined || value.result.resourcesReleased
    && ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(value.result.state) && value.result.services.every(service => service.released),
    'Interruption result must confirm terminal resource release')
/** Read-only interruption progress exposed to the operator and preparation Agent. */
export type ExperimentInterruptionStatus = z.infer<typeof experimentInterruptionSchema>
