/** Read-only, account-owned history access; no controller, GPU or worker startup is performed. */
import { constants, closeSync, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path'

function contained(root, path) {
  if (!isAbsolute(root) || !isAbsolute(path)) throw new Error('Archive paths must be absolute')
  const canonical = realpathSync(root)
  let current = path
  for (;;) {
    if (lstatSync(current).isSymbolicLink()) throw new Error('Archive paths cannot contain symbolic links')
    if (current === dirname(current)) break
    current = dirname(current)
  }
  const file = realpathSync(path)
  if (file !== canonical && !file.startsWith(canonical + sep)) throw new Error('Archive file is outside its experiment')
  return file
}
function json(root, path) {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(contained(root, path), 'utf8'))
}
function generation(stats) { return `${stats.dev}:${stats.ino}:${stats.birthtimeMs}` }
function own(request) {
  const root = resolve(request.runRoot)
  contained(root, root)
  const marker = json(root, join(root, '.aspera-owner.json'))
  if (marker?.version !== 1 || marker.serverId !== request.serverId || marker.experimentId !== request.experimentId) {
    throw new Error('Archive experiment directory ownership differs or is unavailable')
  }
  return root
}

/** @param request - program-derived experiment paths and bounded scan policy. @returns existing source identities and saved facts. */
export function archiveCatalog(request) {
  const root = own(request)
  const result = { sources: [], processes: [], metrics: [], truncated: false }
  const max = request.maxEntries
  function add(path, identity) {
    if (!existsSync(path)) return
    const file = contained(root, path); const stats = statSync(file)
    if (!stats.isFile()) throw new Error('Archive source is not a regular file')
    if (result.sources.length >= max) { result.truncated = true; return }
    result.sources.push({ ...identity, path: relative(root, file).split(sep).join('/'), generation: generation(stats),
      size: stats.size, modifiedAt: stats.mtimeMs })
  }
  if (request.coordinator) {
    const task = json(request.controlRoot, join(request.controlRoot, 'state/coordinator-home/storages/aspera_queue/experiments', request.experimentId + '.json'))
    if (task !== undefined) result.record = task.record
    for (const phase of ['planning', 'execution']) add(join(root, 'events.jsonl'), { id: `trace-${phase}`, kind: 'trace', phase,
      sessionId: request.sessions[phase], format: 'events' })
    add(join(root, 'agent.log'), { id: 'legacy-agent', kind: 'log', format: 'text', stream: 'mixed', label: 'agent.log' })
    result.progress = json(root, join(root, 'execution-progress.v1.json'))
  }
  const observations = join(root, 'observations-v1')
  if (existsSync(observations)) {
    contained(root, observations)
    for (const name of readdirSync(observations)) {
      if (!name.endsWith('.json') || name.endsWith('.incoming')) continue
      const source = json(root, join(observations, name))
      if (!/^[a-zA-Z0-9_-]{1,120}$/.test(source?.id) || `${source.id}.json` !== name
        || source.experimentId !== request.experimentId || source.serverId !== request.serverId) throw new Error('Archive source ownership differs')
      add(join(observations, source.id + '.jsonl'), { id: source.id, kind: 'log', format: 'observations', source, label: source.label })
    }
    for (const name of ['metrics', 'training']) {
      const path = join(observations, name + '.jsonl')
      if (!existsSync(path)) continue
      for (const line of readFileSync(contained(root, path), 'utf8').split('\n').filter(Boolean)) {
        const sample = JSON.parse(line)
        if (sample.experimentId !== request.experimentId || sample.serverId !== request.serverId) throw new Error('Archive metric ownership differs')
        if (request.metricsAfter === undefined || sample.time >= request.metricsAfter) result.metrics.push(sample)
      }
    }
  }
  const nodeHome = join(request.controlRoot, 'state/node-home')
  const allocation = json(request.controlRoot, join(nodeHome, 'storages/aspera_node/allocations', request.experimentId + '.json'))
  if (allocation !== undefined && allocation.record?.node?.server?.id !== request.serverId) throw new Error('Archive allocation belongs to another node')
  const commandDirectory = join(nodeHome, 'storages/aspera_node/commands')
  if (existsSync(commandDirectory)) {
    contained(request.controlRoot, commandDirectory)
    for (const name of readdirSync(commandDirectory)) {
      if (!name.startsWith(request.experimentId + '_') || !name.endsWith('.json')) continue
      if (result.processes.length >= max) { result.truncated = true; break }
      const row = json(request.controlRoot, join(commandDirectory, name))?.record
      if (row?.experimentId !== request.experimentId || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.commandId)) throw new Error('Archive command ownership differs')
      const streams = ['stdout', 'stderr'].filter(stream => existsSync(join(root, 'process-logs', row.commandId, stream + '.log')))
      result.processes.push({ experimentId: request.experimentId, serverId: request.serverId, commandId: row.commandId,
        state: row.state, exitCode: row.exitCode ?? null, released: row.released, command: row.command, streams,
        ...(row.detail === undefined ? {} : { detail: row.detail }) })
      for (const stream of streams) add(join(root, 'process-logs', row.commandId, stream + '.log'), {
        id: `pipe-${stream}-${row.commandId}`, kind: 'process-log', format: 'text', commandId: row.commandId, stream,
        label: `${row.commandId} ${stream}` })
    }
  }
  add(join(root, 'node.log'), { id: 'legacy-node', kind: 'log', format: 'text', stream: 'mixed', label: 'node.log' })
  for (const folder of ['environment-runtime-v1', 'environment-launches-v1', 'environment-operations-v1', 'material-operations-v1']) {
    const directory = join(root, folder)
    if (!existsSync(directory)) continue
    contained(root, directory)
    for (const name of readdirSync(directory)) {
      if (result.sources.length >= max) { result.truncated = true; break }
      const nested = folder.endsWith('operations-v1')
      if (!(nested ? /^[a-f0-9-]{36}$/ : /^[a-f0-9-]{36}\.json$/).test(name)) continue
      const operationId = nested ? name : name.slice(0, -5)
      const paths = [join(directory, name)]
      if (nested) {
        contained(root, paths[0])
        paths.splice(0, 1, ...readdirSync(join(directory, name)).filter(file => /^(?:receipt(?:-[\w-]+)?|reuse-plan|runtime|cache-import|copy-plan|failure)\.v1\.json$/.test(file)).map(file => join(directory, name, file)))
      }
      for (const path of paths) {
        if (result.sources.length >= max) { result.truncated = true; break }
        const record = json(root, path)
        if (record === undefined) continue
        if (record.version !== 1 || record.experimentId !== request.experimentId || record.serverId !== request.serverId || record.operationId !== operationId) throw new Error('Archive managed operation ownership differs')
        const label = relative(root, path).split(sep).join('/')
        add(path, { id: 'environment-' + createHash('sha256').update(label).digest('hex').slice(0, 32), kind: 'log', format: 'text', stream: 'mixed', phase: 'execution', label })
      }
    }
  }
  for (const folder of ['environment-borrowings-v1', 'storage-plans-v1', 'material-bindings-v1']) {
    const directory = join(root, folder)
    if (!existsSync(directory)) continue
    contained(root, directory)
    for (const name of readdirSync(directory)) {
      if (result.sources.length >= max) { result.truncated = true; break }
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue
      const path = join(directory, name), record = json(root, path)
      if (record?.version !== 1 || record.experimentId !== request.experimentId || record.serverId !== request.serverId) throw new Error('Archive storage record ownership differs')
      const label = relative(root, path).split(sep).join('/')
      add(path, { id: 'storage-' + createHash('sha256').update(label).digest('hex').slice(0, 32), kind: 'log', format: 'text', stream: 'mixed', phase: 'execution', label })
    }
  }
  const workspace = join(root, 'workspace')
  let inspected = 0
  function walk(directory) {
    contained(root, directory)
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (++inspected > max * 20) { result.truncated = true; return }
      if (entry.isSymbolicLink() || request.excludeDirectories.includes(entry.name)) continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) {
        const rel = relative(workspace, path).split(sep).join('/')
        if (request.logPatterns.some(pattern => matchesGlob(rel, pattern))) add(path, {
          id: 'workspace-' + createHash('sha256').update(rel).digest('hex').slice(0, 32), kind: 'log', format: 'text',
          stream: 'mixed', phase: 'execution', label: rel })
      }
    }
  }
  if (existsSync(workspace)) walk(workspace)
  return result
}

/** @param request - verified source, expected generation and byte interval. @returns bytes from that source only. */
export function archiveRead(request) {
  const root = own(request)
  if (isAbsolute(request.path) || request.path.split(/[\\/]/).includes('..')) throw new Error('Archive path is outside the experiment')
  const path = contained(root, resolve(root, request.path))
  const observed = statSync(path)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile() || generation(stats) !== generation(observed) || generation(stats) !== request.generation || request.offset > stats.size) {
      throw new Error('Archive source generation changed')
    }
    const bytes = Buffer.alloc(Math.min(request.limit, stats.size - request.offset))
    const count = readSync(fd, bytes, 0, bytes.length, request.offset)
    return { data: bytes.subarray(0, count).toString('base64'), offset: request.offset, nextOffset: request.offset + count,
      generation: generation(stats), length: stats.size, eof: request.offset + count >= stats.size }
  } finally { closeSync(fd) }
}
