/** Private source registration and bounded, generation-aware observation reads. */
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { observationSourceSchema, observationReadSchema, observationLineSchema } from '@aspera/experiments'
import type { ObservationSource, ObservationRead, ObservationPage, ObservationCursor } from '@aspera/experiments'

/** Remove known credentials and labeled secrets before publication.
 * @param text - private text. @param secrets - credentials owned by this operation.
 * @param preserveLength - retain offsets when redacting a byte window encoded as Latin-1. @returns public text.
 */
export function redactObservation(text: string, secrets: readonly string[] = [], preserveLength = false): string {
  const replacement = (length: number): string => preserveLength ? '*'.repeat(length) : '[redacted]'
  for (const secret of secrets) if (secret.length > 0) text = text.split(secret).join(replacement(secret.length))
  const redact = (match: string, prefix: string): string => prefix + replacement(match.length - prefix.length)
  return text.replace(/(authorization\s*["']?\s*[:=]\s*["']?)(?:Bearer\s+|Basic\s+)?[^\s,;"'}]+/gi, redact)
    .replace(/((?:api[_-]?key|password|(?:access[_-]?)?token|secret)\s*["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, redact)
    .replace(/(["']?(?:headers|extraHeaders)["']?\s*:\s*)\{[^}]*\}/gi,
      (match: string, prefix: string) => preserveLength ? redact(match, prefix) : prefix + '{"redacted":true}')
}

/** @param root - pinned experiment directory. @returns its contained observation directory. */
export function observationRoot(root: string): string {
  const path = resolve(root, 'observations-v1')
  if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !realpathSync(path).startsWith(realpathSync(root) + sep))) throw new Error('Observation directory is outside the experiment')
  return path
}
function sourcePath(root: string, id: string, suffix: 'json' | 'jsonl'): string {
  const path = resolve(observationRoot(root), `${id}.${suffix}`)
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Observation files cannot be symbolic links')
  return path
}

/** @param root - pinned experiment directory. @param source - source identity. */
export function registerObservation(root: string, source: ObservationSource): void {
  source = observationSourceSchema.parse(source)
  mkdirSync(observationRoot(root), { recursive: true, mode: 0o700 })
  const path = sourcePath(root, source.id, 'json')
  if (existsSync(`${path}.incoming`) && lstatSync(`${path}.incoming`).isSymbolicLink()) throw new Error('Observation files cannot be symbolic links')
  if (existsSync(path)) {
    const old = observationSourceSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (old.experimentId !== source.experimentId || old.serverId !== source.serverId || old.kind !== source.kind || old.sessionId !== source.sessionId) throw new Error('Observation identity is already owned')
  }
  writeFileSync(`${path}.incoming`, JSON.stringify(source), { mode: 0o600 })
  renameSync(`${path}.incoming`, path)
}

/** @param root - experiment directory. @returns registered sources, without scanning arbitrary files. */
export function observationSources(root: string): ObservationSource[] {
  const directory = observationRoot(root)
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => name.endsWith('.json') && !name.endsWith('.incoming')).map(name => {
    const source = observationSourceSchema.parse(JSON.parse(readFileSync(sourcePath(root, name.slice(0, -5), 'json'), 'utf8')))
    if (`${source.id}.json` !== name) throw new Error('Observation filename does not match its identity')
    return source
  })
}

/** Import a supervised source without replaying rows after an interrupted cursor save.
 * @param root - experiment-owned local directory. @param source - registered remote attempt.
 * @param rows - complete ordered records. @param secrets - private credentials to redact.
 */
export function importObservation(root: string, source: ObservationSource, rows: ObservationPage['lines'], secrets: readonly string[]): void {
  registerObservation(root, source)
  const path = sourcePath(root, source.id, 'jsonl')
  let last = -1
  if (existsSync(path) && statSync(path).size > 0) {
    const size = statSync(path).size
    const fd = openSync(path, 'r')
    try {
      let length = Math.min(size, 65536)
      for (;;) {
        const tail = Buffer.alloc(length)
        readSync(fd, tail, 0, length, size - length)
        const boundary = tail.lastIndexOf(10, length - 2)
        if (boundary < 0 && length < size) { length = Math.min(size, length * 2); continue }
        last = observationLineSchema.parse(JSON.parse(tail.subarray(boundary + 1).toString('utf8').trimEnd())).seq
        break
      }
    } finally { closeSync(fd) }
  }
  for (const raw of rows) {
    const row = observationLineSchema.parse(raw)
    if (row.seq <= last) continue
    if (row.seq !== last + 1) throw new Error('Installation output has a missing interval')
    appendFileSync(path, JSON.stringify({ ...row, text: redactObservation(row.text, secrets) }) + '\n', { mode: 0o600 })
    last = row.seq
  }
}

/** Captures complete command output, with timestamps and stream order, before tool-result truncation. */
export class ObservationWriter {
  private readonly decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') }
  private readonly pending = { stdout: '', stderr: '' }
  private readonly secretTail = { stdout: false, stderr: false }
  private readonly path: string
  private closed = false
  constructor(private readonly root: string, private readonly source: ObservationSource, private readonly secrets: readonly string[] = []) {
    registerObservation(root, source)
    this.path = sourcePath(root, source.id, 'jsonl')
    appendFileSync(this.path, '', { mode: 0o600 })
  }
  /** @param stream - actual process output pipe. @param chunk - received bytes. */
  append(stream: 'stdout' | 'stderr', chunk: Buffer | string): void {
    if (this.closed) throw new Error('Observation capture has ended')
    let text = typeof chunk === 'string' ? chunk : this.decoders[stream].write(chunk)
    if (this.secretTail[stream]) {
      const delimiter = text.search(/[\s,"'};]/)
      if (delimiter < 0) return
      text = text.slice(delimiter); this.secretTail[stream] = false
    }
    this.pending[stream] += text
    const end = this.pending[stream].lastIndexOf('\n') + 1
    if (end > 0) { this.write(stream, this.pending[stream].slice(0, end)); this.pending[stream] = this.pending[stream].slice(end) }
    // Keep enough tail to redact credentials split across pipe chunks.
    const tail = Math.max(4096, ...this.secrets.map(secret => secret.length))
    if (this.pending[stream].length > 65536 + tail) {
      this.secretTail[stream] = /(?:authorization|api[_-]?key|password|(?:access[_-]?)?token|secret)\s*["']?\s*[:=]\s*["']?(?:Bearer\s+|Basic\s+)?[^\s,"'};]+$/i.test(this.pending[stream])
      this.pending[stream] = redactObservation(this.pending[stream], this.secrets)
      const end = this.pending[stream].length - tail
      if (end > 0) { this.write(stream, this.pending[stream].slice(0, end)); this.pending[stream] = this.pending[stream].slice(end) }
    }
  }
  private write(stream: 'stdout' | 'stderr', text: string): void {
    // Each JSONL record is bounded so a history read can always make progress.
    const safe = redactObservation(text, this.secrets)
    for (let index = 0; index < safe.length;) {
      let end = Math.min(safe.length, index + 4096)
      if (end < safe.length && /[\uD800-\uDBFF]/.test(safe[end - 1]!)) end--
      appendFileSync(this.path, JSON.stringify({ seq: statSync(this.path).size, time: Date.now(), stream, text: safe.slice(index, end) }) + '\n', { mode: 0o600 })
      index = end
    }
  }
  /** @param complete - whether the command's complete output and exit were observed. */
  close(complete = true): void {
    if (this.closed) return
    this.closed = true
    for (const stream of ['stdout', 'stderr'] as const) {
      this.write(stream, this.pending[stream] + this.decoders[stream].end()); this.pending[stream] = ''
    }
    registerObservation(this.root, { ...this.source, complete })
  }
}

/** Read complete JSONL rows, preserving both history and live cursors.
 * @param root - experiment-owned directory. @param raw - source and cursor. @returns bounded public records.
 */
export function readObservation(root: string, raw: ObservationRead): ObservationPage {
  const request = observationReadSchema.parse(raw)
  const source = observationSources(root).find(source => source.id === request.sourceId)
  if (source === undefined || source.experimentId !== request.experimentId || source.serverId !== request.serverId) throw new Error('Observation source belongs to another experiment or node')
  const previous = request.cursor ?? request.before
  if (previous !== undefined && (previous.experimentId !== request.experimentId || previous.serverId !== request.serverId || previous.sourceId !== request.sourceId || previous.stream !== request.stream)) throw new Error('Log cursor belongs to another source')
  const path = sourcePath(root, source.id, 'jsonl')
  const stats = existsSync(path) ? statSync(path) : undefined
  const generation = stats === undefined ? '' : `${stats.dev}:${stats.ino}:${stats.birthtimeMs}`
  const size = stats?.size ?? 0
  const reset = previous !== undefined && (previous.generation !== generation || previous.offset > size)
  const end = request.before !== undefined && !reset ? Math.min(size, request.before.offset) : size
  const start = request.cursor !== undefined && !reset ? request.cursor.offset : request.fromStart ? 0 : Math.max(0, end - request.limit)
  let offset = start
  let first = start
  const lines: ObservationPage['lines'] = []
  if (stats !== undefined && start < end) {
    const fd = openSync(path, 'r')
    try {
      const bytes = Buffer.alloc(Math.min(end - start, request.limit + 65536))
      const length = readSync(fd, bytes, 0, bytes.length, start)
      let boundary = 0
      if (start > 0 && request.cursor === undefined) {
        const prior = Buffer.alloc(1); readSync(fd, prior, 0, 1, start - 1)
        if (prior[0] !== 10) boundary = bytes.indexOf(10) + 1
      }
      offset = start + boundary
      first = offset
      while (boundary < length) {
        const newline = bytes.indexOf(10, boundary)
        if (newline < 0 || start + newline >= end) break
        const line = observationLineSchema.parse(JSON.parse(bytes.subarray(boundary, newline).toString('utf8')))
        if (request.stream === 'all' || line.stream === request.stream) lines.push(line)
        boundary = newline + 1; offset = start + boundary
        if (offset - start >= request.limit) break
      }
    } finally { closeSync(fd) }
  }
  const cursor = (offset: number): ObservationCursor => ({ experimentId: request.experimentId, serverId: request.serverId,
    sourceId: request.sourceId, stream: request.stream, generation, offset })
  return { lines, cursor: cursor(offset), before: cursor(first), hasEarlier: first > 0,
    hasMore: offset < size, missing: stats === undefined, reset }
}
