import { expect, it } from 'vitest'
import { sshAddress, sshPasswordRef } from '../src/ssh-account.ts'

it('accepts separate usernames and legacy user@host without allowing conflicting accounts', () => {
  expect(sshAddress('ubuntu@gpu.example')).toEqual({ host: 'gpu.example', username: 'ubuntu' })
  expect(sshAddress('gpu.example', 'ubuntu')).toEqual({ host: 'gpu.example', username: 'ubuntu' })
  expect(() => sshAddress('root@gpu.example', 'ubuntu')).toThrow('matching login username')
})

it('selects distinct credentials for different servers, ports and users', () => {
  const account = { host: 'gpu.example', username: 'ubuntu', sshPort: 22 }
  const ref = sshPasswordRef(account)
  expect(sshPasswordRef({ ...account, host: 'GPU.EXAMPLE' })).toBe(ref)
  for (const changed of [{ host: 'other.example' }, { sshPort: 2222 }, { username: 'root' }]) {
    expect(sshPasswordRef({ ...account, ...changed })).not.toBe(ref)
  }
  expect(sshPasswordRef({ ...account, passwordRef: 'PROFILE_PASSWORD' })).toBe('PROFILE_PASSWORD')
})

it.each([
  { host: 'gpu.example', username: '', sshPort: 22 },
  { host: '-oProxyCommand=bad', username: 'root', sshPort: 22 },
  { host: 'gpu.example', username: 'root', sshPort: 65536 },
  { host: 'gpu.example', username: 'root', sshPort: 22, passwordRef: 'not a credential' },
])('rejects an incomplete or invalid password account: %j', (account) => {
  expect(() => sshPasswordRef(account)).toThrow()
})
