/** Stage and update owned desktop JavaScript while preserving the executable and runtime archive. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { desktopOutput } from './desktop-output.mjs'
import { command } from './test-app.mjs'

const root = resolve(import.meta.dirname, '..'), artifacts = resolve(root, '.artifacts')
const output = desktopOutput(root), resources = resolve(output, 'win-unpacked/resources')
const allowed = ['lib/main.js', 'lib/host-cookies.js', 'lib/protocol.js']
const hash = path => existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null
const executable = resolve(output, 'win-unpacked/Aspera.exe'), runtime = resolve(resources, 'runtime.asar')
const stagePath = value => {
  const path = resolve(value)
  assert.equal(dirname(path), artifacts)
  assert.ok(path.startsWith(resolve(artifacts, 'shell-update-')) && realpathSync(path) === path)
  return path
}

if (process.argv[2] === '--prepare') {
  const pnpm = process.env.npm_execpath; assert.ok(pnpm, 'Prepare the desktop shell through pnpm')
  await command(process.execPath, [pnpm, 'exec', 'tsc', '-b', 'apps/desktop'], root)
  const stage = mkdtempSync(resolve(artifacts, 'shell-update-')), files = []
  for (const name of allowed) {
    const source = resolve(root, 'apps/desktop', name), destination = resolve(stage, name)
    assert.notEqual(hash(source), null, 'The compiled desktop module is missing: ' + name)
    mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination)
    files.push({ name, previousSHA256: hash(resolve(resources, 'app', name)), sha256: hash(destination) })
  }
  writeFileSync(resolve(stage, 'update.json'), JSON.stringify({ version: 1, output, executableSHA256: hash(executable), runtimeSHA256: hash(runtime), files }, null, 2) + '\n')
  console.log('Prepared desktop JavaScript: ' + stage)
} else {
  assert.equal(process.argv[2], '--apply', 'Use --prepare or --apply <prepared-directory> after fully quitting Aspera')
  const stage = stagePath(process.argv[3] ?? ''), update = JSON.parse(readFileSync(resolve(stage, 'update.json'), 'utf8'))
  assert.equal(update.version, 1); assert.equal(update.output, output)
  assert.deepEqual(update.files.map(file => file.name), allowed)
  assert.equal(hash(executable), update.executableSHA256); assert.equal(hash(runtime), update.runtimeSHA256)
  const application = resolve(resources, 'app'); assert.equal(realpathSync(application), application)
  for (const file of update.files) {
    const destination = resolve(application, file.name)
    assert.ok(destination.startsWith(application + sep)); assert.equal(hash(resolve(stage, file.name)), file.sha256)
    assert.ok([file.previousSHA256, file.sha256].includes(hash(destination)), 'Desktop module changed after preparation: ' + file.name)
  }
  for (const file of update.files) {
    const destination = resolve(application, file.name), backup = resolve(stage, 'backup', file.name)
    if (hash(destination) === file.sha256) continue
    if (file.previousSHA256 !== null) {
      if (existsSync(backup)) assert.equal(hash(backup), file.previousSHA256)
      else { mkdirSync(dirname(backup), { recursive: true }); copyFileSync(destination, backup) }
    }
    const incoming = destination + '.incoming'
    copyFileSync(resolve(stage, file.name), incoming); renameSync(incoming, destination)
    assert.equal(hash(destination), file.sha256)
  }
  assert.equal(hash(executable), update.executableSHA256); assert.equal(hash(runtime), update.runtimeSHA256)
  writeFileSync(resolve(stage, 'applied.json'), JSON.stringify({ version: 1, appliedAt: new Date().toISOString(), output,
    executableSHA256: hash(executable), runtimeSHA256: hash(runtime), files: update.files }, null, 2) + '\n')
  console.log('Updated owned desktop JavaScript; executable and runtime archive are unchanged.')
}
