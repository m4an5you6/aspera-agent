/** Password-only SSH commands, SFTP uploads and receiver channels with host-key verification. */
import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import ssh2 from 'ssh2'
import type { Client, ClientChannel, SFTPWrapper, ServerHostKeyAlgorithm } from 'ssh2'
import type { Target } from './transport.ts'

const exec = promisify(execFile)

async function hostKeys(target: Target, signal: AbortSignal): Promise<{ keys: Set<string>; algorithms: ServerHostKeyAlgorithm[] }> {
  const file = target.knownHostsFile ?? join(homedir(), '.ssh', 'known_hosts')
  const lookup = target.sshPort === 22 ? target.host : `[${target.host}]:${target.sshPort}`
  let output: string
  try {
    const result = await exec('ssh-keygen', ['-F', lookup, '-f', file], { windowsHide: true, signal })
    output = result.stdout
  } catch (error: unknown) {
    signal.throwIfAborted()
    throw new Error(`SSH host key is unavailable in ${file}; verify this server with OpenSSH before dispatching`, { cause: error })
  }
  const keys = new Set<string>()
  const algorithms = new Set<ServerHostKeyAlgorithm>()
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('#') || line.trim() === '') continue
    const fields = line.trim().split(/\s+/)
    if (fields[0] === '@revoked') throw new Error('SSH host key is revoked in known_hosts')
    // Certificate authorities require certificate verification, which this transport does not implement.
    if (fields[0]?.startsWith('@')) continue
    if (fields[2] !== undefined) keys.add(fields[2])
    switch (fields[1]) {
      case 'ssh-rsa':
        algorithms.add('rsa-sha2-512'); algorithms.add('rsa-sha2-256'); algorithms.add('ssh-rsa')
        break
      case 'ssh-ed25519': case 'ecdsa-sha2-nistp256': case 'ecdsa-sha2-nistp384': case 'ecdsa-sha2-nistp521':
        algorithms.add(fields[1])
        break
      default: break // Unsupported key algorithms cannot authorize this connection.
    }
  }
  if (keys.size === 0 || algorithms.size === 0) throw new Error('SSH requires a verified server key in known_hosts')
  return { keys, algorithms: [...algorithms] }
}

async function withPassword<T>(
  target: Target, password: string | undefined, timeoutMs: number, signal: AbortSignal | undefined,
  operation: (client: Client, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted()
  if (password === undefined || password === '' || target.username === undefined) {
    throw new Error('SSH password login requires a username and a saved password')
  }
  const timeout = AbortSignal.timeout(timeoutMs)
  const lifetime = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
  const { keys, algorithms } = await hostKeys(target, lifetime)
  lifetime.throwIfAborted()
  const client = new ssh2.Client()
  let rejectedKey = false
  let started = false
  const closed = new Promise<void>(resolve => client.once('close', () => { resolve() }))
  let abort = () => {}
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => { reject(lifetime.reason instanceof Error ? lifetime.reason : new Error('SSH operation cancelled')) }
    lifetime.addEventListener('abort', abort, { once: true })
    client.on('error', (error: Error & { level?: string }) => {
      reject(new Error(rejectedKey ? 'SSH server key does not match known_hosts'
        : error.level === 'client-authentication'
          ? 'SSH password login failed; check the username, password and server password-login policy'
          : `SSH connection failed: ${error.message}`))
    })
    client.once('close', () => { reject(new Error('SSH connection closed before the operation completed')) })
  })
  const ready = new Promise<void>(resolve => client.once('ready', () => { resolve() }))
  try {
    client.connect({
      host: target.host, port: target.sshPort, username: target.username, password,
      authHandler: ['password'], tryKeyboard: false, readyTimeout: Math.min(timeoutMs, 15_000),
      algorithms: { serverHostKey: algorithms },
      hostVerifier: (key: Buffer) => {
        const trusted = keys.has(key.toString('base64'))
        rejectedKey = !trusted
        return trusted
      },
    })
    started = true
    await Promise.race([ready, stopped])
    return await Promise.race([operation(client, lifetime), stopped])
  } finally {
    lifetime.removeEventListener('abort', abort)
    client.destroy()
    if (started) await closed
  }
}

/**
 * Run a command using only the selected account password.
 * @param target - SSH address and host-key settings.
 * @param password - password resolved for this operation.
 * @param command - complete remote shell command.
 * @param signal - cancels connection and command execution.
 * @returns bounded stdout after a zero exit status.
 */
export function passwordRemote(target: Target, password: string | undefined, command: string, signal?: AbortSignal): Promise<string> {
  return withPassword(target, password, target.toolTimeoutMs, signal, client => new Promise<string>((resolve, reject) => {
    client.exec(command, (error, channel) => {
      if (error !== undefined) { reject(error); return }
      let stdout = ''
      let stderr = ''
      channel.setEncoding('utf8')
      channel.stderr.setEncoding('utf8')
      channel.on('data', (part: string) => { stdout = (stdout + part).slice(-2_000_000) })
      channel.stderr.on('data', (part: string) => { stderr = (stderr + part).slice(-4000) })
      channel.once('error', reject)
      channel.once('close', (code: number | undefined) => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`SSH command exited ${String(code)}: ${stderr}`))
      })
    })
  }))
}

/**
 * Upload a private file through an authenticated SFTP channel.
 * @param target - SSH address and host-key settings.
 * @param password - password resolved for this operation.
 * @param localPath - source file on the DSH host.
 * @param remotePath - destination in an existing remote directory.
 * @param signal - cancels the connection and transfer.
 * @returns an empty output after the transfer finishes.
 */
export function passwordCopy(
  target: Target, password: string | undefined, localPath: string, remotePath: string, signal?: AbortSignal,
): Promise<string> {
  return withPassword(target, password, target.toolTimeoutMs, signal, async (client, lifetime) => {
    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((error, channel) => {
        if (error !== undefined) reject(error)
        else resolve(channel)
      })
    })
    try {
      await pipeline(createReadStream(localPath), sftp.createWriteStream(remotePath, { mode: 0o600 }), { signal: lifetime })
      return ''
    } finally {
      sftp.end()
    }
  })
}

function receiverRequest(
  channel: ClientChannel, target: Target, token: string, path: string, method: string, body: unknown, signal: AbortSignal,
): Promise<{ status: number; value: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const request = httpRequest({
      hostname: '127.0.0.1', port: target.remotePort, path, method, signal,
      createConnection: () => channel,
      headers: {
        authorization: `Bearer ${token}`,
        ...payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
    }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (part: string) => {
        text += part
        if (text.length > 2_000_000) request.destroy(new Error('Receiver response exceeds the supported size'))
      })
      response.once('error', reject)
      response.once('end', () => {
        try { const value: unknown = JSON.parse(text); resolve({ status: response.statusCode ?? 0, value }) }
        catch (error: unknown) { reject(new Error('Receiver response is not valid JSON', { cause: error })) }
      })
    })
    channel.once('error', (error: Error) => request.destroy(error))
    request.once('error', reject)
    request.end(payload)
  })
}

/**
 * Reach the loopback receiver over a password-authenticated SSH channel.
 * @param target - SSH address and receiver port.
 * @param password - password resolved for this operation.
 * @param token - receiver credential.
 * @param path - receiver route.
 * @param method - HTTP method.
 * @param body - optional JSON body.
 * @param signal - cancels SSH and HTTP together.
 * @returns HTTP status and decoded JSON.
 */
export function passwordRequest(
  target: Target, password: string | undefined, token: string, path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal,
): Promise<{ status: number; value: unknown }> {
  return withPassword(target, password, Math.min(target.toolTimeoutMs, 15_000), signal, (client, lifetime) =>
    new Promise((resolve, reject) => {
      client.forwardOut('127.0.0.1', 0, '127.0.0.1', target.remotePort, (error, channel) => {
        if (error !== undefined) { reject(error); return }
        void receiverRequest(channel, target, token, path, method, body, lifetime).then(resolve, reject)
      })
    }))
}
