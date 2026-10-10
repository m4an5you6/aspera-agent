/** SSH connection limits apply before authentication and share the caller's operation deadline. */
import { z } from 'zod'

/** Validated connection policy; retries never repeat an authenticated operation. */
export const sshConnectionPolicySchema = z.object({
  sshHandshakeTimeoutMs: z.number().int().positive().max(2_147_483_647).default(15000),
  sshHandshakeMaxRetries: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(2),
  sshHandshakeRetryDelayMs: z.number().int().nonnegative().max(2_147_483_647).default(500),
})

/** Resolved connection limits supplied by the host or a transport caller. */
export type SshConnectionPolicy = z.infer<typeof sshConnectionPolicySchema>

/**
 * Resolve optional target fields before opening an SSH connection.
 * @param input - target-specific overrides or host configuration.
 * @returns validated handshake timeout and reconnection bounds.
 */
export function resolveSshConnectionPolicy(input: Partial<SshConnectionPolicy>): SshConnectionPolicy {
  return sshConnectionPolicySchema.parse(input)
}
