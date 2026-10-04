/** Local first-use host-key enrollment; password and delegated SSH connections stay pinned. */
import { execFile } from 'node:child_process'
import { access, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import ssh2 from 'ssh2'
import type { ServerHostKeyAlgorithm } from 'ssh2'
import type { Target } from './transport.ts'
import { SshConnectionError } from './command-result.ts'

const exec = promisify(execFile)

/** Registered public keys and the algorithms permitted by those keys. */
export interface KnownHostKeys { keys: Set<string>; algorithms: ServerHostKeyAlgorithm[] }

function hostFile(target: Target): string { return target.knownHostsFile ?? join(homedir(), '.ssh', 'known_hosts') }
function hostName(target: Target): string { return target.sshPort === 22 ? target.host : `[${target.host}]:${target.sshPort}` }
function errorCode(error: unknown): unknown { return error instanceof Error && 'code' in error ? error.code : undefined }
function diagnostic(error: unknown): string {
  return error instanceof Error && 'stderr' in error && typeof error.stderr === 'string' ? error.stderr : String(error)
}

function algorithmsFor(type: string | undefined): ServerHostKeyAlgorithm[] {
  switch (type) {
    case 'ssh-rsa': return ['rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa']
    case 'ssh-ed25519': case 'ecdsa-sha2-nistp256': case 'ecdsa-sha2-nistp384': case 'ecdsa-sha2-nistp521': return [type]
    default: return [] // Unsupported algorithms cannot authorize a password connection.
  }
}

async function registeredKeys(target: Target, signal: AbortSignal): Promise<KnownHostKeys | undefined> {
  const file = hostFile(target)
  try { await access(file) }
  catch (error) { if (errorCode(error) === 'ENOENT') return undefined; throw error }
  let output: string
  try { output = (await exec('ssh-keygen', ['-F', hostName(target), '-f', file], { windowsHide: true, signal })).stdout }
  catch (error) {
    signal.throwIfAborted()
    if (errorCode(error) === 1 && diagnostic(error).trim() === '') return undefined
    throw new Error(`Cannot read SSH host keys at ${file}: ${diagnostic(error)}`, { cause: error })
  }
  const keys = new Set<string>()
  const algorithms = new Set<ServerHostKeyAlgorithm>()
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('#') || line.trim() === '') continue
    const fields = line.trim().split(/\s+/)
    if (fields[0] === '@revoked') throw new Error('SSH host key is revoked in known_hosts')
    if (fields[0]?.startsWith('@')) continue // Host certificates cannot authorize this password transport.
    if (fields[2] !== undefined) keys.add(fields[2])
    for (const algorithm of algorithmsFor(fields[1])) algorithms.add(algorithm)
  }
  if (keys.size === 0 || algorithms.size === 0) throw new Error('SSH requires a verified server key in known_hosts')
  return { keys, algorithms: [...algorithms] }
}

/**
 * Read previously registered keys without enrolling or replacing a server identity.
 * @param target - selected account and host-key file.
 * @param signal - cancellation and operation deadline.
 * @returns public keys and permitted negotiation algorithms.
 */
export async function verifiedHostKeys(target: Target, signal: AbortSignal): Promise<KnownHostKeys> {
  const keys = await registeredKeys(target, signal)
  if (keys === undefined) throw new Error(`SSH host key is unavailable in ${hostFile(target)}; verify this server with OpenSSH before dispatching`)
  return keys
}

async function scanKeys(target: Target, signal: AbortSignal, cancellation?: AbortSignal): Promise<string> {
  const output = Promise.withResolvers<string>()
  // OpenSSH uses whole seconds; the application deadline owns timeout classification and child shutdown.
  const child = execFile('ssh-keyscan', ['-T', String(Math.floor(target.toolTimeoutMs / 1000) + 1),
    '-p', String(target.sshPort), '-t', 'ed25519,ecdsa,rsa', target.host], { windowsHide: true, signal, maxBuffer: 1_000_000, encoding: 'utf8' },
  (error, stdout, stderr) => {
    if (error === null) { output.resolve(stdout); return }
    const timedOut = signal.aborted && cancellation?.aborted !== true
    const cancelled = cancellation?.aborted === true
    const status = timedOut ? 'timed out' : cancelled ? 'was cancelled' : 'failed'
    output.reject(new SshConnectionError({ stdout,
      stderr: `SSH host-key discovery ${status} for ${hostName(target)}: ${stderr || error.message}`,
      exitCode: typeof error.code === 'number' ? error.code : null, signal: error.signal ?? null,
      timedOut, cancelled, exitConfirmed: false }))
  })
  const closed = new Promise<void>(resolve => child.once('close', () => { resolve() }))
  child.stdin?.end()
  try { return await output.promise }
  finally { await closed }
}

/**
 * Register an unseen selected server using trust on first use, without sending credentials.
 * @param target - locally selected server; remote delegated transports do not call this operation.
 * @param signal - stops discovery and pending registration; an ongoing atomic write is awaited.
 * @returns after the selected host is registered; existing or revoked keys are never replaced.
 */
export async function prepareSshHostKey(target: Target, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const timeout = AbortSignal.timeout(target.toolTimeoutMs)
  const lifetime = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  if (await registeredKeys(target, lifetime) !== undefined) return
  let output: string
  try {
    output = await scanKeys(target, lifetime, signal)
  } catch (error) {
    if (error instanceof SshConnectionError) throw error
    throw new SshConnectionError({ stdout: '', stderr: diagnostic(error), exitCode: null, signal: null,
      timedOut: lifetime.aborted && signal?.aborted !== true, cancelled: signal?.aborted === true, exitConfirmed: false })
  }
  lifetime.throwIfAborted()
  const lines: string[] = []
  const scanned = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('#') || line.trim() === '') continue
    const [, type, blob] = line.trim().split(/\s+/)
    if (type === undefined || blob === undefined || algorithmsFor(type).length === 0) throw new Error('SSH returned an unsupported host key')
    const parsed = ssh2.utils.parseKey(`${type} ${blob}`)
    if (parsed instanceof Error || Array.isArray(parsed) || parsed.getPublicSSH().toString('base64') !== blob) throw new Error('SSH returned an invalid public host key')
    if (scanned.has(blob)) continue
    scanned.add(blob)
    lines.push(`${hostName(target)} ${type} ${blob}`)
  }
  if (lines.length === 0) throw new SshConnectionError({ stdout: '', stderr: `SSH server ${hostName(target)} did not provide a public host key`,
    exitCode: null, signal: null, timedOut: false, cancelled: false, exitConfirmed: false })
  const file = hostFile(target)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await withFileLock(file, async () => {
    lifetime.throwIfAborted()
    const existing = await registeredKeys(target, lifetime)
    if (existing !== undefined) {
      if (![...existing.keys].some(key => scanned.has(key))) throw new Error('SSH server key does not match known_hosts')
      return
    }
    let previous: string
    try { previous = await readFile(file, 'utf8') }
    catch (error) { if (errorCode(error) !== 'ENOENT') throw error; previous = '' }
    lifetime.throwIfAborted()
    await writeFileAtomic(file, previous + (previous === '' || previous.endsWith('\n') ? '' : '\n') + lines.join('\n') + '\n', { mode: 0o600 })
  })
  lifetime.throwIfAborted()
}
