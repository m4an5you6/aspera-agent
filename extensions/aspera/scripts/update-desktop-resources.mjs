/** Update the installed runtime and Web resources while retaining the existing Electron carrier. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync, renameSync, realpathSync } from 'node:fs'
import { dirname, resolve, relative, sep } from 'node:path'
import { createRequire } from 'node:module'
import { extract } from 'tar'
import { snapshotSource } from '../packages/dispatch/lib/snapshot.js'
import { assertPublishedUiCompatibility } from '../packages/dispatch/lib/published-ui.js'
import { desktopOutput } from './desktop-output.mjs'
import { command } from './test-app.mjs'

const root = resolve(import.meta.dirname, '..')
const artifacts = resolve(root, '.artifacts')
const output = desktopOutput(root)
const resources = resolve(output, 'win-unpacked/resources')
const executable = resolve(output, 'win-unpacked/Aspera.exe')
const infoPath = resolve(output, 'aspera-desktop-build.json')
const embeddedInfoPath = resolve(resources, 'build-info.json')
const info = JSON.parse(readFileSync(infoPath, 'utf8'))
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const { createPackageWithOptions } = require('@electron/asar')

async function hash(file) {
  const digest = createHash('sha256')
  for await (const bytes of createReadStream(file)) digest.update(bytes)
  return digest.digest('hex')
}

async function applicationHashes() {
  const files = []
  const collect = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) collect(path)
      else { assert.ok(entry.isFile(), 'Desktop carrier entries must be regular files'); files.push(path) }
    }
  }
  if (existsSync(resolve(resources, 'app.asar'))) files.push(resolve(resources, 'app.asar'))
  else collect(resolve(resources, 'app'))
  const entries = []
  for (const file of files.sort()) entries.push([relative(resources, file), await hash(file)])
  return Object.fromEntries(entries)
}

if (process.argv[2] === '--apply') {
  const stage = resolve(process.argv[3] ?? '')
  assert.equal(dirname(stage), artifacts)
  assert.ok(stage.startsWith(resolve(artifacts, 'resource-update-')) && realpathSync(stage) === stage)
  const update = JSON.parse(readFileSync(resolve(stage, 'update.json'), 'utf8'))
  assert.equal(update.output, output, 'The active desktop directory changed; prepare its resources again')
  assert.equal(await hash(executable), update.executableSHA256, 'The Electron carrier changed')
  assert.deepEqual(await applicationHashes(), update.applicationHashes, 'The desktop application changed')
  assert.equal(await hash(resolve(resources, 'runtime.asar')), update.previousRuntimeSHA256, 'The runtime was updated by another operation')
  assert.equal(await hash(resolve(stage, 'runtime.asar')), update.runtimeSHA256, 'The prepared resource archive changed')
  const backup = resolve(stage, 'backup'); mkdirSync(backup)
  copyFileSync(resolve(resources, 'runtime.asar'), resolve(backup, 'runtime.asar'))
  copyFileSync(infoPath, resolve(backup, 'aspera-desktop-build.json'))
  copyFileSync(embeddedInfoPath, resolve(backup, 'build-info.json'))
  const unpacked = resolve(stage, 'runtime.asar.unpacked')
  const copyChanged = async directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const source = resolve(directory, entry.name)
      if (entry.isDirectory()) { await copyChanged(source); continue }
      assert.ok(entry.isFile(), 'Unpacked runtime entries must be files or directories')
      const name = relative(unpacked, source)
      const target = resolve(resources, 'runtime.asar.unpacked', name)
      assert.ok(target.startsWith(resolve(resources, 'runtime.asar.unpacked') + sep))
      if (existsSync(target) && await hash(source) === await hash(target)) continue
      if (existsSync(target)) {
        const saved = resolve(backup, 'runtime.asar.unpacked', name); mkdirSync(dirname(saved), { recursive: true }); copyFileSync(target, saved)
      }
      mkdirSync(dirname(target), { recursive: true }); copyFileSync(source, target)
    }
  }
  if (existsSync(unpacked)) await copyChanged(unpacked)
  const incoming = resolve(resources, 'runtime.asar.incoming')
  copyFileSync(resolve(stage, 'runtime.asar'), incoming)
  renameSync(incoming, resolve(resources, 'runtime.asar'))
  assert.equal(await hash(executable), update.executableSHA256)
  assert.deepEqual(await applicationHashes(), update.applicationHashes)
  assert.equal(await hash(resolve(resources, 'runtime.asar')), update.runtimeSHA256)
  const applied = { version: '0.1.1', updatedAt: new Date().toISOString(), runtimeSHA256: update.runtimeSHA256,
    remoteDeploymentId: update.remoteDeploymentId, previousRuntimeSHA256: update.previousRuntimeSHA256, backup }
  const embeddedInfo = JSON.parse(readFileSync(embeddedInfoPath, 'utf8'))
  for (const [path, metadata] of [[infoPath, { ...info, runtimeSource: update.runtimeSource }], [embeddedInfoPath, embeddedInfo]]) {
    writeFileSync(path, JSON.stringify({ ...metadata, runtimeSHA256: update.runtimeSHA256,
      remoteDeploymentId: update.remoteDeploymentId, resourceUpdates: [...(metadata.resourceUpdates ?? []), applied] }, null, 2) + '\n')
  }
  console.log(`Resources updated in ${resources}; original EXE and desktop application hashes are unchanged.`)
} else {
  assert.ok(process.argv[2] === undefined || process.argv[2] === '--prepare', 'Use --prepare or --apply <prepared-directory>')
  assert.equal(info.extension, '0.1.1'); assert.equal(info.dsh, '0.2.0-rc.2')
  const stage = process.argv[3] === undefined ? mkdtempSync(resolve(artifacts, 'resource-update-')) : resolve(process.argv[3])
  assert.equal(dirname(stage), artifacts)
  assert.ok(stage.startsWith(resolve(artifacts, 'resource-update-')) && realpathSync(stage) === stage)
  const snapshot = await snapshotSource(root, 120000)
  try {
    // A version-preserving update must not reuse pnpm's previous file-tarball installation.
    const runtime = resolve(stage, `runtime-${snapshot.digest.slice(0, 16)}`); mkdirSync(runtime, { recursive: true })
    await extract({ file: snapshot.archive, cwd: runtime, strict: true })
    const manifest = JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8'))
    const previous = JSON.parse(readFileSync(resolve(info.runtimeSource, 'package.json'), 'utf8'))
    manifest.dependencies = { ...previous.dependencies, ...manifest.dependencies }
    writeFileSync(resolve(runtime, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    const pnpm = process.env.npm_execpath; assert.ok(pnpm, 'Run resource preparation through pnpm')
    const store = dirname((await command(process.execPath, [pnpm, 'store', 'path'], root)).trim())
    await command(process.execPath, [pnpm, '--dir', runtime, 'install', '--lockfile-only', '--offline', '--ignore-scripts'], root)
    await command(process.execPath, [pnpm, '--dir', runtime, 'install', '--offline', '--frozen-lockfile', '--prod', '--node-linker=hoisted', '--store-dir', store], root)
    copyFileSync(resolve(info.runtimeSource, 'launch.js'), resolve(runtime, 'launch.js'))
    assertPublishedUiCompatibility(runtime)
    console.log('Verified dependencies; collecting the runtime resource archive')
    await createPackageWithOptions(runtime, resolve(stage, 'runtime.asar'), { unpack: '**/*.{node,dll,exe}', unpackDir: '**/pnpm/**' })
    const update = { version: 1, output, runtimeSource: runtime, remoteDeploymentId: snapshot.digest,
      executableSHA256: await hash(executable), applicationHashes: await applicationHashes(),
      previousRuntimeSHA256: await hash(resolve(resources, 'runtime.asar')), runtimeSHA256: await hash(resolve(stage, 'runtime.asar')) }
    writeFileSync(resolve(stage, 'update.json'), JSON.stringify(update, null, 2) + '\n')
    console.log(`Prepared verified runtime resources: ${stage}`)
  } finally { snapshot.dispose() }
}
