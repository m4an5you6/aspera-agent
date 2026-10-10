/** Non-interactive OpenSSH control and short-lived loopback tunnels. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { passwordCopy, passwordResult, passwordRequest } from './password-transport.ts'
import { RemoteCommandError, SshConnectionError } from './command-result.ts'
import type { CommandResult, RemoteCommandResult } from './command-result.ts'
export { RemoteCommandError, SshConnectionError } from './command-result.ts'
export type { CommandResult, RemoteCommandResult } from './command-result.ts'
export { prepareSshHostKey } from './ssh-host-keys.ts'
export { resolveSshConnectionPolicy, sshConnectionPolicySchema } from './ssh-connection.ts'
export type { SshConnectionPolicy } from './ssh-connection.ts'
import type { SshConnectionPolicy } from './ssh-connection.ts'
/** Receives complete SSH pipe chunks before bounded command-result capture. */
export type CommandOutputSink = (stream: 'stdout' | 'stderr', chunk: string) => void

/** Deployment address and SSH identity selected by the trusted profile. */
export interface Target extends Partial<SshConnectionPolicy> {
  readonly host: string
  readonly sshPort: number
  readonly username?: string | undefined
  readonly authMode?: 'key' | 'password' | undefined
  readonly passwordRef?: string | undefined
  readonly knownHostsFile?: string | undefined
  readonly identityFile?: string | undefined
  readonly remotePort: number
  /** Configured maximum lifetime of an SSH command or SCP transfer in milliseconds. */
  readonly toolTimeoutMs: number
  /** Verified executable directories prepended for non-interactive SSH commands. */
  readonly pathEntries?: readonly string[]
}

/**
 * Quote deployment values for the POSIX shell on the remote target.
 * @param value - one shell argument.
 * @returns its single-quoted shell spelling.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Spawn one executable with bounded output and no local shell.
 * @param program - executable name.
 * @param args - exact argument vector.
 * @param timeoutMs - maximum process lifetime.
 * @param signal - aborts the process.
 * @returns bounded stdout after successful exit.
 */
export async function run(program: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<string> {
  const result = await runResult(program, args, timeoutMs, signal)
  if (result.exitCode !== 0 || result.timedOut || result.cancelled) {
    throw new Error(`${program} ${result.timedOut ? 'timed out' : result.cancelled ? 'was cancelled' : `exited ${result.exitCode}`}: ${result.stderr.slice(-4000)}`)
  }
  return result.stdout
}

async function runResult(program: string, args: readonly string[], timeoutMs: number, signal?: AbortSignal, output?: CommandOutputSink): Promise<CommandResult> {
  signal?.throwIfAborted()
  const child = spawn(program, [...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let errorOutput = ''
  let captureError: unknown
  const capture = (stream: 'stdout' | 'stderr', part: string) => {
    try { output?.(stream, part) } catch (error) { captureError = error; child.kill() }
  }
  const limit = 2_000_000
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (part: string) => { stdout = (stdout + part).slice(-limit); capture('stdout', part) })
  child.stderr.on('data', (part: string) => { errorOutput = (errorOutput + part).slice(-limit); capture('stderr', part) })
  let timedOut = false
  let cancelled = false
  const abort = () => { cancelled = true; child.kill() }
  signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { timedOut = true; child.kill() }, timeoutMs)
  try {
    const exit = await new Promise<{ exitCode: number | null; signal: string | null }>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', (exitCode, exitSignal) => { resolve({ exitCode, signal: exitSignal ?? null }) })
    })
    if (captureError !== undefined) throw captureError
    return { stdout, stderr: errorOutput, ...exit, timedOut, cancelled }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * Build OpenSSH options without an interactive password or unknown host key.
 * @param target - trusted target configuration.
 * @returns SSH argument prefix.
 */
export function sshOptions(target: Target): string[] {
  return [
    '-p', String(target.sshPort), '-o', 'BatchMode=yes',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
    ...target.knownHostsFile === undefined ? [] : ['-o', `UserKnownHostsFile=${target.knownHostsFile}`],
    ...target.identityFile === undefined ? [] : ['-i', target.identityFile],
  ]
}

/**
 * Execute a checked POSIX script on the configured target.
 * @param target - trusted target configuration.
 * @param script - remote shell program.
 * @param signal - aborts the SSH process.
 * @param password - operation-scoped password, resolved outside persisted target settings.
 * @returns remote stdout after successful exit.
 */
export async function remote(target: Target, script: string, signal?: AbortSignal, password?: string): Promise<string> {
  const result = await remoteResult(target, script, signal, password)
  signal?.throwIfAborted()
  if (result.exitCode !== 0 || result.timedOut || result.cancelled || !result.exitConfirmed) throw new RemoteCommandError(result)
  return result.stdout
}

/**
 * Execute through SSH without discarding nonzero-exit diagnostics.
 * @param target - saved account and verified executable directories.
 * @param script - remote POSIX shell program.
 * @param signal - operation cancellation.
 * @param password - private operation credential.
 * @param output - optional complete pipe capture; capture failure stops the command channel.
 * @returns captured outcome; connection and authentication failures reject.
 */
export async function remoteResult(target: Target, script: string, signal?: AbortSignal, password?: string, output?: CommandOutputSink): Promise<RemoteCommandResult> {
  const prefix = target.pathEntries?.length ? `export PATH=${shellQuote(target.pathEntries.join(':'))}:"$PATH"\n` : ''
  const command = `sh -c ${shellQuote(prefix + script)}`
  if (target.authMode === 'password') return passwordResult(target, password, command, signal, output)
  const marker = `ASPERA_EXIT_${randomUUID()}=`
  const checked = `${command}; status=$?; printf '\\n${marker}%s\\n' "$status" >&2`
  const result = await runResult('ssh', [...sshOptions(target), destination(target), checked], target.toolTimeoutMs, signal, output)
  const receipt = new RegExp(`\\n${marker}(\\d+)\\r?\\n$`).exec(result.stderr)
  if (receipt !== null) return { ...result, exitCode: Number(receipt[1]), stderr: result.stderr.slice(0, receipt.index), exitConfirmed: true }
  const unconfirmed = { ...result, exitCode: null, exitConfirmed: false }
  if (!result.timedOut && !result.cancelled) throw new SshConnectionError(unconfirmed)
  return unconfirmed
}

function destination(target: Target): string {
  return target.username === undefined ? target.host : `${target.username}@${target.host}`
}

/**
 * Copy a local file to an already-created directory on the target.
 * @param target - trusted target configuration.
 * @param localPath - source file.
 * @param remotePath - destination file.
 * @param signal - aborts SCP.
 * @param password - operation-scoped password.
 * @returns bounded SCP stdout after successful exit.
 */
export function copy(target: Target, localPath: string, remotePath: string, signal?: AbortSignal, password?: string): Promise<string> {
  if (target.authMode === 'password') return passwordCopy(target, password, localPath, remotePath, signal)
  const options = sshOptions(target)
  options[0] = '-P'
  return run('scp', [...options, localPath, `${destination(target)}:${remotePath}`], target.toolTimeoutMs, signal)
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as AddressInfo).port
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error === undefined) resolve()
    else reject(error)
  }))
  return port
}

/**
 * Send one authenticated HTTP request through a temporary SSH tunnel.
 * @param target - trusted target configuration.
 * @param token - receiver bearer credential.
 * @param path - receiver route.
 * @param method - HTTP method.
 * @param body - optional JSON request body.
 * @param signal - aborts the tunnel and request.
 * @param password - operation-scoped password.
 * @returns HTTP status and parsed JSON response.
 */
export async function request(
  target: Target,
  token: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
  password?: string,
): Promise<{ status: number; value: unknown }> {
  if (target.authMode === 'password') return passwordRequest(target, password, token, path, method, body, signal)
  signal?.throwIfAborted()
  const port = await freePort()
  signal?.throwIfAborted()
  const child = spawn('ssh', [
    ...sshOptions(target), '-o', 'ExitOnForwardFailure=yes',
    '-N', '-L', `127.0.0.1:${port}:127.0.0.1:${target.remotePort}`, destination(target),
  ], { windowsHide: true, stdio: 'ignore' })
  let startError: Error | undefined
  child.once('error', (error) => { startError = error })
  const closed = new Promise<void>(resolve => child.once('close', () => { resolve() }))
  try {
    const deadline = Date.now() + 15_000
    const timeout = AbortSignal.timeout(15_000)
    const requestSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    while (true) {
      requestSignal.throwIfAborted()
      if (startError !== undefined) throw startError
      try {
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...body === undefined ? {} : { 'content-type': 'application/json' },
          },
          ...body === undefined ? {} : { body: JSON.stringify(body) },
          signal: requestSignal,
        })
        const value: unknown = await response.json()
        return { status: response.status, value }
      } catch (error: unknown) {
        if (requestSignal.aborted || Date.now() >= deadline) throw error
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  } finally {
    child.kill()
    await closed
  }
}
