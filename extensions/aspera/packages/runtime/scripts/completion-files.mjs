/** Program-owned evidence reads and supplementary receipts never execute experiment code. */
import { constants, openSync, closeSync, readFileSync, readSync, fstatSync, readdirSync, realpathSync, lstatSync, readlinkSync,
  existsSync, mkdirSync, writeFileSync, fsyncSync, renameSync } from 'node:fs'
import { resolve, dirname, relative, sep, isAbsolute, join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex') }
function identity(s) { return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  return value
}
function opened(root, path, use) {
  root = resolve(root); path = resolve(path)
  const rel = relative(root, path)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Evidence path escapes its original experiment')
  const handles = []
  try {
    let current = root
    for (const part of [null, ...rel.split(sep).filter(Boolean)]) {
      if (part !== null) current = process.platform === 'linux' ? `/proc/self/fd/${handles.at(-1)}/${part}` : join(current, part)
      if (lstatSync(current).isSymbolicLink()) throw new Error('Evidence path contains a symbolic link')
      const fd = openSync(current, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); handles.push(fd)
      if (part !== null && process.platform === 'linux') {
        const mnt = value => /^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${value}`, 'utf8'))?.[1]
        if (!mnt(fd) || mnt(fd) !== mnt(handles[0])) throw new Error('Evidence path crosses an unconfirmed nested mount')
      }
    }
    return use(handles.at(-1))
  } finally { for (const fd of handles.reverse()) closeSync(fd) }
}
function read(root, path, maxBytes) {
  return opened(root, path, fd => {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > maxBytes) throw new Error('Evidence metadata is not a bounded regular file')
    const bytes = readFileSync(fd)
    if (identity(before) !== identity(fstatSync(fd))) throw new Error('Evidence changed while reading')
    return bytes
  })
}
function own(root, experimentId, serverId, maxBytes) {
  const marker = JSON.parse(read(root, resolve(root, '.aspera-owner.json'), maxBytes).toString('utf8'))
  if (marker.version !== 1 || marker.experimentId !== experimentId || marker.serverId !== serverId) throw new Error('Evidence directory has another experiment or node owner')
}
/** @param request - original immutable node/release assignment. @returns after read-only ownership and release checks. */
export function inspectCompletionIdentity(request) {
  own(request.runRoot, request.experimentId, request.serverId, request.maxBytes)
  const marker = JSON.parse(read(request.controlRoot, join(request.controlRoot, '.aspera-owner.json'), request.maxBytes).toString('utf8'))
  if (marker.serverId !== request.serverId || marker.kind !== 'control') throw new Error('Original control directory ownership changed')
  const release = JSON.parse(read(request.releaseRoot, join(request.releaseRoot, 'aspera-release.json'), request.maxBytes).toString('utf8'))
  if (release.deploymentId !== request.deploymentId) throw new Error('Original fixed release identity changed')
  read(request.releaseRoot, join(request.releaseRoot, '.ready'), request.maxBytes)
  const row = JSON.parse(read(request.controlRoot, join(request.controlRoot, 'state/node-home/storages/aspera_node/allocations', request.experimentId + '.json'), request.maxBytes).toString('utf8')).record
  if (row.deploymentId !== request.deploymentId || JSON.stringify(canonical(row.node)) !== JSON.stringify(canonical(request.node)) || row.released !== true) throw new Error('Original node allocation identity or release is unconfirmed')
  return { verified: true }
}
/** @param request - program-derived original directory and selected relative source. @returns stable file identity and optional bounded text. */
export function inspectCompletionFile(request) {
  own(request.runRoot, request.experimentId, request.serverId, request.maxBytes)
  if (isAbsolute(request.path) || request.path.split(/[\\/]/).includes('..')) throw new Error('Evidence source must be experiment-relative')
  const root = resolve(request.runRoot, request.privateSource ? '' : 'workspace')
  if (request.privateSource && !['events.jsonl', 'execution-progress.v1.json', 'outcome.json', 'started.json'].includes(request.path)) throw new Error('Private evidence source is not readable')
  return opened(root, resolve(root, request.path), fd => {
    const before = fstatSync(fd)
    if (!before.isFile()) throw new Error('Evidence source is not a regular file')
    const hash = createHash('sha256'), buffer = Buffer.alloc(Math.min(request.maxBytes, 65536))
    const text = Buffer.alloc(request.metadataOnly ? 0 : Math.min(before.size, request.maxBytes))
    let length, position = 0
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length))
      if (position < text.length) buffer.copy(text, position, 0, Math.min(length, text.length - position))
      position += length
    }
    const tail = before.size <= request.maxBytes || request.metadataOnly ? text : Buffer.alloc(Math.min(before.size, request.maxBytes))
    if (tail !== text) for (let offset = 0; offset < tail.length;) {
      const count = readSync(fd, tail, offset, tail.length - offset, before.size - tail.length + offset)
      if (count === 0) throw new Error('Evidence changed while reading its tail')
      offset += count
    }
    if (identity(before) !== identity(fstatSync(fd))) throw new Error('Evidence changed while hashing')
    return { sha256: hash.digest('hex'), generation: identity(before), bytes: before.size,
      text: text.toString('utf8'), tail: tail.toString('utf8'), truncated: before.size > request.maxBytes || request.metadataOnly === true && before.size > 0 }
  })
}
/** @param request - original coordinator and execution Session. @returns streamed completion evidence, including large complete events. */
export function inspectCompletionSession(request) {
  own(request.runRoot, request.experimentId, request.serverId, request.maxBytes)
  return opened(request.runRoot, resolve(request.runRoot, 'events.jsonl'), fd => {
    const before = identity(fstatSync(fd)), hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    let pending = Buffer.alloc(0), count, call = -1, goal = -1, phase, end = -1, finishStatus
    const consume = bytes => {
      if (bytes.length === 0) return
      if (bytes.length > request.maxBytes) throw new Error('Original Session event exceeds the configured evidence limit')
      const row = JSON.parse(bytes.toString('utf8'))
      if (row.sessionId !== request.sessionId) return
      const event = row.event, data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data
      if (!Number.isSafeInteger(event.seq)) throw new Error('Original Session sequence is invalid')
      if (event.type === 'tool/call' && data.name === 'finish_experiment') {
        const status = JSON.parse(data.arguments).status
        if (status === 'completed' || status === 'blocked') { call = event.seq; finishStatus = status }
      }
      if (event.type === 'goal/change') { goal = event.seq; phase = data.goal?.phase }
      if (event.type === 'turn/end') end = event.seq
    }
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count)); pending = Buffer.concat([pending, buffer.subarray(0, count)])
      let newline
      while ((newline = pending.indexOf(10)) >= 0) { consume(pending.subarray(0, newline)); pending = pending.subarray(newline + 1) }
      if (pending.length > request.maxBytes) throw new Error('Original Session event exceeds the configured evidence limit')
    }
    if (pending.length > 0) throw new Error('Original Session ends with an incomplete event')
    if (before !== identity(fstatSync(fd))) throw new Error('Original Session changed during verification')
    return { sessionId: request.sessionId, finished: call >= 0 && goal > call && end > goal && (phase === 'complete' && finishStatus === 'completed' || phase === 'blocked' && finishStatus === 'blocked'), finishStatus,
      sha256: hash.digest('hex'), generation: before }
  })
}
/** @param request - original workspace and bounded listing. @returns existing evidence paths without traversing dependencies or symlinks. */
export function listCompletionFiles(request) {
  own(request.runRoot, request.experimentId, request.serverId, request.maxBytes)
  const workspace = resolve(request.runRoot, 'workspace'), files = []
  function walk(directory) {
    if (files.length >= request.maxEntries) return
    opened(workspace, directory, fd => {
    const held = process.platform === 'linux' ? `/proc/self/fd/${fd}` : directory
    for (const name of readdirSync(held).sort()) {
      if (files.length >= request.maxEntries) return
      const file = join(directory, name), observed = join(held, name), info = lstatSync(observed)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) {
        if (request.excludeDirectories.includes(name) || existsSync(join(observed, 'pyvenv.cfg'))) continue
        walk(file)
      } else if (info.isFile()) files.push({ serverId: request.serverId, path: relative(workspace, file).split(sep).join('/'), bytes: info.size })
    }
    })
  }
  walk(workspace)
  return { files, truncated: files.length >= request.maxEntries }
}
/** @param request - original environment path and read budget. @returns metadata-only historical registration, without imports or installation. */
export function inspectHistoricalEnvironment(request) {
  own(request.runRoot, request.experimentId, request.serverId, request.maxBytes)
  const workspace = resolve(request.runRoot, 'workspace')
  const environment = resolve(workspace, request.environment)
  const cfg = read(workspace, join(environment, 'pyvenv.cfg'), request.maxBytes).toString('utf8')
  const bin = join(environment, 'bin/python')
  const parent = dirname(bin); opened(workspace, parent, () => {})
  let python = bin
  if (lstatSync(bin).isSymbolicLink()) {
    const link = readlinkSync(bin)
    python = realpathSync(bin)
    if (!/^\/usr\/(?:local\/)?bin\/python[\d.]*$/.test(python) && !python.startsWith(environment + sep)) throw new Error('Historical interpreter points outside approved Python locations')
    if (!link) throw new Error('Historical interpreter link is empty')
  }
  const pythonStat = lstatSync(python)
  if (!pythonStat.isFile()) throw new Error('Historical Python interpreter is unavailable')
  const version = /^(?:version|version_info)\s*=\s*(.+)$/m.exec(cfg)?.[1]
  if (!version) throw new Error('Historical Python version is missing')
  const interpreterHash = opened(dirname(python), python, fd => {
    const before = identity(fstatSync(fd)), hash = createHash('sha256'), buffer = Buffer.alloc(65536)
    let count
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
    if (identity(fstatSync(fd)) !== before) throw new Error('Historical interpreter changed while reading')
    return hash.digest('hex')
  })
  const packages = {}, material = [cfg, identity(pythonStat), interpreterHash]
  const library = join(environment, 'lib'); opened(workspace, library, () => {})
  const sites = readdirSync(library).filter(name => /^python\d+\.\d+$/.test(name))
  if (sites.length !== 1) throw new Error('Historical Python library is ambiguous')
  const site = join(library, sites[0], 'site-packages'); opened(workspace, site, () => {})
  for (const name of readdirSync(site).filter(name => name.endsWith('.dist-info')).sort()) {
    const metadata = read(workspace, join(site, name, 'METADATA'), request.maxBytes).toString('utf8')
    const pkg = /^Name:\s*(.+)$/m.exec(metadata)?.[1]?.trim().toLowerCase().replace(/[-_.]+/g, '-')
    const v = /^Version:\s*(.+)$/m.exec(metadata)?.[1]?.trim()
    if (!pkg || !v || packages[pkg]) throw new Error('Historical dependency metadata is incomplete or duplicated')
    packages[pkg] = v; material.push(name, digest(metadata))
  }
  if (packages[request.framework.toLowerCase().replace(/[-_.]+/g, '-')] !== request.version) throw new Error('Historical framework version differs from the recorded execution')
  return { version: 1, kind: 'historical', serverId: request.serverId, path: environment, python,
    packages, digest: digest(JSON.stringify(material)), checkedAt: Date.now() }
}
/** @param request - program-selected operation receipt. @returns its durable digest; original outcomes and execution files are never overwritten. */
export function saveCompletionReview(request) {
  own(request.runRoot, request.experimentId, request.serverId, request.maxBytes)
  if (!/^[a-f0-9-]{36}$/.test(request.receipt.operationId) || request.receipt.experimentId !== request.experimentId) throw new Error('Review receipt has another owner')
  const root = resolve(request.runRoot, 'completion-reviews-v1')
  if (existsSync(root)) opened(request.runRoot, root, () => {})
  else mkdirSync(root, { mode: 0o700 })
  const path = join(root, request.receipt.operationId + '.json')
  if (existsSync(path)) {
    const prior = JSON.parse(read(request.runRoot, path, request.maxBytes).toString('utf8'))
    if (prior.submissionHash !== request.receipt.submissionHash || prior.revision > request.receipt.revision
      || prior.revision === request.receipt.revision && JSON.stringify(prior) !== JSON.stringify(request.receipt)) throw new Error('Review receipt revision conflict')
  }
  const bytes = JSON.stringify(request.receipt) + '\n', temporary = join(root, randomUUID() + '.incoming')
  const fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  return { sha256: digest(bytes) }
}
/** @param request - independently checked stage and step supplements. @returns the separate durable assessment digest. */
export function saveCompletionAssessment(request) {
  own(request.runRoot, request.experimentId, request.serverId, request.maxBytes)
  const assessment = request.assessment
  if (assessment.version !== 1 || assessment.experimentId !== request.experimentId || !/^[a-f0-9-]{36}$/.test(assessment.operationId)) throw new Error('Assessment identity differs from the original experiment')
  const folder = join(request.runRoot, 'completion-assessments-v1')
  if (existsSync(folder)) opened(request.runRoot, folder, () => {})
  else mkdirSync(folder, { mode: 0o700 })
  const path = join(folder, assessment.operationId + '.json')
  if (existsSync(path)) {
    const previous = JSON.parse(read(request.runRoot, path, request.maxBytes).toString('utf8'))
    if (previous.submissionHash !== assessment.submissionHash || previous.originalRevision !== assessment.originalRevision || previous.revision > assessment.revision
      || previous.revision === assessment.revision && JSON.stringify(previous) !== JSON.stringify(assessment)) throw new Error('Assessment revision or original result identity changed')
  }
  const bytes = JSON.stringify(assessment) + '\n', temporary = join(folder, randomUUID() + '.incoming'), fd = openSync(temporary, 'wx', 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  renameSync(temporary, path)
  return { sha256: digest(bytes) }
}
/** @param request - original owned coordinator directory. @returns bounded program journals; no workspace scan or process mutation. */
export function inspectExperimentFinalization(request) {
  own(request.runRoot, request.experimentId, request.serverId, request.maxBytes)
  let total = 0, truncated = false
  const collect = (folder, suffix) => {
    const directory = join(request.runRoot, folder)
    if (!existsSync(directory)) return []
    return opened(request.runRoot, directory, fd => {
      const entries = readdirSync(process.platform === 'linux' ? `/proc/self/fd/${fd}` : directory).filter(name => name.endsWith(suffix)).sort()
      const rows = []
      for (const name of entries) {
        if (rows.length >= request.maxEntries || total >= request.maxBytes) { truncated = true; break }
        const bytes = read(request.runRoot, join(directory, name), request.maxBytes)
        total += bytes.length
        if (total > request.maxBytes) { truncated = true; break }
        const row = JSON.parse(bytes.toString('utf8'))
        if (row.experimentId !== request.experimentId) throw new Error('Finalization journal belongs to another experiment')
        rows.push(row)
      }
      return rows
    })
  }
  const waits = collect('command-waits-v1', '.json'), stages = collect('stage-acceptance-v1', '.verification.json')
  const path = join(request.runRoot, 'finish-decision.v1.json')
  const decision = existsSync(path) ? JSON.parse(read(request.runRoot, path, request.maxBytes).toString('utf8')) : undefined
  if (decision !== undefined && decision.experimentId !== request.experimentId) throw new Error('Finish decision belongs to another experiment')
  return { version: 1, experimentId: request.experimentId, supported: waits.length > 0 || stages.length > 0 || decision !== undefined,
    waits, stages, ...(decision === undefined ? {} : { decision }), observedAt: Date.now(), offline: false, truncated }
}
