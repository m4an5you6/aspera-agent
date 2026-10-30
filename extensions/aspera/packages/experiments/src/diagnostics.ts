/** Model requests and program receipts for bounded diagnostic evidence. */
import { z } from 'zod'
import { experimentIdSchema, serverIdSchema } from './cluster-protocol.ts'

/** Evidence is immutable and restricted to documented experiment output directories. */
export const writeExperimentEvidenceSchema = z.object({ operationId: z.uuid(),
  path: z.string().regex(/^(?:configs|reports|artifacts\/diagnostics)\/[a-zA-Z0-9_./-]+$/)
    .refine(value => value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Evidence path is not normalized'),
  content: z.string(), format: z.enum(['text', 'json']).default('text'),
}).strict()
/** Receipt remains available after a disconnected evidence write. */
export const experimentEvidenceReceiptSchema = z.object({ version: z.literal(1), formatVersion: z.literal('0.1.3'),
  experimentId: experimentIdSchema, serverId: serverIdSchema, operationId: z.uuid(), path: z.string(),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().nonnegative(),
  state: z.enum(['requested', 'written']), checkedAt: z.number().int().nonnegative(),
}).strict()
