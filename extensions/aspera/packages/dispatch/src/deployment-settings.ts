/** Durable deployment settings exclude credential values. */
import { z } from 'zod'
import { storagePlacementSchema, inferenceMappingSchema } from '@aspera/experiments'
import { executableDirectoriesSchema } from '@aspera/experiments'

/** Concrete server and preparation policy captured when a task is admitted. */
export const pinnedTargetSchema = z.object({
  host: z.string(), sshPort: z.number().int(), remotePort: z.number().int(),
  username: z.string().optional(), authMode: z.enum(['key', 'password']).optional(),
  passwordRef: z.string().optional(), knownHostsFile: z.string().optional(),
  remoteRoot: z.string().optional(), storagePlacement: storagePlacementSchema.optional(), localRepo: z.string(), identityFile: z.string().optional(),
  dataRoots: z.array(z.string()),
  pathEntries: executableDirectoriesSchema.optional(),
  preparationOutputChars: z.number().int().min(1024).max(2_000_000).default(65536),
  tokenRef: z.string(), agentCredentialRefs: z.array(z.string()), toolTimeoutMs: z.number().int(),
  controlPollIntervalMs: z.number().int().min(100).default(1000),
  minimumFreeBytes: z.number().int().positive().optional(),
  inferenceMapping: inferenceMappingSchema.optional(),
})
