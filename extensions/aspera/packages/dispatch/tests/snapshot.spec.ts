/** Fixed desktop releases remain deployable without a writable or populated npm cache. */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract } from 'tar'
import { afterEach, expect, it, vi } from 'vitest'
import { snapshotSource, verifySourceArchive } from '../src/snapshot.ts'
import { run } from '../src/transport.ts'

vi.mock('../src/transport.ts', () => ({ run: vi.fn(async () => '') }))
vi.mock('../src/published-ui.ts', () => ({ assertPublishedUiCompatibility: vi.fn() }))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'aspera-snapshot-test-')); roots.push(root)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@11.7.0', engines: { node: '^22.19.0 || >=24' }, asperaStageAttemptVersion: 1, asperaStageEvidenceVersion: 4, asperaAgentRecoveryVersion: 1, asperaServiceVerificationVersion: 1 }))
  for (const [name, content] of Object.entries({ 'pnpm-lock.yaml': 'lockfileVersion: 9\n', 'pnpm-workspace.yaml': 'packages: []\n', 'setup.mjs': '// fixed setup\n', LICENSE: 'MIT\n' })) writeFileSync(join(root, name), content)
  mkdirSync(join(root, 'patches')); writeFileSync(join(root, 'patches', 'ui.patch'), 'fixed rendering patch\n')
  for (const name of ['experiments', 'runtime', 'dispatch', 'console']) {
    const pkg = join(root, 'packages', name); mkdirSync(join(pkg, 'lib'), { recursive: true })
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: `@aspera/${name}`, version: '0.1.1', type: 'module', devDependencies: { test: '1' } }))
    writeFileSync(join(pkg, 'lib', 'index.js'), `export const name = '${name}'\n`)
    if (name === 'console') writeFileSync(join(pkg, 'lib', 'client.js'), '// browser renderer\n')
  }
  vi.stubEnv('npm_execpath', join(root, 'setup.mjs'))
  return root
}

async function desktop(): Promise<{ root: string; digest: string }> {
  const source = await snapshotSource(workspace(), 30000)
  const root = mkdtempSync(join(tmpdir(), 'aspera-desktop-snapshot-test-')); roots.push(root)
  try {
    await extract({ file: source.archive, cwd: root, strict: true })
    for (const name of ['experiments', 'runtime', 'dispatch', 'console']) {
      const cwd = join(root, 'node_modules', '@aspera', name); mkdirSync(cwd, { recursive: true })
      await extract({ file: join(root, `${name}.tgz`), cwd, strip: 1, strict: true })
    }
    copyFileSync(source.archive, join(root, 'aspera-release.tar'))
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    manifest.dependencies.pnpm = '11.7.0'
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
    vi.stubEnv('npm_execpath', undefined)
    vi.mocked(run).mockClear()
    return { root, digest: source.digest }
  } finally { source.dispose() }
}

it('reuses and verifies the sealed desktop release without invoking a package manager', async () => {
  const { root, digest } = await desktop()
  const recovered = await snapshotSource(root, 30000)
  try {
    expect(recovered.digest).toBe(digest)
    expect(JSON.parse(readFileSync(join(recovered.directory, 'release', 'package.json'), 'utf8')).asperaStageAttemptVersion).toBe(1)
    expect(JSON.parse(readFileSync(join(recovered.directory, 'release', 'package.json'), 'utf8')).asperaStageEvidenceVersion).toBe(4)
    expect(JSON.parse(readFileSync(join(recovered.directory, 'release', 'package.json'), 'utf8')).asperaAgentRecoveryVersion).toBe(1)
    expect(JSON.parse(readFileSync(join(recovered.directory, 'release', 'package.json'), 'utf8')).asperaServiceVerificationVersion).toBe(1)
    expect((await verifySourceArchive(recovered.archive, digest)).pnpm).toBe('11.7.0')
    expect(run).not.toHaveBeenCalled()
  } finally { recovered.dispose() }
})

it.each(['changed', 'extra', 'missing', 'requirements', 'stage-attempts', 'stage-evidence', 'agent-recovery', 'patch'])('rejects a sealed desktop whose installed %s files differ', async kind => {
  const { root } = await desktop()
  const index = join(root, 'node_modules', '@aspera', 'runtime', 'lib', 'index.js')
  if (kind === 'missing') rmSync(index)
  else if (kind === 'extra') writeFileSync(join(root, 'node_modules', '@aspera', 'runtime', 'lib', 'extra.js'), 'extra')
  else if (kind === 'requirements') {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); manifest.engines.node = '>=99'
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  } else if (kind === 'stage-attempts') {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); delete manifest.asperaStageAttemptVersion
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  } else if (kind === 'stage-evidence') {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); delete manifest.asperaStageEvidenceVersion
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  } else if (kind === 'agent-recovery') {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')); delete manifest.asperaAgentRecoveryVersion
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest))
  } else if (kind === 'patch') writeFileSync(join(root, 'patches', 'ui.patch'), 'changed')
  else writeFileSync(index, '// changed installed runtime')
  await expect(snapshotSource(root, 30000)).rejects.toThrow(/differs|differ|build @aspera/)
  expect(run).not.toHaveBeenCalled()
})

it('rejects a bundled release with an altered deployment identity', async () => {
  const { root } = await desktop()
  writeFileSync(join(root, 'aspera-release.json'), JSON.stringify({ version: 1, deploymentId: '0'.repeat(64), dsh: '0.2.0-rc.2', extension: '0.1.1' }))
  await expect(snapshotSource(root, 30000)).rejects.toThrow()
  expect(run).not.toHaveBeenCalled()
})

it('allows source builds to fetch missing pinned registry metadata', async () => {
  const source = await snapshotSource(workspace(), 30000)
  try { expect(vi.mocked(run).mock.calls[0]?.[1]).toContain('--prefer-offline') }
  finally { source.dispose() }
})

it('verifies historical release manifests that do not declare stage-attempt or evidence capabilities', async () => {
  const root = workspace(), path = join(root, 'package.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8')); delete manifest.asperaStageAttemptVersion; delete manifest.asperaStageEvidenceVersion
  writeFileSync(path, JSON.stringify(manifest))
  const source = await snapshotSource(root, 30000)
  try { expect((await verifySourceArchive(source.archive, source.digest)).pnpm).toBe('11.7.0') }
  finally { source.dispose() }
})
