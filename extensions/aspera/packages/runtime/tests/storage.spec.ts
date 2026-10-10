/** Storage observations use a synthetic Linux mount table over real isolated CPU files. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, existsSync, symlinkSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, serverSettingsSchema } from '@aspera/experiments'
import { resolveStoragePlacement } from '../src/storage.ts'
import { inspectStorage, parseMounts, prepareStorage, verifyStorage, cleanupStorage } from '../scripts/storage.mjs'

const fixture = vi.hoisted(() => ({ home: '', mounts: '', available: 10_000_000n }))
vi.mock('node:os', async importOriginal => ({ ...await importOriginal<typeof import('node:os')>(), homedir: () => fixture.home,
  networkInterfaces: () => ({ eth0: [{ internal: false, address: '10.0.0.2', family: 'IPv4' }],
    lo: [{ internal: true, address: '127.0.0.1', family: 'IPv4' }] }) }))
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => String(args[0]) === '/proc/self/mountinfo' ? fixture.mounts : fs.readFileSync(...args),
    realpathSync: (path: string) => path === fixture.home ? path : fs.realpathSync(path),
    statfsSync: () => ({ bavail: fixture.available, blocks: 20_000_000n, bsize: 4096n }),
  }
})
let directory: string
beforeEach(() => {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  directory = mkdtempSync(resolve('.artifacts', 'storage-'))
  fixture.home = (process.platform === 'win32' ? directory.slice(2) : directory).replaceAll('\\', '/')
  mkdirSync(resolve(directory, 'data'))
  fixture.available = 10_000_000n
  fixture.mounts = `1 0 8:1 / / rw - ext4 /dev/system rw\n2 1 8:2 / ${fixture.home}/data rw - ext4 /dev/data rw\n`
})
afterEach(() => { rmSync(directory, { recursive: true, force: true }) })

function selection(manual = false, legacy = false) {
  const server = serverSettingsSchema.parse({ id: randomUUID(), name: 'CPU storage', host: 'cpu', username: 'trainer', sshPort: 22,
    remotePort: 43019, authMode: 'password', ...(legacy ? { remoteRoot: fixture.home + '/data' }
      : { storagePreference: manual ? { mode: 'manual', directory: fixture.home + '/data/custom' } : { mode: 'auto' } }) })
  const observed = inspectStorage(manual ? { directory: fixture.home + '/data/custom' } : {})
  const candidate = observed.candidates.find(value => value.directory === fixture.home + '/data' + (manual ? '/custom' : ''))!
  return { server, observed, candidate, placement: resolveStoragePlacement(server, experimentIdSchema.parse(randomUUID()), 'a'.repeat(64), observed, candidate.id, 'Sufficient data disk', 1024) }
}

it('reports data and system disks with unknown durability, and excludes loopback networking', () => {
  const { observed, candidate } = selection()
  expect(candidate).toMatchObject({ writable: true, systemVolume: false, persistence: 'unknown', mount: { source: '/dev/data' } })
  expect(observed.candidates.find(value => value.directory === fixture.home)?.systemVolume).toBe(true)
  expect(observed.addresses).toEqual([{ address: '10.0.0.2', interface: 'eth0', family: 'IPv4', private: true }])
  expect(parseMounts('8 1 8:2 / /data\\040disk ro - ext4 /dev/data ro')[0]).toMatchObject({ mountPoint: '/data disk', readOnly: true })
})
it('allows a sufficient system disk without claiming persistence', () => {
  fixture.mounts = '1 0 8:1 / / rw - ext4 /dev/system rw\n'
  const { observed, candidate } = selection(true)
  expect(candidate.systemVolume).toBe(true)
  expect(observed.candidates.every(value => value.persistence === 'unknown')).toBe(true)
})
it('creates separate private control and data directories and reuses the recorded ownership', () => {
  const { placement } = selection()
  prepareStorage(placement); prepareStorage(placement)
  expect(readFileSync(resolve(placement.runRoot, '.aspera-owner.json'), 'utf8')).toContain(placement.experimentId)
  expect(placement.workspaceRoot).toContain('/data/.aspera/')
  expect(placement.controlRoot).toContain('/.local/share/aspera/')
  expect(() => prepareStorage({ ...placement, serverId: serverSettingsSchema.shape.id.parse(randomUUID()) })).toThrow('belong')
})
it('resolves manual directories and preserves legacy explicit layouts', () => {
  const manual = selection(true); prepareStorage(manual.placement)
  expect(manual.placement.namespaceRoot).toContain('/data/custom/.aspera/')
  const legacy = selection(false, true)
  writeFileSync(resolve(legacy.placement.namespaceRoot, 'existing-user-file'), 'retain')
  prepareStorage(legacy.placement)
  expect(legacy.placement.layout).toBe('legacy')
  expect(readFileSync(resolve(legacy.placement.namespaceRoot, 'existing-user-file'), 'utf8')).toBe('retain')
})
it('refuses a changed mount, read-only filesystem and insufficient capacity without choosing a replacement', () => {
  const { placement } = selection()
  fixture.mounts = fixture.mounts.replace('8:2', '8:3')
  expect(() => prepareStorage(placement)).toThrow('mount changed')
  fixture.mounts = fixture.mounts.replace('8:3', '8:2').replace('/data rw', '/data ro')
  expect(() => prepareStorage(placement)).toThrow('writable')
  fixture.mounts = fixture.mounts.replace('/data ro', '/data rw')
  fixture.available = 0n
  expect(() => verifyStorage(placement)).toThrow('Insufficient storage')
})
it('rejects traversals, unowned contents and another experiment directory', () => {
  const { placement } = selection()
  mkdirSync(placement.namespaceRoot, { recursive: true }); writeFileSync(resolve(placement.namespaceRoot, 'data.txt'), 'unrelated')
  expect(() => prepareStorage(placement)).toThrow('unowned')
  expect(() => verifyStorage({ ...placement, workspaceRoot: placement.runRoot + '/../escape' })).toThrow('normalized')
  expect(() => verifyStorage({ ...placement, runRoot: placement.namespaceRoot + '/runs/' + randomUUID() })).toThrow('belong')
})
it('does not accept a candidate omitted from the captured inventory or override manual selection', () => {
  const { server, observed, candidate } = selection(true)
  expect(() => resolveStoragePlacement(server, experimentIdSchema.parse(randomUUID()), 'a'.repeat(64), { ...observed, candidates: [] }, candidate.id, 'Choice', 1024)).toThrow('inventory')
  const other = observed.candidates.find(value => value.directory === fixture.home)!
  expect(() => resolveStoragePlacement(server, experimentIdSchema.parse(randomUUID()), 'a'.repeat(64), observed, other.id, 'Choice', 1024)).toThrow('explicitly')
})


it('cleans an owned experiment, preserves shared state and originals, and repeats safely', () => {
  const { placement } = selection()
  prepareStorage(placement)
  writeFileSync(resolve(placement.workspaceRoot, 'model.bin'), 'weights')
  const repairDirectory = resolve(placement.runRoot, 'controller-repairs', 'node', randomUUID())
  mkdirSync(repairDirectory, { recursive: true })
  writeFileSync(resolve(repairDirectory, 'stopped.json'), JSON.stringify({ exited: true }))
  writeFileSync(resolve(placement.namespaceRoot, 'original-data'), 'retain')
  mkdirSync(placement.releaseRoot, { recursive: true })
  writeFileSync(resolve(placement.releaseRoot, 'release'), 'retain')
  const secret = placement.experimentId + '.json'
  writeFileSync(resolve(placement.controlRoot, 'secrets', secret), 'private')
  fixture.available = 0n
  cleanupStorage({ placement, privateNames: [secret] })
  cleanupStorage({ placement, privateNames: [secret] })
  expect(existsSync(placement.runRoot)).toBe(false)
  expect(existsSync(repairDirectory)).toBe(false)
  expect(existsSync(resolve(placement.controlRoot, 'secrets', secret))).toBe(false)
  expect(readFileSync(resolve(placement.namespaceRoot, 'original-data'), 'utf8')).toBe('retain')
  expect(readFileSync(resolve(placement.releaseRoot, 'release'), 'utf8')).toBe('retain')
  expect(existsSync(resolve(placement.controlRoot, 'state'))).toBe(true)
})

it('rejects mismatched owners, changed mounts and unsafe private paths before deleting files', () => {
  const { placement } = selection()
  prepareStorage(placement)
  writeFileSync(resolve(placement.workspaceRoot, 'keep'), 'present')
  expect(() => cleanupStorage({ placement, privateNames: ['../credentials'] })).toThrow('belong')
  fixture.mounts = fixture.mounts.replace('8:2', '8:9')
  expect(() => cleanupStorage({ placement, privateNames: [] })).toThrow('mount changed')
  fixture.mounts = fixture.mounts.replace('8:9', '8:2')
  writeFileSync(resolve(placement.runRoot, '.aspera-owner.json'), '{}')
  expect(() => cleanupStorage({ placement, privateNames: [] })).toThrow('ownership differs')
  expect(readFileSync(resolve(placement.workspaceRoot, 'keep'), 'utf8')).toBe('present')
})

it('does not cross nested bind mounts even when the filesystem device matches', () => {
  const { placement } = selection()
  prepareStorage(placement)
  fixture.mounts += `3 2 8:2 /shared ${placement.workspaceRoot}/cache rw - ext4 /dev/data rw\n`
  expect(() => cleanupStorage({ placement, privateNames: [] })).toThrow('mounted filesystem')
  expect(existsSync(placement.runRoot)).toBe(true)
})

it('unlinks a nested directory link without touching its external target', () => {
  const { placement } = selection()
  prepareStorage(placement)
  const outside = resolve(directory, 'outside')
  mkdirSync(outside); writeFileSync(resolve(outside, 'retain'), 'original')
  symlinkSync(outside, resolve(placement.workspaceRoot, 'external'), process.platform === 'win32' ? 'junction' : 'dir')
  cleanupStorage({ placement, privateNames: [] })
  expect(readFileSync(resolve(outside, 'retain'), 'utf8')).toBe('original')
})
