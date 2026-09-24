/** Non-interactive OpenSSH control and short-lived loopback tunnels. */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'

/** Deployment address and SSH identity selected by the trusted profile. */
export interface Target {
  readonly host: string
  readonly sshPort: number
  readonly identityFile?: string
  readonly remotePort: number
  /** Configured maximum lifetime of an SSH command or SCP transfer in milliseconds. */
  readonly toolTimeoutMs: number
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
  signal?.throwIfAborted()
  const child = spawn(program, [...args], { windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  let errorOutput = ''
  const limit = 2_000_000
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (part: string) => { output = (output + part).slice(-limit) })
  child.stderr.on('data', (part: string) => { errorOutput = (errorOutput + part).slice(-limit) })
  const timer = setTimeout(() => { child.kill() }, timeoutMs)
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', resolve)
    })
    if (code !== 0) throw new Error(`${program} exited ${String(code)}: ${errorOutput.slice(-4000)}`)
    return output
  } finally {
    clearTimeout(timer)
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
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=15',
    ...target.identityFile === undefined ? [] : ['-i', target.identityFile],
  ]
}

/**
 * Execute a checked POSIX script on the configured target.
 * @param target - trusted target configuration.
 * @param script - remote shell program.
 * @param signal - aborts the SSH process.
 * @returns remote stdout after successful exit.
 */
export function remote(target: Target, script: string, signal?: AbortSignal): Promise<string> {
  return run('ssh', [...sshOptions(target), target.host, `sh -c ${shellQuote(script)}`], target.toolTimeoutMs, signal)
}

/**
 * Copy a local file to an already-created directory on the target.
 * @param target - trusted target configuration.
 * @param localPath - source file.
 * @param remotePath - destination file.
 * @param signal - aborts SCP.
 * @returns bounded SCP stdout after successful exit.
 */
export function copy(target: Target, localPath: string, remotePath: string, signal?: AbortSignal): Promise<string> {
  const options = sshOptions(target)
  options[0] = '-P'
  return run('scp', [...options, localPath, `${target.host}:${remotePath}`], target.toolTimeoutMs, signal)
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
 * @returns HTTP status and parsed JSON response.
 */
export async function request(
  target: Target,
  token: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; value: unknown }> {
  signal?.throwIfAborted()
  const port = await freePort()
  signal?.throwIfAborted()
  const child = spawn('ssh', [
    ...sshOptions(target), '-o', 'ExitOnForwardFailure=yes',
    '-N', '-L', `127.0.0.1:${port}:127.0.0.1:${target.remotePort}`, target.host,
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
        return { status: response.status, value: await response.json() as unknown }
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
