/** Loopback SSH fixture for preparation replay; the first two connections end before authentication. */
import { generateKeyPairSync } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect, createServer } from 'node:net'
import { resolve } from 'node:path'
import { remoteResult } from '../../packages/runtime/lib/transport.js'

const require = createRequire(new URL('../../packages/runtime/package.json', import.meta.url))
const ssh2 = require('ssh2')

/** Create owned listeners and a private trust file; close joins every accepted connection. */
export async function createHandshakeFixture(root) {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const key = ssh2.utils.parseKey(privateKey)
  if (key instanceof Error) throw key
  const password = 'cpu-only-handshake-password'
  const sockets = new Set()
  const clients = new Set()
  const closed = []
  let connectionAttempts = 0
  let commandCount = 0
  const own = socket => {
    sockets.add(socket)
    closed.push(new Promise(resolve => socket.once('close', () => { sockets.delete(socket); resolve() })))
    socket.on('error', () => {}) // The fixture intentionally resets unauthenticated connections.
  }
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    clients.add(client)
    closed.push(new Promise(resolve => client.once('close', () => { clients.delete(client); resolve() })))
    client.on('error', () => {}) // Interrupted clients are joined by close().
    client.on('authentication', auth => {
      if (auth.method === 'password' && auth.username === 'fixture' && auth.password === password) auth.accept()
      else auth.reject(['password'])
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('exec', accept => {
        commandCount++
        const channel = accept()
        channel.write('CPU SSH readiness checked')
        channel.exit(0)
        channel.end()
      })
    }))
  })
  let sshPort
  const proxy = createServer(socket => {
    own(socket)
    connectionAttempts++
    if (connectionAttempts <= 2) { socket.destroy(); return }
    const upstream = connect(sshPort, '127.0.0.1')
    own(upstream)
    socket.once('close', () => upstream.destroy())
    upstream.once('close', () => socket.destroy())
    socket.pipe(upstream).pipe(socket)
  })
  const close = async () => {
    for (const socket of sockets) socket.destroy()
    for (const client of clients) client.end()
    await Promise.all([...closed, ...[proxy, server].filter(listener => listener.listening)
      .map(listener => new Promise(resolve => listener.close(() => resolve())))])
  }
  try {
    await Promise.all([server, proxy].map(listener => new Promise((resolve, reject) => {
      listener.once('error', reject)
      listener.listen(0, '127.0.0.1', resolve)
    })))
    sshPort = server.address().port
    const port = proxy.address().port
    const knownHostsFile = resolve(root, 'handshake-known-hosts')
    writeFileSync(knownHostsFile, `[127.0.0.1]:${port} ${key.type} ${key.getPublicSSH().toString('base64')}\n`, { mode: 0o600 })
    return { close, facts: () => ({ connectionAttempts, commandCount }), probe: async (policy, signal) => {
      const result = await remoteResult({ ...policy, host: '127.0.0.1', sshPort: port, username: 'fixture',
        authMode: 'password', knownHostsFile, toolTimeoutMs: 20000 }, 'printf CPU_SSH_READINESS', signal, password)
      if (!result.exitConfirmed || result.exitCode !== 0) throw new Error('CPU handshake fixture did not confirm command completion')
    } }
  } catch (error) { await close(); throw error }
}
