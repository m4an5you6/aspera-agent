/** Content-addressed deployment of built extension packages and published DSH dependencies. */
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { create } from 'tar'
import { run } from './transport.ts'

/** Private deployment archive; disposing it never changes installed releases. */
export interface SourceSnapshot {
  readonly directory: string; readonly archive: string; readonly digest: string; readonly archiveHash: string
  /** Remove only this owned temporary archive. */
  dispose(): void
}

/** Package built artifacts using each package's published file list.
 * @param root - independent extension workspace, with built lib files.
 * @param timeoutMs - package-manager deadline.
 * @param signal - cancellation.
 * @returns complete immutable release; caller disposes the temporary directory.
 */
export async function snapshotSource(root: string, timeoutMs: number, signal?: AbortSignal): Promise<SourceSnapshot> {
  const directory = mkdtempSync(join(tmpdir(), 'aspera-release-'))
  const source = join(directory, 'release'); const archive = join(directory, 'release.tar')
  mkdirSync(source)
  try {
    const dependencies: Record<string, string> = { '@deepseek-ai/dsh': '0.2.0-rc.2' }
    const overrides: Record<string, string> = {}
    const digest = createHash('sha256')
    for (const name of ['experiments', 'runtime', 'dispatch', 'console']) {
      signal?.throwIfAborted()
      const pkg = existsSync(resolve(root, 'packages', name, 'package.json'))
        ? resolve(root, 'packages', name) : resolve(root, 'node_modules', '@aspera', name)
      const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'))
      if (!existsSync(join(pkg, 'lib', 'index.js'))) throw new Error(`build @aspera/${name} before deploying`)
      if (name === 'console' && !existsSync(join(pkg, 'lib', 'client.js'))) throw new Error('build the browser bundle before deploying')
      const staged = join(directory, name, 'package'); mkdirSync(staged, { recursive: true })
      const files: string[] = []
      const copy = (relative: string): void => {
        const input = join(pkg, relative)
        if (!existsSync(input)) return
        const entries = readdirSync(input, { withFileTypes: true })
        for (const entry of entries) {
          const path = `${relative}/${entry.name}`
          if (entry.isDirectory()) copy(path)
          else if (entry.isFile() && !entry.name.endsWith('.tsbuildinfo')) {
            const output = join(staged, path); mkdirSync(resolve(output, '..'), { recursive: true }); copyFileSync(join(pkg, path), output); files.push(path)
          }
        }
      }
      for (const relative of ['lib', 'scripts', 'skills']) copy(relative)
      for (const relative of ['worker.patch.yml', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'LICENSE']) if (existsSync(join(pkg, relative))) { copyFileSync(join(pkg, relative), join(staged, relative)); files.push(relative) }
      for (const section of ['dependencies', 'peerDependencies']) for (const [dependency, version] of Object.entries(manifest[section] ?? {})) if (version === 'workspace:*') {
        const sibling = dependency.replace('@aspera/', '')
        const path = existsSync(resolve(root, 'packages', sibling, 'package.json')) ? resolve(root, 'packages', sibling, 'package.json') : resolve(root, 'node_modules', '@aspera', sibling, 'package.json')
        manifest[section][dependency] = JSON.parse(readFileSync(path, 'utf8')).version
      }
      delete manifest.devDependencies; delete manifest.scripts
      writeFileSync(join(staged, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
      files.push('package.json')
      for (const file of files.sort()) { digest.update(name + '/' + file + '\0'); digest.update(readFileSync(join(staged, file))); digest.update('\0') }
      const tarball = `${name}.tgz`
      await create({ cwd: resolve(staged, '..'), file: join(source, tarball), gzip: true, portable: true, mtime: new Date(0) }, ['package'])
      dependencies[manifest.name] = `file:./${tarball}`; overrides[manifest.name] = `file:./${tarball}`
    }
    dependencies['@deepseek-ai/dsh-base'] = '0.2.0-rc.2'
    dependencies['@deepseek-ai/dsh-web-app'] = '0.2.0-rc.2'
    const application = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
    const releaseManifest = { name: 'aspera-installed-release', private: true, type: 'module',
      packageManager: application.packageManager, engines: application.engines, dependencies }
    writeFileSync(join(source, 'package.json'), JSON.stringify(releaseManifest, null, 2) + '\n')
    copyFileSync(resolve(root, 'pnpm-workspace.yaml'), join(source, 'pnpm-workspace.yaml'))
    const patchRoot = resolve(root, 'patches')
    if (!existsSync(patchRoot)) throw new Error('Aspera sidebar compatibility patch is missing')
    mkdirSync(join(source, 'patches'))
    for (const patch of readdirSync(patchRoot).sort()) {
      copyFileSync(join(patchRoot, patch), join(source, 'patches', patch))
      digest.update(`patches/${patch}\0`); digest.update(readFileSync(join(patchRoot, patch)))
    }
    appendOverrides(source, overrides)
    writeFileSync(join(source, '.npmrc'), 'registry=https://registry.npmjs.org/\n')
    copyFileSync(existsSync(resolve(root, 'setup.mjs')) ? resolve(root, 'setup.mjs') : resolve(root, 'scripts', 'installed-setup.mjs'), join(source, 'setup.mjs'))
    copyFileSync(resolve(root, 'pnpm-lock.yaml'), join(source, 'pnpm-lock.yaml'))
    copyFileSync(resolve(root, 'LICENSE'), join(source, 'LICENSE'))
    const pnpmCli = process.env.npm_execpath
    if (pnpmCli === undefined || !existsSync(pnpmCli)) throw new Error('launch Aspera through pnpm so its pinned package manager can produce the deployment lockfile')
    await run(process.execPath, [pnpmCli, '--dir', source, 'install', '--lockfile-only', '--offline', '--ignore-scripts'], timeoutMs, signal)
    for (const file of ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'setup.mjs', 'LICENSE']) { digest.update(file + '\0'); digest.update(readFileSync(join(source, file))) }
    const identity = digest.digest('hex')
    writeFileSync(join(source, 'aspera-release.json'), JSON.stringify({ version: 1, deploymentId: identity, dsh: '0.2.0-rc.2', extension: '0.1.1' }) + '\n')
    await create({ cwd: source, file: archive, portable: true, mtime: new Date(0) }, readdirSync(source))
    const archiveHash = createHash('sha256').update(readFileSync(archive)).digest('hex')
    return { directory, archive, digest: identity, archiveHash, dispose: () => { rmSync(directory, { recursive: true, force: true }) } }
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
}

function appendOverrides(source: string, overrides: Record<string, string>): void {
  const path = join(source, 'pnpm-workspace.yaml')
  const settings = readFileSync(path, 'utf8').split('\noverrides:\n')[0]
  writeFileSync(path, settings + '\noverrides:\n' + Object.entries(overrides).map(([name, value]) => `  '${name}': '${value}'\n`).join(''))
}
