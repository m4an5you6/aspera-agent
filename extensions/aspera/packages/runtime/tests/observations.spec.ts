/** Observation files retain full output, bound reads, and reject foreign cursors. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { observationSourceSchema, observationPolicySchema } from '@aspera/experiments'
import { importObservation, ObservationWriter, observationSources, readObservation } from '../src/observations.ts'
import { readMetricSamples, saveMetricSample } from '../src/metrics.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })
function fixture() {
  mkdirSync('.artifacts', { recursive: true })
  const root = mkdtempSync(resolve('.artifacts/observations-')); directories.push(root)
  const source = observationSourceSchema.parse({ version: 1, id: 'process-a', kind: 'process', experimentId: randomUUID(),
    serverId: randomUUID(), commandId: 'a', label: 'Training', createdAt: 10, streams: ['stdout', 'stderr'], complete: false })
  const request = { experimentId: source.experimentId, serverId: source.serverId, sourceId: source.id, stream: 'all' as const, limit: 1024 }
  return { root, source, request }
}

it('captures split UTF-8 and credentials before truncation, with resumable filtered reads', () => {
  const { root, source, request } = fixture()
  const secret = 'private-fixture-value'
  const writer = new ObservationWriter(root, source, [secret])
  const prefix = 'x'.repeat(70000)
  writer.append('stdout', prefix + secret.slice(0, 9))
  writer.append('stdout', secret.slice(9) + '\n')
  const bytes = Buffer.from('准备🙂\n')
  writer.append('stderr', bytes.subarray(0, 2)); writer.append('stderr', bytes.subarray(2))
  writer.append('stderr', 'Authorization: Bearer api-fixture-token\n')
  writer.append('stderr', '{"Authorization":"Bearer quoted-fixture-token"}\n')
  writer.close()
  let page = readObservation(root, { ...request, fromStart: true })
  const output = [...page.lines]
  while (page.hasMore) { page = readObservation(root, { ...request, cursor: page.cursor }); output.push(...page.lines) }
  expect(output.map(line => line.text).join('')).toBe(prefix + '[redacted]\n准备🙂\nAuthorization: [redacted]\n{"Authorization":"[redacted]"}\n')
  expect(new Set(output.map(line => line.seq)).size).toBe(output.length)
  expect(observationSources(root)).toMatchObject([{ complete: true }])
  const stderr = { ...request, stream: 'stderr' as const }
  page = readObservation(root, { ...stderr, fromStart: true })
  const filtered = [...page.lines]
  while (page.hasMore) { page = readObservation(root, { ...stderr, cursor: page.cursor }); filtered.push(...page.lines) }
  expect(filtered.every(line => line.stream === 'stderr')).toBe(true)
  expect(filtered.map(line => line.text).join('')).toContain('准备🙂')
})

it('pages backwards without overlaps and reports rotation, missing files and incomplete capture', () => {
  const { root, source, request } = fixture(); const writer = new ObservationWriter(root, source)
  for (let index = 0; index < 100; index++) writer.append('stdout', `line ${index}\n`)
  writer.close(false)
  let page = readObservation(root, request); const seen = new Set(page.lines.map(line => line.seq))
  while (page.hasEarlier) {
    const before = page.before.offset
    page = readObservation(root, { ...request, before: page.before })
    expect(page.before.offset).toBeLessThan(before)
    for (const line of page.lines) { expect(seen.has(line.seq)).toBe(false); seen.add(line.seq) }
  }
  expect(seen.size).toBe(100)
  expect(observationSources(root)[0]?.complete).toBe(false)
  for (const changed of [{ experimentId: randomUUID() }, { serverId: randomUUID() }, { sourceId: 'different' }, { stream: 'stderr' as const }]) {
    expect(() => readObservation(root, { ...request, cursor: { ...page.cursor, ...changed } })).toThrow('another source')
  }
  const file = resolve(root, 'observations-v1/process-a.jsonl')
  renameSync(file, file + '.old'); writeFileSync(file, '')
  expect(readObservation(root, { ...request, cursor: page.cursor }).reset).toBe(true)
  rmSync(file)
  expect(readObservation(root, request).missing).toBe(true)
})

it('retains measured values and gaps without inventing missing GPU or training fields', () => {
  const { root, request } = fixture()
  const policy = observationPolicySchema.parse({ historyMs: 60000 })
  const owner = { experimentId: request.experimentId, serverId: request.serverId }
  saveMetricSample(root, { ...owner, time: 1, cpuPercent: 18, gpus: [] }, policy)
  saveMetricSample(root, { ...owner, time: 70000, gpus: [], error: 'unavailable' }, policy)
  expect(readMetricSamples(root, owner)).toEqual([{ ...owner, time: 70000, gpus: [], error: 'unavailable' }])
  expect(() => readMetricSamples(root, { ...owner, experimentId: randomUUID() })).toThrow('another experiment')
})

it('does not expose a labeled credential spanning a large unterminated line', () => {
  const { root, source, request } = fixture(); const writer = new ObservationWriter(root, source)
  writer.append('stdout', 'Authorization: Bearer ' + 'private'.repeat(12000))
  writer.append('stdout', 'credential-tail\nvisible output\n'); writer.close()
  const page = readObservation(root, { ...request, fromStart: true })
  expect(page.lines.map(line => line.text).join('')).toBe('Authorization: [redacted]\nvisible output\n')
})

it('resumes imported installation output after a long final record without replay or lost timestamps', () => {
  const { root, source } = fixture()
  const first = { seq: 0, time: 12, stream: 'stdout' as const, text: '编译🙂'.repeat(30000) + '\n' }
  const second = { seq: 1, time: 34, stream: 'stderr' as const, text: 'Authorization: Bearer private-value\n' }
  importObservation(root, source, [first], [])
  importObservation(root, { ...source, complete: true }, [first, second], [])
  const rows = readFileSync(resolve(root, 'observations-v1/process-a.jsonl'), 'utf8').trimEnd().split('\n').map(line => JSON.parse(line))
  expect(rows).toEqual([first, { ...second, text: 'Authorization: [redacted]\n' }])
  expect(() => importObservation(root, source, [{ ...second, seq: 3 }], [])).toThrow('missing interval')
})
