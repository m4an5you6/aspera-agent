import { generateKeyPairSync } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as httpServer } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ssh2 from 'ssh2'
import type { Connection } from 'ssh2'
import { expect, it, onTestFinished } from 'vitest'
import { copy, remote, request } from '../src/transport.ts'
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
          channel.exit(0)
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

it('refuses a revoked host key before sending the password', async () => {
  const f = await fixture()
  await writeFile(f.target.knownHostsFile!, `@revoked [127.0.0.1]:${f.target.sshPort} ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAAAQ==\n`)
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
