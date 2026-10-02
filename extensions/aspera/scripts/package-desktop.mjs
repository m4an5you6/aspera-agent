/** Produce an independent, unsigned Windows application carrying its frozen DSH runtime. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { extract } from 'tar'
import { snapshotSource } from '../packages/dispatch/lib/snapshot.js'
import { command } from './test-app.mjs'
import { buildWindowsDesktop } from './windows-desktop.mjs'

const root = resolve(import.meta.dirname, '..'); const application = resolve(root, 'apps/desktop')
process.env.ELECTRON_BUILDER_CACHE = resolve(process.env.ASPERA_DESKTOP_BUILD_CACHE || resolve(root, '.artifacts/desktop-tool-cache'))
mkdirSync(process.env.ELECTRON_BUILDER_CACHE, { recursive: true })
writeFileSync(resolve(process.env.ELECTRON_BUILDER_CACHE, 'package.json'), '{"private":true,"type":"commonjs"}\n')
const require = createRequire(resolve(application, 'package.json'))
const { createPackageWithOptions } = require('@electron/asar')
const desktopVersion = JSON.parse(readFileSync(resolve(application, 'package.json'), 'utf8')).version
const pnpm = process.env.npm_execpath
assert.ok(pnpm, 'Run this build through pnpm')
const artifacts = resolve(root, '.artifacts'); mkdirSync(artifacts, { recursive: true })
const work = mkdtempSync(resolve(artifacts, 'desktop-build-')); const runtime = resolve(work, 'runtime')
mkdirSync(runtime)
const snapshot = await snapshotSource(root, 120000)
try {
  console.log('Preparing frozen desktop runtime dependencies')
  await extract({ file: snapshot.archive, cwd: runtime, strict: true })
  const manifestPath = resolve(runtime, 'package.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies.pnpm = '11.7.0'
  manifest.dependencies['@deepseek-ai/dsh-host-directory-picker-browse'] = '0.2.0-rc.2'
  manifest.dependencies['@deepseek-ai/dsh-client-ui-directory-picker-browse'] = '0.2.0-rc.2'
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const store = dirname((await command(process.execPath, [pnpm, 'store', 'path'], root)).trim())
  await command(process.execPath, [pnpm, '--dir', runtime, 'install', '--lockfile-only', '--offline', '--ignore-scripts'], root)
  await command(process.execPath, [pnpm, '--dir', runtime, 'install', '--offline', '--frozen-lockfile', '--prod', '--node-linker=hoisted', '--store-dir', store], root)
  await command(process.execPath, ['scripts/assets.mjs'], application)
  await command(process.execPath, ['scripts/bundle-desktop.mjs'], root)
  copyFileSync(resolve(application, 'lib/launch.js'), resolve(runtime, 'launch.js'))
  copyFileSync(resolve(root, 'LICENSE'), resolve(application, 'LICENSE'))
  const sealed = resolve(work, 'runtime.asar')
  console.log('Sealing runtime modules; native binaries and pnpm remain unpacked')
  await createPackageWithOptions(runtime, sealed, { unpack: '**/*.{node,dll,exe}', unpackDir: '**/pnpm/**' })
  const output = resolve(artifacts, `desktop-${desktopVersion}`)
  console.log('Building the Windows application directory')
  await buildWindowsDesktop({ application, sealed, output })
  writeFileSync(resolve(output, 'aspera-desktop-build.json'), JSON.stringify({ version: 1, desktop: desktopVersion,
    dsh: '0.2.0-rc.2', extension: '0.2.0', electron: '44.0.0', platform: 'win32', arch: 'x64',
    remoteDeploymentId: snapshot.digest, signed: false, runtimeSource: runtime }, null, 2) + '\n')
  console.log(`Aspera desktop: .artifacts/desktop-${desktopVersion}/win-unpacked/Aspera.exe`)
} finally { snapshot.dispose() }
