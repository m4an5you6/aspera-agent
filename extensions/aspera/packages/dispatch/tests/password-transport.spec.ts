import { generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createServer as httpServer } from 'node:http'
import { connect, createServer as tcpServer } from 'node:net'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ssh2 from 'ssh2'
import type { Connection } from 'ssh2'
import { expect, it, onTestFinished } from 'vitest'
import { copy, remote, remoteResult, request, prepareSshHostKey } from '../src/transport.ts'
import type { Target } from '../src/transport.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-password-ssh-'))
  const password = '  p a$$\\"word\'密碼  '
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const parsed = ssh2.utils.parseKey(privateKey)
  if (parsed instanceof Error) throw parsed
  const key = parsed
  const clients = new Set<Connection>()
  const closed: Promise<void>[] = []
  const methods: string[] = []
  const commands: string[] = []
  const uploaded: Buffer[] = []
  const requests: { path: string | undefined; auth: string | undefined; body: string }[] = []
  let notifyCommand = () => {}
  const commandStarted = new Promise<void>((resolve) => { notifyCommand = resolve })
  const receiver = httpServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      requests.push({ path: req.url, auth: req.headers.authorization, body })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ready: true }))
    })
  })
  const server = new ssh2.Server({ hostKeys: [privateKey] }, (client) => {
    clients.add(client)
    closed.push(new Promise<void>(resolve => client.once('close', () => { clients.delete(client); resolve() })))
    // Rejected host keys and aborted clients intentionally terminate the handshake.
    client.on('error', () => {})
    client.on('authentication', (auth) => {
      methods.push(auth.method)
      if (auth.method === 'password' && auth.username === 'ubuntu' && auth.password === password) auth.accept()
      else auth.reject(['password'])
    })
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()
        session.on('exec', (accept, _reject, info) => {
          const channel = accept()
          commands.push(info.command)
          notifyCommand()
          if (info.command.includes('hold')) return
          channel.write('remote output')
          if (info.command.includes('fixture-fail')) channel.stderr.write('package download failed')
          channel.exit(info.command.includes('fixture-fail') ? 7 : 0)
          channel.end()
        })
        session.on('sftp', (accept) => {
          const sftp = accept()
          sftp.on('OPEN', (id, _path, _flags, attrs) => {
            expect(attrs.mode & 0o777).toBe(0o600)
            sftp.handle(id, Buffer.from('file'))
          })
          sftp.on('WRITE', (id, _handle, _offset, data) => { uploaded.push(Buffer.from(data)); sftp.status(id, 0) })
          sftp.on('CLOSE', (id) => { sftp.status(id, 0) })
        })
      })
      client.on('tcpip', (accept, _reject, info) => {
        const channel = accept()
        const socket = connect(info.destPort, info.destIP)
        socket.once('error', () => channel.destroy())
        channel.once('error', () => socket.destroy())
        channel.once('close', () => socket.destroy())
        socket.pipe(channel).pipe(socket)
      })
    })
  })
  onTestFinished(async () => {
    for (const client of clients) client.end()
    receiver.closeAllConnections()
    await Promise.all([
      ...closed,
      new Promise<void>(resolve => server.close(() => { resolve() })),
      new Promise<void>(resolve => receiver.close(() => { resolve() })),
    ])
    await rm(root, { recursive: true, force: true })
  })
  await Promise.all([
    new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)),
    new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve)),
  ])
  const sshAddress = server.address()
  const httpAddress = receiver.address()
  if (sshAddress === null || typeof sshAddress === 'string' || httpAddress === null || typeof httpAddress === 'string') throw new Error('Missing test listener address')
  const knownHostsFile = join(root, 'known_hosts')
  await writeFile(knownHostsFile, `[127.0.0.1]:${sshAddress.port} ${key.type} ${key.getPublicSSH().toString('base64')}\n`)
  const target: Target = {
    host: '127.0.0.1', username: 'ubuntu', sshPort: sshAddress.port, remotePort: httpAddress.port,
    authMode: 'password', identityFile: join(root, 'unused-key'), knownHostsFile, toolTimeoutMs: 10_000,
  }
  return { root, target, password, methods, commands, uploaded, requests, commandStarted }
}

it('uses the exact password for commands without trying a saved key', async () => {
  const f = await fixture()
  expect(await remote(f.target, 'echo ready', undefined, f.password)).toBe('remote output')
  expect(f.methods).toEqual(['password'])
  expect(f.commands).toEqual(["sh -c 'echo ready'"])
})

it('uploads private files over password-authenticated SFTP', async () => {
  const f = await fixture()
  const file = join(f.root, 'source.tar')
  await writeFile(file, 'private upload')
  await copy(f.target, file, '/worker/source.tar', undefined, f.password)
  expect(Buffer.concat(f.uploaded).toString()).toBe('private upload')
  expect(f.methods).toEqual(['password'])
})

it('sends authenticated JSON directly through the SSH receiver channel', async () => {
  const f = await fixture()
  expect(await request(f.target, 'receiver-token', '/experiment/v1/submit', 'POST', { objective: 'train' }, undefined, f.password))
    .toEqual({ status: 200, value: { ready: true } })
  expect(f.requests).toEqual([{ path: '/experiment/v1/submit', auth: 'Bearer receiver-token', body: '{"objective":"train"}' }])
  expect(f.methods).toEqual(['password'])
})

it('rejects a wrong password without falling back to keys or exposing its value', async () => {
  const f = await fixture()
  await expect(remote(f.target, 'echo ready', undefined, 'wrong-secret')).rejects.toThrow('SSH password login failed')
  expect(f.methods).toEqual(['password'])
  expect(f.commands).toEqual([])
})

it('rejects a changed host key before sending the password', async () => {
  const f = await fixture()
  await writeFile(f.target.knownHostsFile!, `[127.0.0.1]:${f.target.sshPort} ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAAQ==\n`)
  await expect(remote(f.target, 'echo ready', undefined, f.password)).rejects.toThrow('does not match known_hosts')
  expect(f.methods).toEqual([])
})

it('rejects an unknown server before opening a connection', async () => {
  const f = await fixture()
  await writeFile(f.target.knownHostsFile!, '')
  await expect(remote(f.target, 'echo ready', undefined, f.password)).rejects.toThrow('verify this server with OpenSSH')
  expect(f.methods).toEqual([])
})

it('accepts a hashed known_hosts entry on a nondefault SSH port', async () => {
  const f = await fixture()
  await promisify(execFile)('ssh-keygen', ['-H', '-f', f.target.knownHostsFile!], { windowsHide: true })
  await expect(remote(f.target, 'echo ready', undefined, f.password)).resolves.toBe('remote output')
})

it('registers a first-use server without sending a password and then uses the registered key for login', async () => {
  const f = await fixture()
  const target = { ...f.target, knownHostsFile: join(f.root, 'new-trust', 'known_hosts') }
  await prepareSshHostKey(target)
  expect(f.methods).toEqual([])
  expect(f.commands).toEqual([])
  expect(await remote(target, 'echo ready', undefined, f.password)).toBe('remote output')
  expect(f.methods).toEqual(['password'])
})

it('discovers a first-use server without the native keyscan command', async () => {
  const f = await fixture()
  const previousPath = process.env.PATH
  const restorePath = () => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  }
  onTestFinished(restorePath)
  process.env.PATH = ''
  const target = { ...f.target, knownHostsFile: join(f.root, 'keyscan-independent', 'known_hosts') }
  try {
    await prepareSshHostKey(target)
    expect(await readFile(target.knownHostsFile, 'utf8')).toContain(`[127.0.0.1]:${target.sshPort} ssh-rsa `)
    expect(f.methods).toEqual([])
    expect(f.commands).toEqual([])
  } finally { restorePath() }
})

it('preserves both server identities when first-use registrations share a host-key file', async () => {
  const [first, second] = await Promise.all([fixture(), fixture()])
  const knownHostsFile = join(first.root, 'shared', 'known_hosts')
  const a = { ...first.target, knownHostsFile }
  const b = { ...second.target, knownHostsFile }
  await Promise.all([prepareSshHostKey(a), prepareSshHostKey(a), prepareSshHostKey(b)])
  expect(first.methods).toEqual([])
  expect(second.methods).toEqual([])
  expect(await Promise.all([remote(a, 'echo ready', undefined, first.password), remote(b, 'echo ready', undefined, second.password)]))
    .toEqual(['remote output', 'remote output'])
})

it('does not replace a registered host key when the server presents a different key', async () => {
  const f = await fixture()
  await writeFile(f.target.knownHostsFile!, `[127.0.0.1]:${f.target.sshPort} ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAAQ==\n`)
  await prepareSshHostKey(f.target)
  await expect(remote(f.target, 'echo ready', undefined, f.password)).rejects.toThrow('does not match known_hosts')
  expect(f.methods).toEqual([])
  expect((await promisify(execFile)('ssh-keygen', ['-F', `[127.0.0.1]:${f.target.sshPort}`, '-f', f.target.knownHostsFile!])).stdout)
    .toContain('AAAAB3NzaC1yc2EAAAADAQABAAAAAQ==')
})

it.each(['cancelled', 'timed out'] as const)('stops %s first-use discovery without leaving a trusted host entry', async status => {
  const f = await fixture()
  const connected = Promise.withResolvers<void>()
  const sockets = new Set<Socket>()
  const closed: Promise<void>[] = []
  const server = tcpServer(socket => {
    sockets.add(socket)
    closed.push(new Promise<void>(resolve => socket.once('close', () => { sockets.delete(socket); resolve() })))
    socket.on('error', () => {}) // Cancelled keyscan clients can reset their TCP connection.
    connected.resolve()
  })
  onTestFinished(async () => {
    for (const socket of sockets) socket.destroy()
    await Promise.all([...closed, new Promise<void>(resolve => server.close(() => { resolve() }))])
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing discovery listener address')
  const knownHostsFile = join(f.root, 'cancelled-trust', 'known_hosts')
  const controller = new AbortController()
  const pending = prepareSshHostKey({ ...f.target, sshPort: address.port, knownHostsFile, toolTimeoutMs: 5000 }, controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'SshConnectionError', result: {
    stderr: expect.stringContaining(`SSH host-key discovery ${status === 'cancelled' ? 'was cancelled' : status} for [127.0.0.1]:${address.port}`),
    cancelled: status === 'cancelled', timedOut: status === 'timed out', exitConfirmed: false } })
  await connected.promise
  if (status === 'cancelled') controller.abort()
  await rejected
  await expect(readFile(knownHostsFile)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.methods).toEqual([])
})

it('refuses a revoked host key before sending the password', async () => {
  const f = await fixture()
  await writeFile(f.target.knownHostsFile!, `@revoked [127.0.0.1]:${f.target.sshPort} ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAAQ==\n`)
  await expect(prepareSshHostKey(f.target)).rejects.toThrow('revoked')
  await expect(remote(f.target, 'echo ready', undefined, f.password)).rejects.toThrow('revoked')
  expect(f.methods).toEqual([])
})

it('cancels a running remote command and closes its SSH connection', async () => {
  const f = await fixture()
  const controller = new AbortController()
  const pending = remote(f.target, 'hold', controller.signal, f.password)
  const settled = Promise.allSettled([pending])
  await f.commandStarted
  controller.abort(new Error('cancelled by user'))
  expect((await settled)[0]).toMatchObject({ status: 'rejected', reason: { message: 'cancelled by user' } })
})

it('bounds a stalled password-authenticated command by the configured timeout', async () => {
  const f = await fixture()
  await expect(remote({ ...f.target, toolTimeoutMs: 1500 }, 'hold', undefined, f.password)).rejects.toMatchObject({ name: 'TimeoutError' })
})

it('returns stdout, stderr and the remote nonzero status through password SSH', async () => {
  const f = await fixture()
  const result = await remoteResult(f.target, 'fixture-fail', undefined, f.password)
  expect(result).toMatchObject({ stdout: 'remote output', stderr: 'package download failed', exitCode: 7,
    timedOut: false, cancelled: false, exitConfirmed: true })
})

it('marks an interrupted SSH command as unconfirmed instead of treating the disconnect as remote exit', async () => {
  const f = await fixture()
  const abort = new AbortController()
  const pending = remoteResult(f.target, 'hold', abort.signal, f.password)
  await f.commandStarted
  abort.abort()
  expect(await pending).toMatchObject({ cancelled: true, timedOut: false, exitConfirmed: false, exitCode: null })
})
