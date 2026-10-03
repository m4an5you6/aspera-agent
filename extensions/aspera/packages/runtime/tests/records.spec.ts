/** Phase readers bind cursors to real Sessions and retain incomplete tails for the next read. */
import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { experimentIdSchema } from '@aspera/experiments'
import { readPhaseRecords } from '../src/records.ts'
const directories: string[] = []
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

it('isolates phases, pages without duplicates and reports replacement and missing files', async () => {
  mkdirSync('.artifacts', { recursive: true })
  const dir = mkdtempSync(resolve('.artifacts/records-')); directories.push(dir)
  const file = resolve(dir, 'events.jsonl'); const experimentId = experimentIdSchema.parse(randomUUID())
  const request = { experimentId, phase: 'planning' as const, limit: 1 }
  const event = (sessionId: string, source: string, seq: number) => JSON.stringify({ sessionId, source, event: { seq, time: seq + 1, type: 'tool/call', data: { name: 'run_experiment_command', arguments: JSON.stringify({ server_id: randomUUID(), run_id: 'trial' }) } } }) + '\n'
  writeFileSync(file, event('plan', 'plan', 0) + event('other', 'execution', 0) + event('plan', 'plan', 1))
  const first = await readPhaseRecords(file, request, 'plan', 4096)
  expect(first.records.map(value => value.seq)).toEqual([0]); expect(first.hasMore).toBe(true)
  expect(first.records[0]?.log?.commandId).toBe('trial')
  const second = await readPhaseRecords(file, { ...request, cursor: first.cursor }, 'plan', 4096)
  expect(second.records.map(value => value.seq)).toEqual([1]); expect(second.hasMore).toBe(false)
  await expect(readPhaseRecords(file, { ...request, cursor: first.cursor, phase: 'execution' }, 'other', 4096)).rejects.toThrow('another experiment, phase or Session')
  await expect(readPhaseRecords(file, { ...request, cursor: first.cursor, experimentId: randomUUID() }, 'plan', 4096)).rejects.toThrow('another experiment')
  const tail = event('plan', 'plan', 2); appendFileSync(file, tail.slice(0, -1))
  expect((await readPhaseRecords(file, { ...request, cursor: second.cursor }, 'plan', 4096)).records).toEqual([])
  appendFileSync(file, '\n')
  expect((await readPhaseRecords(file, { ...request, cursor: second.cursor }, 'plan', 4096)).records[0]?.seq).toBe(2)
  renameSync(file, file + '.old'); writeFileSync(file, event('plan', 'plan', 0))
  expect(await readPhaseRecords(file, { ...request, cursor: second.cursor }, 'plan', 4096)).toMatchObject({ reset: true, records: [{ seq: 0 }] })
  expect(await readPhaseRecords(file + '.missing', request, 'plan', 4096)).toMatchObject({ missing: true, records: [] })
})
