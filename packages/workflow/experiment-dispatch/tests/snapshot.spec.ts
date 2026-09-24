import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { snapshotSource } from '../src/snapshot.ts'

it('archives local source edits while excluding credentials, dependencies, and training inputs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-experiment-source-'))
  let first: Awaited<ReturnType<typeof snapshotSource>> | undefined
  let second: Awaited<ReturnType<typeof snapshotSource>> | undefined
  try {
    for (const dir of ['apps/cli', 'packages/workflow/new-plugin/src', 'data', 'secrets', 'node_modules', 'artifacts']) {
      mkdirSync(join(root, dir), { recursive: true })
    }
    const files = new Map([
      ['apps/cli/package.json', '{}\n'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9\n'],
      ['packages/workflow/new-plugin/src/index.ts', 'export const version = 1\n'],
      ['.env', 'SECRET=private\n'],
      ['data/train.jsonl', '{"sample": 1}\n'],
      ['secrets/token.json', '{"token": "private"}\n'],
      ['node_modules/dependency.js', 'module.exports = 1\n'],
      ['artifacts/output.txt', 'trained\n'],
    ])
    for (const [name, content] of files) writeFileSync(join(root, name), content)
    execFileSync('git', ['init', '-q', root])
    execFileSync('git', ['-C', root, 'add', 'apps/cli/package.json', 'pnpm-lock.yaml'])

    first = await snapshotSource(root, 60_000)
    const listing = execFileSync('tar', ['-tf', first.archive], { encoding: 'utf8' }).replaceAll('\\', '/')
    expect(listing).toContain('packages/workflow/new-plugin/src/index.ts')
    for (const excluded of ['.env', 'data/train.jsonl', 'secrets/token.json', 'node_modules/dependency.js', 'artifacts/output.txt']) {
      expect(listing).not.toContain(excluded)
    }
    writeFileSync(join(root, 'packages/workflow/new-plugin/src/index.ts'), 'export const version = 2\n')
    second = await snapshotSource(root, 60_000)
    expect(second.digest).not.toBe(first.digest)
  } finally {
    second?.dispose()
    first?.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
