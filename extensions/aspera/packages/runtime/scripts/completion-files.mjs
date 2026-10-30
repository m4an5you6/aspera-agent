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

function ownedJournals(request, folder, suffix) {
  const directory = join(request.runRoot, folder)
  if (!existsSync(directory)) return []
  return opened(request.runRoot, directory, fd => {
    const names = readdirSync(process.platform === 'linux' ? `/proc/self/fd/${fd}` : directory).filter(name => name.endsWith(suffix)).sort()
    if (names.length > request.maxEntries) throw new Error('Acceptance recovery journal exceeds the configured entry limit')
    return names.map(name => {
      const row = JSON.parse(read(request.runRoot, join(directory, name), request.maxBytes).toString('utf8'))
      if (row.experimentId !== request.experimentId || row.serverId !== request.serverId) throw new Error('Acceptance journal belongs to another experiment or node')
      return row
    })
  })
}
function runtimeIdentity(request) {
  own(request.runRoot, request.experimentId, request.serverId, request.maxBytes)
  const control = JSON.parse(read(request.controlRoot, join(request.controlRoot, '.aspera-owner.json'), request.maxBytes))
  const release = JSON.parse(read(request.releaseRoot, join(request.releaseRoot, 'aspera-release.json'), request.maxBytes))
  const allocation = JSON.parse(read(request.controlRoot, join(request.controlRoot, 'state/node-home/storages/aspera_node/allocations', request.experimentId + '.json'), request.maxBytes)).record
  if (control.kind !== 'control' || control.serverId !== request.serverId || release.deploymentId !== request.deploymentId
    || allocation.deploymentId !== request.deploymentId || JSON.stringify(canonical(allocation.node)) !== JSON.stringify(canonical(request.node))) throw new Error('Acceptance recovery allocation or fixed release differs')
  read(request.releaseRoot, join(request.releaseRoot, '.ready'), request.maxBytes)
  return allocation
}
function checkpointFiles(request, directory, hashes) {
  if (isAbsolute(directory) || directory.split(/[\\/]/).some(part => part === '..' || part === '.')) throw new Error('Recovery checkpoint path is not relative')
  const workspace = join(request.runRoot, 'workspace')
  return ['adapter_config.json', 'adapter_model.safetensors', 'trainer_state.json'].map(name => opened(workspace, join(workspace, directory, name), fd => {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size <= 0) throw new Error('Retained adapter has missing or empty files')
    const result = { name, device: String(before.dev), inode: String(before.ino), bytes: before.size, modified: before.mtimeMs }
    if (hashes) {
      const hash = createHash('sha256'), buffer = Buffer.alloc(65536)
      let count
      while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count))
      result.sha256 = hash.digest('hex')
    }
    if (identity(before) !== identity(fstatSync(fd))) throw new Error('Retained adapter changed during recovery inspection')
    return result
  }))
}
/** @param request - original and program-selected inference allocations. @returns a released native endpoint matched to an existing protected snapshot and original public check. */
export function inspectAcceptanceSource(request) {
  inspectCompletionIdentity(request)
  const recovery = { ...request.recovery, maxBytes: request.maxBytes, maxEntries: request.maxEntries }
  if (recovery.experimentId === request.experimentId || recovery.serverId !== request.serverId) throw new Error('Acceptance recovery must use the same selected node and another execution identity')
  runtimeIdentity(recovery)
  const snapshots = ownedJournals(recovery, 'inference-checkpoints-v1', '.json').filter(row => row.state === 'ready'
    && row.source.sourceExperimentId === request.experimentId && row.source.step === request.expectedStep)
  if (snapshots.length !== 1) throw new Error('A unique protected recovery snapshot of the original endpoint is required')
  const snapshot = snapshots[0], source = snapshot.source
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(source.commandId)) throw new Error('Original training command identity is invalid')
  const command = JSON.parse(read(request.controlRoot, join(request.controlRoot, 'state/node-home/storages/aspera_node/commands', request.experimentId + '_' + source.commandId + '.json'), request.maxBytes)).record
  if (command.experimentId !== request.experimentId || command.commandId !== source.commandId || command.state !== 'completed' || command.exitCode !== 0 || !command.released) throw new Error('Original endpoint command has not confirmed successful release')
  const stages = ownedJournals(request, 'stage-acceptance-v1', '.verification.json')
  const registrations = ownedJournals(request, 'stage-acceptance-v1', '.registration.json')
  if (!registrations.some(registration => registration.commandId === source.commandId && stages.some(row => row.stageId === registration.stageId
    && row.attemptId === registration.attemptId && row.sessionId === registration.sessionId && row.planRevision === registration.planRevision
    && row.ready && row.endStep === request.expectedStep))) throw new Error('Original endpoint lacks independent stage verification')
  const files = checkpointFiles(request, source.directory, true)
  const actual = { sourceExperimentId: request.experimentId, serverId: request.serverId, commandId: source.commandId,
    directory: source.directory, step: request.expectedStep, files: files.map(({ sha256: _hash, ...file }) => file) }
  if (source.checkpointId !== digest(JSON.stringify(actual)) || JSON.stringify(actual.files) !== JSON.stringify(source.files)
    || files.some(file => !snapshot.files.some(proof => JSON.stringify(file) === JSON.stringify(proof)))) throw new Error('Recovery snapshot does not match the original native files')
  const state = JSON.parse(read(join(request.runRoot, 'workspace'), join(request.runRoot, 'workspace', source.directory, 'trainer_state.json'), request.maxBytes))
  if (state.global_step !== request.expectedStep) throw new Error('Original native step changed')
  const checks = ownedJournals(request, 'service-verifications-v1', '.json')
  const requirements = [...new Map(checks.map(row => [row.url + '\n' + row.modelName, row])).values()]
  if (requirements.length !== 1 || request.node.server.inferenceMapping?.url !== requirements[0].url) throw new Error('Original public inference requirements are missing or ambiguous')
  return { serverId: request.serverId, step: request.expectedStep, commandId: source.commandId, checkpointId: source.checkpointId,
    directory: source.directory, files, publicUrl: requirements[0].url, modelName: requirements[0].modelName }
}
/** @param request - fixed inference allocation. @returns current program journals and Goal outcome without launching any work. */
export function inspectAcceptanceRuntime(request) {
  runtimeIdentity(request)
  const snapshots = ownedJournals(request, 'inference-checkpoints-v1', '.json')
  for (const row of snapshots) {
    const files = checkpointFiles(request, row.destination, false)
    if (files.some(file => !row.files.some(proof => file.name === proof.name && file.device === proof.device && file.inode === proof.inode && file.bytes === proof.bytes && file.modified === proof.modified))) throw new Error('Protected recovery checkpoint changed')
  }
  const verifications = ownedJournals(request, 'service-verifications-v1', '.json')
  const directory = join(request.controlRoot, 'state/node-home/storages/aspera_node/services')
  const services = existsSync(directory) ? opened(request.controlRoot, directory, fd => {
    const names = readdirSync(process.platform === 'linux' ? '/proc/self/fd/' + fd : directory).filter(name => name.endsWith('.json'))
    if (names.length > request.maxEntries) throw new Error('Service history exceeds the configured acceptance limit')
    return names.map(name => JSON.parse(read(request.controlRoot, join(directory, name), request.maxBytes)).record).filter(row => row.experimentId === request.experimentId)
  }) : []
  let record, goalFinished = false
  if (request.coordinator) {
    record = JSON.parse(read(request.controlRoot, join(request.controlRoot, 'state/coordinator-home/storages/aspera_queue/experiments', request.experimentId + '.json'), request.maxBytes)).record
    if (record.submission.experimentId !== request.experimentId || record.submission.deploymentId !== request.deploymentId) throw new Error('Recovery coordinator identity differs')
    if (['serving', 'completed'].includes(record.state)) {
      const goal = inspectCompletionSession({ ...request, sessionId: record.sessionId })
      goalFinished = goal.finished && goal.finishStatus === 'completed'
    }
  }
  return { snapshots, services, verifications, ...(record === undefined ? {} : { record }), goalFinished }
}
/** @param request - released original node. @returns whether original program-owned checks establish a public-serving obligation. */
export function inspectCompletionServiceRequirements(request) {
  inspectCompletionIdentity(request)
  return { required: ownedJournals(request, 'service-verifications-v1', '.json').length > 0 }
}
/** @param request - released inference recovery. @returns retained program hints for another recovery, without installing or approving its requirements. */
export function inspectAcceptanceReferences(request) {
  inspectCompletionIdentity(request)
  const preflights = [], environmentIssues = [], directory = join(request.runRoot, 'environment-operations-v1')
  if (existsSync(directory)) opened(request.runRoot, directory, fd => {
    const held = process.platform === 'linux' ? '/proc/self/fd/' + fd : directory
    const operations = readdirSync(held).filter(name => /^[a-f0-9-]{36}$/.test(name)).sort()
    if (operations.length > request.maxEntries) throw new Error('Environment operation references exceed the configured limit')
    for (const name of operations) {
      const path = join(directory, name, 'receipt.v1.json')
      if (!existsSync(path)) { environmentIssues.push({ operationId: name, detail: 'Receipt is unavailable; this source remains unconfirmed' }); continue }
      const row = opened(request.runRoot, path, file => {
        const before = fstatSync(file)
        if (!before.isFile()) throw new Error('Environment operation receipt is not a regular file')
        if (before.size > request.maxBytes) { environmentIssues.push({ operationId: name, detail: 'Receipt exceeds the configured read limit; inspect this operation with its detail interface' }); return undefined }
        const bytes = readFileSync(file)
        if (bytes.length !== before.size || identity(before) !== identity(fstatSync(file))) throw new Error('Environment operation receipt changed during inspection')
        return JSON.parse(bytes.toString('utf8'))
      })
      if (row === undefined) continue
      if (row.experimentId !== request.experimentId || row.serverId !== request.serverId) throw new Error('Environment operation reference belongs to another experiment')
      if (row.preflight?.status === 'reusable' && row.exitConfirmed && row.exitCode === 0) preflights.push(row.preflight)
    }
  })
  const proposals = ownedJournals(request, 'storage-preflight-v2/proposals', '.json')
  return { preflights, environmentIssues, proposals }
}
/** @param request - original owned source paths selected from its saved file catalog. @returns bounded script/configuration text, never executed or modified. */
export function inspectAcceptanceScripts(request) {
  inspectCompletionIdentity(request)
  if (request.paths.length > request.maxEntries) throw new Error('Recovery source list exceeds its configured limit')
  let bytes = 0
  return request.paths.map(path => {
    if (!/^(?:configs|scripts)\/.+\.(?:py|sh|json)$/.test(path)) throw new Error('Recovery source is outside original scripts and configurations')
    const file = inspectCompletionFile({ ...request, path, maxBytes: request.readBytes })
    if (file.truncated) throw new Error('Original recovery source is truncated: ' + path)
    bytes += file.bytes
    if (bytes > request.maxBytes) throw new Error('Recovery source text exceeds the configured total limit')
    return { serverId: request.serverId, path, sha256: file.sha256, text: file.text }
  })
}
/** @param request - validated Host operation and accepted observations. @returns a new immutable original-relative proof, retaining every original result and log. */
export function saveAcceptanceEvidence(request) {
  inspectCompletionIdentity(request)
  const operation = request.operation
  if (operation.experimentId !== request.experimentId || operation.source.experimentId !== request.experimentId
    || operation.recoveryExperimentId !== request.observation.experimentId || !/^[a-f0-9-]{36}$/.test(operation.operationId)) throw new Error('Acceptance evidence ownership differs')
  const relativePath = 'reports/acceptance-recovery/' + operation.operationId + '.json'
  const workspace = join(request.runRoot, 'workspace'), directory = join(workspace, 'reports/acceptance-recovery')
  for (const [parent, name] of [[workspace, 'reports'], [join(workspace, 'reports'), 'acceptance-recovery']]) opened(workspace, parent, fd => {
    const path = join(process.platform === 'linux' ? '/proc/self/fd/' + fd : parent, name)
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
  })
  return opened(workspace, directory, fd => {
    const held = process.platform === 'linux' ? '/proc/self/fd/' + fd : directory, path = join(held, operation.operationId + '.json')
    const bytes = JSON.stringify({ version: 1, experimentId: request.experimentId, operationId: operation.operationId,
      source: operation.source, recovery: request.observation, checkedAt: Date.now() }) + '\n'
    if (existsSync(path)) {
      const saved = read(workspace, join(workspace, relativePath), request.maxBytes)
      const original = JSON.parse(saved)
      if (original.operationId !== operation.operationId || JSON.stringify(original.source) !== JSON.stringify(operation.source)
        || JSON.stringify(original.recovery) !== JSON.stringify(request.observation)) throw new Error('Acceptance evidence is immutable')
      return { path: relativePath, sha256: digest(saved) }
    }
    const temporary = join(held, randomUUID() + '.incoming'), output = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(output, bytes); fsyncSync(output) } finally { closeSync(output) }
    renameSync(temporary, path)
    return { path: relativePath, sha256: digest(bytes) }
  })
}
