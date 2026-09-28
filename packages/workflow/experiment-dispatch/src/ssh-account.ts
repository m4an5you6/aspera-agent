/** SSH address normalization and account-scoped credential references. */
import { createHash } from 'node:crypto'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { ExperimentSshAccount } from './types.ts'

/**
 * Resolve a separate username or a legacy user@host destination.
 * @param host - server address, optionally prefixed by its username.
 * @param username - explicit login name.
 * @returns a validated address and optional login name.
 */
export function sshAddress(host: string, username?: string): { host: string; username?: string } {
  const parts = host.split('@')
  const address = parts.at(-1) ?? ''
  const embedded = parts.length === 2 ? parts[0] : undefined
  const user = username || embedded
  if (parts.length > 2 || !/^[a-zA-Z0-9_.:-]+$/.test(address) || address.startsWith('-')
    || (user !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(user))
    || (embedded !== undefined && username !== undefined && username !== '' && embedded !== username)) {
    throw new Error('SSH requires a server address and a matching login username')
  }
  return { host: address, ...(user === undefined ? {} : { username: user }) }
}

/**
 * Address a password by server, port and username, or by an explicit profile reference.
 * @param account - SSH account selected in trusted configuration or Web settings.
 * @returns the reference to resolve through the credential provider.
 */
export function sshPasswordRef(account: ExperimentSshAccount): CredentialRef {
  const address = sshAddress(account.host, account.username)
  if (address.username === undefined || !Number.isSafeInteger(account.sshPort) || account.sshPort < 1 || account.sshPort > 65535) {
    throw new Error('Password login requires an SSH username and a valid port')
  }
  if (account.passwordRef !== undefined) return credentialRef(account.passwordRef)
  const digest = createHash('sha256').update(JSON.stringify([address.host.toLowerCase(), account.sshPort, address.username])).digest('hex')
  return credentialRef(`DSH_EXPERIMENT_SSH_PASSWORD_${digest}`)
}
