/** Durable deployment settings exclude credential values. */
import { z } from 'zod'

/** Concrete server and preparation policy captured when a task is admitted. */
export const pinnedTargetSchema = z.object({
  host: z.string(), sshPort: z.number().int(), remotePort: z.number().int(),
  username: z.string().optional(), authMode: z.enum(['key', 'password']).optional(),
  passwordRef: z.string().optional(), knownHostsFile: z.string().optional(),
  remoteRoot: z.string(), localRepo: z.string(), identityFile: z.string().optional(),
  dataRoots: z.array(z.string()), allowedSystemPackages: z.array(z.string()),
  tokenRef: z.string(), agentCredentialRefs: z.array(z.string()), toolTimeoutMs: z.number().int(),
  controlPollIntervalMs: z.number().int().min(100).default(1000),
})
