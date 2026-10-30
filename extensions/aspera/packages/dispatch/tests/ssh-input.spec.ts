/** Real SSH channels and child pipes carry large requests without placing them in argv. */
import { execFile, spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ssh2 from 'ssh2'
import type { Connection } from 'ssh2'
import { expect, it, onTestFinished } from 'vitest'
import { remote, remoteResult } from '../src/transport.ts'
import type { Target } from '../src/transport.ts'

async function fixture(authMode: 'key' | 'password') {
  const directory = await mkdtemp(join(tmpdir(), 'aspera-ssh-input-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const key = ssh2.utils.parseKey(privateKey)
  if (key instanceof Error) throw key
  const connections = new Set<Connection>()
  const closed: Promise<void>[] = []
  const commands: string[] = []
  const processes: ReturnType<typeof spawn>[] = []
  const received = Promise.withResolvers<void>()
  const server = new ssh2.Server({ hostKeys: [privateKey] }, client => {
    connections.add(client)
    closed.push(new Promise<void>(resolve => client.once('close', () => { connections.delete(client); resolve() })))
    client.on('error', () => {}) // Cancellation deliberately closes authenticated channels.
    client.on('authentication', auth => {
      if (auth.username === 'fixture' && (auth.method === 'password' && auth.password === 'fixture-password'
        || auth.method === 'publickey' && auth.key.data.equals(key.getPublicSSH())
          && (auth.signature === undefined || key.verify(auth.blob!, auth.signature, auth.hashAlgo)))) auth.accept()
      else auth.reject(['publickey', 'password'])
    })
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('exec', (acceptCommand, _reject, info) => {
        const channel = acceptCommand()
        commands.push(info.command)
        const marker = /ASPERA_EXIT_[a-f0-9-]+=/.exec(info.command)?.[0]
        if (info.command.includes('early-input')) {
          channel.stderr.write('helper failed before reading input')
          if (marker !== undefined) channel.stderr.write(`\n${marker}7\n`)
          channel.exit(authMode === 'key' ? 0 : 7); channel.end(); return
        }
        const code = info.command.includes('fail-input') ? 7 : 0
        const child = spawn(process.execPath, ['-e', `
const {createHash}=require('node:crypto');let input='';process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{input+=chunk});process.stdin.on('end',()=>{
const parsed=JSON.parse(input);process.stdout.write(JSON.stringify({bytes:Buffer.byteLength(input),hash:createHash('sha256').update(input).digest('hex'),text:parsed.text}));
process.stderr.write('original diagnostic');process.exitCode=${code}})`], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        processes.push(child)
        const exited = new Promise<void>(resolve => child.once('close', exit => {
          if (!channel.destroyed) {
            if (marker !== undefined) channel.stderr.write(`\n${marker}${exit}\n`)
            channel.exit(authMode === 'key' ? 0 : exit ?? 255)
            channel.end()
          }
          resolve()
        }))
        closed.push(exited)
        child.once('error', error => { channel.stderr.write(String(error)); channel.exit(1); channel.end() })
        child.stdin.on('error', () => {}) // The peer can exit while its input pipe is still being drained.
        child.stdout.pipe(channel, { end: false }); child.stderr.pipe(channel.stderr, { end: false })
        channel.on('data', (chunk: Buffer) => {
          received.resolve()
          if (info.command.includes('disconnect-input')) { client.end(); return }
          if (!info.command.includes('hold-input')) child.stdin.write(chunk)
        })
        channel.on('end', () => { if (!info.command.includes('hold-input')) child.stdin.end() })
        channel.once('close', () => { if (child.exitCode === null) child.kill() })
      })
    }))
  })
  onTestFinished(async () => {
    for (const client of connections) client.end()
    for (const child of processes) if (child.exitCode === null) child.kill()
    await Promise.all([...closed, new Promise<void>(resolve => server.close(() => { resolve() }))])
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('SSH fixture has no address')
  const knownHostsFile = join(directory, 'known_hosts'); const identityFile = join(directory, 'identity')
  await writeFile(knownHostsFile, `[127.0.0.1]:${address.port} ${key.type} ${key.getPublicSSH().toString('base64')}\n`)
  await writeFile(identityFile, privateKey, { mode: 0o600 })
  if (process.platform === 'win32') {
    const { stdout } = await promisify(execFile)('whoami', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true })
    const sid = /S-[0-9-]+/.exec(stdout)?.[0]
    if (sid === undefined) throw new Error('Windows key fixture cannot identify its file owner')
    await promisify(execFile)('icacls', [identityFile, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true })
  }
  const target: Target = { host: '127.0.0.1', sshPort: address.port, username: 'fixture', remotePort: 43019,
    authMode, knownHostsFile, identityFile, toolTimeoutMs: 15000 }
  return { target, commands, received: received.promise }
}

it.each(['key', 'password'] as const)('streams a large UTF-8 request and EOF over %s SSH through a real child', async mode => {
  const f = await fixture(mode)
  const input = JSON.stringify({ text: '中文、引号\'与换行\n', padding: 'x'.repeat(1024 * 1024) })
  const result = JSON.parse(await remote(f.target, 'read-input', undefined, 'fixture-password', input))
  expect(result).toEqual({ bytes: Buffer.byteLength(input), hash: createHash('sha256').update(input).digest('hex'), text: JSON.parse(input).text })
  expect(f.commands).toHaveLength(1); expect(Buffer.byteLength(f.commands[0]!)).toBeLessThan(4096)
  expect(f.commands[0]).not.toContain('padding')
})

it.each(['key', 'password'] as const)('preserves a nonzero %s exit after receiving input', async mode => {
  const f = await fixture(mode)
  const result = await remoteResult(f.target, 'fail-input', undefined, 'fixture-password', undefined, '{"text":"失败"}')
  expect(result).toMatchObject({ exitCode: 7, exitConfirmed: true, stderr: 'original diagnostic', timedOut: false, cancelled: false })
})

it.each(['key', 'password'] as const)('retains an early %s helper failure while a large input is pending', async mode => {
  const f = await fixture(mode)
  const result = await remoteResult(f.target, 'early-input', undefined, 'fixture-password', undefined, 'x'.repeat(2 * 1024 * 1024))
  expect(result).toMatchObject({ exitCode: 7, exitConfirmed: true, stderr: 'helper failed before reading input' })
  expect(f.commands).toHaveLength(1)
})

it.each(['key', 'password'] as const)('retains an unconfirmed %s outcome after an input operation timeout', async mode => {
  const f = await fixture(mode)
  const result = await remoteResult({ ...f.target, toolTimeoutMs: 2000 }, 'hold-input', undefined, 'fixture-password', undefined, '{"text":"hold"}')
  expect(result).toMatchObject({ timedOut: true, cancelled: false, exitConfirmed: false })
  expect(f.commands).toHaveLength(1)
})

it.each(['key', 'password'] as const)('cancels an authenticated %s input operation without replaying it', async mode => {
  const f = await fixture(mode); const controller = new AbortController()
  const pending = remoteResult(f.target, 'hold-input', controller.signal, 'fixture-password', undefined, '{"text":"hold"}')
  const settled = Promise.allSettled([pending])
  await Promise.race([f.received, pending.then(() => { throw new Error('Command ended before receiving input') })]); controller.abort()
  expect((await settled)[0]).toMatchObject({ status: 'fulfilled', value: { cancelled: true, exitConfirmed: false } })
  expect(f.commands).toHaveLength(1)
})

it.each(['key', 'password'] as const)('does not replay %s requests after a disconnect during input', async mode => {
  const f = await fixture(mode)
  await expect(remoteResult(f.target, 'disconnect-input', undefined, 'fixture-password', undefined, 'x'.repeat(1024 * 1024)))
    .rejects.toMatchObject({ name: 'SshConnectionError', result: { exitConfirmed: false } })
  expect(f.commands).toHaveLength(1)
})
