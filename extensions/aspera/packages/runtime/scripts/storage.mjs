/** Linux inventory and owned-directory preparation, executable before the runtime is installed. */
import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync,
  readdirSync, statSync, statfsSync, writeFileSync, unlinkSync, linkSync } from 'node:fs'
import { homedir, networkInterfaces } from 'node:os'
import { dirname, posix } from 'node:path'

const ephemeral = new Set(['tmpfs', 'ramfs', 'proc', 'sysfs', 'devtmpfs', 'devpts', 'cgroup', 'cgroup2', 'securityfs', 'debugfs', 'tracefs', 'mqueue', 'pstore', 'hugetlbfs', 'fusectl', 'configfs', 'squashfs', 'autofs'])
const unescapeMount = value => value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)))
const inside = (base, target) => target === base || target.startsWith(base === '/' ? '/' : base + '/')
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** Parse mountinfo without treating escaped spaces or bind mounts as separate columns. */
export function parseMounts(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const [left, right] = line.split(' - ')
    if (right === undefined) throw new Error('Invalid Linux mount inventory')
    const fields = left.split(' '); const tail = right.split(' ')
    return { mountPoint: unescapeMount(fields[4]), root: unescapeMount(fields[3]), device: fields[2],
      filesystem: tail[0], source: unescapeMount(tail[1]), readOnly: fields[5].split(',').includes('ro') }
  })
}

function assertAbsolute(path) {
  // oxlint-disable-next-line no-control-regex -- Remote paths must reject NUL and other control characters.
  if (typeof path !== 'string' || !path.startsWith('/') || /[\\\u0000-\u001f]/.test(path)
    || posix.normalize(path) !== path || (path !== '/' && path.endsWith('/'))) throw new Error('Storage directory must be a normalized absolute Linux path')
}

function rejectLinks(path) {
  assertAbsolute(path)
  let current = '/'
  for (const part of path.split('/').filter(Boolean)) {
    current = posix.join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Storage path contains a symbolic link: ${current}`)
  }
}

function mountFor(path, mounts) {
  const selected = mounts.filter(mount => inside(mount.mountPoint, path)).sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0]
  if (selected === undefined) throw new Error(`No filesystem contains ${path}`)
  const { readOnly: _readOnly, ...identity } = selected
  if (identity.source.startsWith('/dev/') && existsSync('/dev/disk/by-uuid')) {
    for (const name of readdirSync('/dev/disk/by-uuid')) {
      try {
        if (realpathSync('/dev/disk/by-uuid/' + name) === realpathSync(identity.source)) { identity.uuid = name; break }
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error }
    }
  }
  return identity
}

function existingParent(path) {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw new Error(`No existing parent of ${path}`)
    current = parent
  }
  if (!statSync(current).isDirectory()) throw new Error(`Storage parent is not a directory: ${current}`)
  return current
}

function candidate(path, mounts) {
  rejectLinks(path)
  const parent = existingParent(path)
  const mount = mountFor(parent, mounts)
  const stats = statfsSync(parent, { bigint: true })
  const bytes = value => Number(value > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : value)
  let writable = !mounts.find(item => item.mountPoint === mount.mountPoint)?.readOnly
  try { accessSync(parent, constants.W_OK | constants.X_OK) } catch (error) { if (error.code !== 'EACCES' && error.code !== 'EROFS') throw error; writable = false }
  return { id: hash({ directory: path, mount }), directory: path, mount,
    availableBytes: bytes(stats.bavail * stats.bsize), totalBytes: bytes(stats.blocks * stats.bsize), writable,
    systemVolume: mount.device === mountFor('/', mounts).device,
    persistence: ephemeral.has(mount.filesystem) ? 'ephemeral' : 'unknown' }
}

/** Read storage and interfaces without creating files or invoking a model. */
export function inspectStorage(input = {}) {
  const mounts = parseMounts(readFileSync('/proc/self/mountinfo', 'utf8'))
  const home = realpathSync(homedir())
  const directories = new Set([home])
  for (const mount of mounts) {
    if (ephemeral.has(mount.filesystem) || /^\/(proc|sys|dev)(\/|$)/.test(mount.mountPoint)) continue
    try { if (statSync(mount.mountPoint).isDirectory()) directories.add(mount.mountPoint) }
    catch (error) { if (!['EACCES', 'ENOENT'].includes(error.code)) throw error }
  }
  if (input.directory !== undefined) { assertAbsolute(input.directory); directories.add(input.directory) }
  const candidates = []
  for (const directory of directories) {
    try { candidates.push(candidate(directory, mounts)) }
    catch (error) { if (directory === input.directory || !['EACCES', 'ENOENT'].includes(error.code)) throw error }
  }
  const addresses = Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries ?? [])
    .filter(item => !item.internal && !item.address.startsWith('169.254.') && !item.address.toLowerCase().startsWith('fe80:'))
    .map(item => ({ address: item.address, interface: name, family: item.family,
      private: /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|f[cd])/i.test(item.address) })))
  const routes = ['/proc/net/route', '/proc/net/ipv6_route'].flatMap(path => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n') : [])
  if (candidates.length > 512 || addresses.length > 512 || routes.length > 1024) throw new Error('Server inventory exceeds supported limits')
  return { observedAt: Date.now(), home, candidates, addresses, routes }
}

/** Check a frozen mount and current capacity before writes, without choosing another disk. */
export function verifyStorage(placement, requiredBytes = 0) {
  const mounts = parseMounts(readFileSync('/proc/self/mountinfo', 'utf8'))
  const observed = candidate(placement.candidate.directory, mounts)
  if (observed.id !== placement.candidate.id) throw new Error('Storage mount changed or disappeared; this experiment retains its original directory')
  if (!observed.writable || observed.persistence === 'ephemeral') throw new Error('Selected storage is not a writable disk')
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes < 0) throw new Error('Invalid required storage size')
  if (observed.availableBytes < placement.minimumFreeBytes + requiredBytes) throw new Error(`Insufficient storage at ${observed.directory}: ${observed.availableBytes} bytes available`)
  for (const path of [placement.controlRoot, placement.namespaceRoot, placement.releaseRoot, placement.runRoot, placement.workspaceRoot]) rejectLinks(path)
  const namespace = placement.layout === 'legacy' ? placement.candidate.directory : posix.join(placement.candidate.directory, '.aspera', placement.serverId)
  if (placement.namespaceRoot !== namespace || namespace === '/'
    || (placement.layout === 'legacy' && placement.controlRoot !== namespace)
    || placement.runRoot !== posix.join(placement.namespaceRoot, 'runs', placement.experimentId)
    || placement.workspaceRoot !== posix.join(placement.runRoot, 'workspace')
    || !placement.releaseRoot.startsWith(placement.namespaceRoot + '/releases/')) throw new Error('Storage directories do not belong to this experiment')
  return observed
}

function makeOwned(path, owner, adoptLegacy = false) {
  rejectLinks(path)
  const marker = posix.join(path, '.aspera-owner.json')
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: 0o700 })
  const expected = JSON.stringify(owner)
  const checkOwner = () => {
    rejectLinks(marker)
    if (readFileSync(marker, 'utf8') !== expected) throw new Error(`Storage directory belongs to another owner: ${path}`)
  }
  if (existsSync(marker)) { checkOwner(); return }
  if (!adoptLegacy && readdirSync(path).some(name => !/^\.aspera-owner-[a-f0-9-]+\.tmp$/.test(name))) {
    if (existsSync(marker)) { checkOwner(); return }
    throw new Error(`Refusing to adopt a nonempty unowned directory: ${path}`)
  }
  const temporary = posix.join(path, '.aspera-owner-' + randomUUID() + '.tmp')
  writeFileSync(temporary, expected, { flag: 'wx', mode: 0o600 })
  try {
    linkSync(temporary, marker)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    checkOwner()
  } finally { unlinkSync(temporary) }
}

/** Create only recorded Aspera directories; retries retain their owner and locations. */
export function prepareStorage(placement, requiredBytes = 0) {
  const observed = verifyStorage(placement, requiredBytes)
  makeOwned(placement.controlRoot, { version: 1, serverId: placement.serverId, kind: 'control' }, placement.layout === 'legacy')
  if (placement.namespaceRoot !== placement.controlRoot) makeOwned(placement.namespaceRoot, { version: 1, serverId: placement.serverId, kind: 'storage' })
  makeOwned(placement.runRoot, { version: 1, serverId: placement.serverId, experimentId: placement.experimentId })
  for (const path of [placement.workspaceRoot, posix.join(placement.runRoot, 'inputs'), posix.join(placement.runRoot, 'logs'),
    ...['env', 'cache', 'outputs', 'tmp', 'inputs'].map(name => posix.join(placement.workspaceRoot, name)),
    ...['state', 'secrets', 'logs', 'workspace', 'tools'].map(name => posix.join(placement.controlRoot, name)),
    posix.dirname(placement.releaseRoot), posix.join(placement.namespaceRoot, 'incoming')]) {
    rejectLinks(path); mkdirSync(path, { recursive: true, mode: 0o700 })
  }
  const probe = posix.join(placement.workspaceRoot, '.write-' + randomUUID())
  const fd = openSync(probe, 'wx', 0o600)
  try { writeFileSync(fd, 'aspera storage check') } finally { closeSync(fd); unlinkSync(probe) }
  const registry = posix.join(placement.controlRoot, 'state', 'storage-roots')
  mkdirSync(registry, { recursive: true, mode: 0o700 })
  makeOwned(posix.join(registry, hash(placement.namespaceRoot)), { namespaceRoot: placement.namespaceRoot })
  return observed
}
