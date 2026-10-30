/** Submitted JSON stays readable without spilling base64 or requiring a shell. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readSubmittedInput } from '../src/submitted-input.ts'
const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function fixture(bytes: string | Buffer) {
  const parent = resolve('.artifacts'); mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(resolve(parent, 'submitted-input-')); roots.push(root)
  writeFileSync(resolve(root, 'plan.json'), bytes)
  return (offset = 0, generation?: string, encoding?: 'utf8' | 'base64') => readSubmittedInput(root, ['plan.json'], { name: 'plan.json', offset, generation, encoding }, 8)
}
it('pages complete JSON text across UTF-8 characters without generating a shell command', () => {
  const original = JSON.stringify({ plan: '训练😀'.repeat(100) }), read = fixture(original)
  let page = read(), text = '', count = 0
  for (;;) {
    expect(page).not.toHaveProperty('data'); expect(page.encoding).toBe('utf8')
    if (!('text' in page)) throw new Error('Expected text page')
    text += page.text; count += 1
    expect(Buffer.byteLength(page.text)).toBeLessThanOrEqual(8)
    if (page.eof) break
    expect(page.nextOffset).toBeGreaterThan(page.offset); page = read(page.nextOffset, page.generation)
  }
  expect(count).toBeGreaterThan(100); expect(text).toBe(original); expect(JSON.parse(text).plan).toBe('训练😀'.repeat(100))
})
it('keeps binary input available through an explicit base64 request', () => {
  const bytes = Buffer.from([255, 254, 0, 128]), read = fixture(bytes)
  expect(() => read()).toThrow('encoding=base64')
  const page = read(0, undefined, 'base64')
  if (!('data' in page)) throw new Error('Expected binary page')
  expect(Buffer.from(page.data, 'base64')).toEqual(bytes)
})
it('rejects unsubmitted names before reading another file', () => {
  expect(() => readSubmittedInput('.', ['plan.json'], { name: '../secret', offset: 0 }, 8)).toThrow('outside this experiment')
})
it('keeps file replacement detection and its generation cursor', () => {
  const read = fixture('one page of input'), page = read()
  expect(read(page.nextOffset, 'another-generation')).toMatchObject({ reset: true, offset: 0, generation: page.generation })
})
