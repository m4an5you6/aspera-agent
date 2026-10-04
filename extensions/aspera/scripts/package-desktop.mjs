/** Produce an independent, unsigned Windows application carrying its frozen DSH runtime. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, createReadStream, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
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
const { OPTIONAL_BUNDLES } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const dshManifest = JSON.parse(readFileSync(require.resolve('@deepseek-ai/dsh/package.json'), 'utf8'))
assert.equal(dshManifest.version, '0.2.0-rc.2')
const desktopVersion = JSON.parse(readFileSync(resolve(application, 'package.json'), 'utf8')).version
const pnpm = process.env.npm_execpath
assert.ok(pnpm, 'Run this build through pnpm')
const artifacts = resolve(root, '.artifacts'); mkdirSync(artifacts, { recursive: true })
const stage = process.env.ASPERA_DESKTOP_STAGE
const work = stage === undefined ? mkdtempSync(resolve(artifacts, 'desktop-build-')) : resolve(root, stage)
if (stage !== undefined) assert.ok(dirname(work) === artifacts && work.startsWith(resolve(artifacts, 'desktop-build-'))
  && realpathSync(work) === work, 'Desktop stage must be an owned artifact directory')
const runtime = resolve(work, 'runtime')
mkdirSync(runtime, { recursive: true })
const snapshot = await snapshotSource(root, 120000)
try {
  console.log('Preparing frozen desktop runtime dependencies')
  if (stage === undefined) await extract({ file: snapshot.archive, cwd: runtime, strict: true })
  else assert.equal(JSON.parse(readFileSync(resolve(runtime, 'aspera-release.json'), 'utf8')).deploymentId,
    snapshot.digest, 'Desktop stage belongs to a different frozen release')
  const manifestPath = resolve(runtime, 'package.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const previousDependencies = JSON.stringify(manifest.dependencies)
  manifest.dependencies.pnpm = '11.7.0'
  manifest.dependencies['@deepseek-ai/dsh-host-directory-picker-browse'] = '0.2.0-rc.2'
  manifest.dependencies['@deepseek-ai/dsh-client-ui-directory-picker-browse'] = '0.2.0-rc.2'
  for (const name of OPTIONAL_BUNDLES) {
    const version = dshManifest.dependencies[name]
    assert.equal(typeof version, 'string', `Pinned DSH is missing optional bundle ${name}`)
    manifest.dependencies[name] = version
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  const store = dirname((await command(process.execPath, [pnpm, 'store', 'path'], root)).trim())
  if (stage === undefined || previousDependencies !== JSON.stringify(manifest.dependencies)) {
    await command(process.execPath, [pnpm, '--dir', runtime, 'install', '--lockfile-only', '--offline', '--ignore-scripts'], root)
  }
  await command(process.execPath, [pnpm, '--dir', runtime, 'install', '--offline', '--frozen-lockfile', '--prod', '--node-linker=hoisted', '--store-dir', store], root)
  await command(process.execPath, ['scripts/assets.mjs'], application)
  await command(process.execPath, ['scripts/bundle-desktop.mjs'], root)
  copyFileSync(resolve(application, 'lib/launch.js'), resolve(runtime, 'launch.js'))
  copyFileSync(resolve(root, 'LICENSE'), resolve(application, 'LICENSE'))
  const sealed = resolve(work, 'runtime.asar')
  console.log('Sealing runtime modules; native binaries and pnpm remain unpacked')
  await createPackageWithOptions(runtime, sealed, { unpack: '**/*.{node,dll,exe}', unpackDir: '**/pnpm/**' })
  const buildId = new Date().toISOString().replace(/[:]/g, '').replace(/-/g, '') + '-' + snapshot.digest.slice(0, 12)
  const builds = resolve(artifacts, `desktop-${desktopVersion}`)
  const output = resolve(builds, buildId)
  const buildInfo = resolve(work, 'build-info.json')
  const information = { version: 1, buildId, builtAt: new Date().toISOString(), desktop: desktopVersion,
    dsh: '0.2.0-rc.2', extension: '0.1.1', protocol: 4, storageGeneration: 5, electron: '44.0.0', platform: 'win32', arch: 'x64',
    remoteDeploymentId: snapshot.digest, signed: false }
  writeFileSync(buildInfo, JSON.stringify(information, null, 2) + '\n')
  console.log('Building the Windows application directory')
  await buildWindowsDesktop({ application, sealed, output, buildInfo })
  const hashFile = async file => {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(file)) hash.update(bytes)
    return hash.digest('hex')
  }
  writeFileSync(resolve(output, 'aspera-desktop-build.json'), JSON.stringify({ ...information,
    directory: 'win-unpacked', executableSHA256: await hashFile(resolve(output, 'win-unpacked/Aspera.exe')),
    runtimeSHA256: await hashFile(resolve(output, 'win-unpacked/resources/runtime.asar')), runtimeSource: runtime }, null, 2) + '\n')
  writeFileSync(resolve(builds, 'latest.json'), JSON.stringify({ buildId }) + '\n')
  console.log(`Aspera desktop: ${output}/win-unpacked/Aspera.exe`)
} finally { snapshot.dispose() }
