/** Fixed deployment settings retain new document limits without adding them to old records. */
import { expect, it } from 'vitest'
import { pinnedTargetSchema } from '../src/deployment-settings.ts'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { environmentRequirements } from '../src/environment.ts'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

it('executes the SSH planning-manifest reader with current and rejected formats', () => {
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', fileURLToPath(new URL('./deployment_manifest_test.py', import.meta.url))],
    { encoding: 'utf8', timeout: 20000, stdio: 'pipe' })
})

const target = { host: 'example.invalid', sshPort: 22, remotePort: 9000, localRepo: '/fixed', dataRoots: [],
  preparationOutputChars: 65536, tokenRef: 'fixture', agentCredentialRefs: [], toolTimeoutMs: 300000, controlPollIntervalMs: 1000 }

it('pins document limits for a new deployment while retaining absent historical values', () => {
  const original = pinnedTargetSchema.parse(target)
  expect(original).not.toHaveProperty('documentationReadTimeoutMs'); expect(original).not.toHaveProperty('documentationPageBytes')
  expect(pinnedTargetSchema.parse({ ...target, documentationReadTimeoutMs: 12345, documentationPageBytes: 4096 })).toMatchObject({ documentationReadTimeoutMs: 12345, documentationPageBytes: 4096 })
  for (const value of [0, -1, Infinity, NaN, 0.5]) expect(pinnedTargetSchema.safeParse({ ...target, documentationReadTimeoutMs: value }).success).toBe(false)
  expect(pinnedTargetSchema.safeParse({ ...target, documentationPageBytes: 512 }).success).toBe(false)
})

it('validates the advertised planning format and still reads releases without planning tools', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'aspera-planning-manifest-'))
  const manifest = { engines: { node: '>=22.19.0' }, packageManager: 'pnpm@11.7.0' }
  try {
    writeFileSync(resolve(root, 'package.json'), JSON.stringify(manifest))
    expect(environmentRequirements(root)).toEqual({ node: '>=22.19.0', pnpm: '11.7.0' })
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ ...manifest, asperaPlanningTools: { version: 1, formatVersion: '0.1.0' } }))
    expect(environmentRequirements(root).node).toBe('>=22.19.0')
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ ...manifest, asperaPlanningTools: { version: 1, formatVersion: '0.1.0', requirementsVersion: 1 } }))
    expect(environmentRequirements(root).node).toBe('>=22.19.0')
    writeFileSync(resolve(root, 'package.json'), JSON.stringify({ ...manifest, asperaPlanningTools: { version: 1, formatVersion: '0.1.0', requirementsVersion: 1, inferenceVersion: 1 } }))
    expect(environmentRequirements(root).node).toBe('>=22.19.0')
    for (const asperaPlanningTools of [{ version: 2, formatVersion: '0.1.0' }, { version: 1, formatVersion: '0.1.99' }, { version: 1, formatVersion: '0.1.0', requirementsVersion: 2 }, { version: 1, formatVersion: '0.1.0', inferenceVersion: 2 }, { version: 1, formatVersion: '0.1.0', unknown: 1 }]) {
      writeFileSync(resolve(root, 'package.json'), JSON.stringify({ ...manifest, asperaPlanningTools }))
      expect(() => environmentRequirements(root)).toThrow()
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
