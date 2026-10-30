/** Authenticated launch refusals distinguish absent processes from uncertain submissions. */
import { z } from 'zod'
import { experimentIdSchema, serverIdSchema } from './cluster-protocol.ts'

/** A node publishes this receipt only before registering or spawning the requested command. */
export const commandAdmissionRejectionSchema = z.object({ version: z.literal(1), formatVersion: z.literal('0.1.3'),
  experimentId: experimentIdSchema, serverId: serverIdSchema, commandId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), state: z.literal('rejected'), processState: z.literal('not-started'),
  checkedAt: z.number().int().nonnegative(), detail: z.string(),
}).strict()
/** A refusal does not establish that the experiment allocation has been released. */
export type CommandAdmissionRejection = z.infer<typeof commandAdmissionRejectionSchema>
