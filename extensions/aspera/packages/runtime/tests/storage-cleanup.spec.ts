/** Remote deletion shares the source-loan lock and transmits bounded helper arguments. */
import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import { placement } from '../../experiments/tests/fixtures.ts'
import { cleanupServerStorage } from '../src/storage.ts'
import { remote } from '../src/transport.ts'

vi.mock('../src/transport.ts', async original => ({ ...await original<typeof import('../src/transport.ts')>(), remote: vi.fn() }))

it('serializes source deletion with borrowing and releases references through a compressed program', async () => {
  vi.mocked(remote).mockResolvedValueOnce('{"cleaned":true}').mockResolvedValueOnce('{"released":true}')
  const selected = placement(serverIdSchema.parse(randomUUID()), experimentIdSchema.parse(randomUUID()), '/fixture/storage')
  await cleanupServerStorage({ host: 'fixture', sshPort: 22, remotePort: 43019, toolTimeoutMs: 1000 }, selected, [])
  const commands = vi.mocked(remote).mock.calls.map(call => call[1])
  expect(commands).toHaveLength(2)
  expect(commands[0]).toContain('controller-admission.lock'); expect(commands[0]).toContain('fcntl.LOCK_EX')
  expect(commands[1]).toContain('gzip.decompress')
  for (const command of commands) expect(Buffer.byteLength(command)).toBeLessThan(131072)
})
