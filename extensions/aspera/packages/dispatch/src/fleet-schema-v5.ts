/** Frozen fleet generation 5 readers preserve historical request fields and defaults. */
import { z } from 'zod'
import { serverSettingsSchema, legacyClusterServerSchema, serverIdSchema, serverInventorySchema, experimentIdSchema,
  clusterSubmissionV2Schema, budgetSchema, clusterSubmissionSchema, clusterRecordSchema, storagePlacementSchema, clusterAgentModelSchema } from '@aspera/runtime'
import { serverEnvironmentSchema, experimentModelsSchema, experimentModelSnapshotsSchema } from '@aspera/experiments'
import { pinnedTargetSchema } from './deployment-settings.ts'

const storedServerSchema = z.union([serverSettingsSchema, legacyClusterServerSchema])
/** Historical registration order and successful probe fields. */
export const fleetRegistryV5Schema = z.object({ coordinatorId: serverIdSchema.optional(), servers: z.array(storedServerSchema),
  probes: z.record(z.string(), z.object({ gpuInfo: z.string(), allocations: z.array(z.string()), inventory: serverInventorySchema.optional(),
    environment: serverEnvironmentSchema.optional(), environmentReady: z.boolean().optional(), detail: z.string().optional() })).optional() })
const legacyRequestSchema = z.object({ experimentId: experimentIdSchema, objective: z.string().trim().min(1).max(20_000),
  serverIds: z.array(serverIdSchema).min(1).max(32), files: z.array(z.string()).max(128).default([]),
  uploads: z.array(z.object({ name: clusterSubmissionV2Schema.shape.inputs.element.shape.name, size: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict()).max(128).default([]), mode: z.enum(['semi', 'automatic']),
}).strict().refine(value => new Set(value.serverIds).size === value.serverIds.length, 'duplicate server selection')
  .refine(value => new Set(value.uploads.map(file => file.name)).size === value.uploads.length, 'duplicate attachment name')
/** Generation-5 creation fields without per-request coordinator selection. */
export const fleetRequestV5Schema = legacyRequestSchema.safeExtend({ name: z.string().trim().min(1).max(120).optional(), models: experimentModelsSchema.optional() })
/** Released local records preserve their pinned coordinator and remote protocol generation. */
export const fleetExperimentV5Schema = z.object({
  request: z.union([fleetRequestV5Schema, legacyRequestSchema.safeExtend({ budget: budgetSchema })]), coordinator: storedServerSchema, servers: z.array(storedServerSchema),
  coordinatorTarget: pinnedTargetSchema, targets: z.array(pinnedTargetSchema),
  agentModel: clusterAgentModelSchema,
  models: experimentModelSnapshotsSchema.optional(),
  createdAt: z.number().int(), state: z.enum(['staging', 'preparing', 'submitted', 'failed', 'cancelled']), detail: z.string().optional(),
  sessionId: z.string(), goalId: z.string().optional(), goalRevision: z.number().optional(),
  sourceGoal: z.object({ sessionId: z.string(), id: z.string(), revision: z.number().int() }).optional(),
  submission: clusterSubmissionSchema.optional(), receipt: clusterRecordSchema.optional(), latest: clusterRecordSchema.optional(),
  handoverRecorded: z.boolean().default(false),
  waitingFor: z.array(serverIdSchema).default([]),
  preparation: z.object({ protocol: z.union([z.literal(3), z.literal(4)]), stage: z.enum(['inspecting', 'selecting-storage', 'preparing-storage', 'deploying', 'checking-network', 'transferring', 'submitting',
    'inspecting-environment', 'configuring-environment', 'repairing-environment', 'verifying-environment', 'environment-ready']),
    inventories: z.array(z.object({ serverId: serverIdSchema, inventory: serverInventorySchema })), placements: z.array(storagePlacementSchema),
    environments: z.array(z.object({ serverId: serverIdSchema,
      phase: z.enum(['inspecting-environment', 'configuring-environment', 'repairing-environment', 'verifying-environment', 'environment-ready']),
      observation: serverEnvironmentSchema.optional(), pendingCommand: z.object({ directory: z.string().startsWith('/') }).optional(),
      detail: z.string().optional() })).optional(),
    inputs: clusterSubmissionV2Schema.shape.inputs.optional() }).optional(),
})
