/** Publish a release-specific controller profile while preserving the stable DSH home. */
import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const request = JSON.parse(process.argv[1])
assert.ok(['node', 'coordinator'].includes(request.role))
assert.match(request.deploymentId, /^[a-f0-9]{64}$/)
const root = resolve(request.root)
const home = resolve(root, 'state', request.role + '-home')
const release = resolve(request.release)
const profileName = 'aspera-worker-' + request.deploymentId
const profile = resolve(home, 'profiles', profileName)
const gate = resolve(root, 'state/controller-recovery.json')
if (existsSync(gate)) {
  const value = JSON.parse(readFileSync(gate, 'utf8'))
  assert.equal(value.operationId, request.operationId, 'Another operation holds controller admission')
  assert.equal(value.role, request.role, 'Recovery belongs to another control role')
  assert.equal(value.release, release, 'Recovery belongs to another fixed release')
  assert.equal(value.phase, 'fenced', 'Recovery fence has not been confirmed')
}
const manifest = JSON.parse(readFileSync(resolve(release, 'aspera-release.json'), 'utf8'))
assert.equal(manifest.deploymentId, request.deploymentId)
assert.ok(existsSync(resolve(release, '.ready')), 'Fixed release has not passed installation')
for (const directory of [root, resolve(root, 'state'), home, resolve(home, 'profiles')]) {
  if (existsSync(directory)) assert.ok(!lstatSync(directory).isSymbolicLink(), 'Controller profile parent is a symbolic link')
  else mkdirSync(directory, { mode: 0o700 })
}
function verify(directory) {
  assert.ok(!lstatSync(directory).isSymbolicLink(), 'Controller profile is a symbolic link')
  assert.equal(JSON.parse(readFileSync(resolve(directory, 'aspera-release.json'), 'utf8')).release, release)
  assert.equal(realpathSync(resolve(directory, 'node_modules')), realpathSync(resolve(release, 'node_modules')))
  const installed = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  assert.deepEqual(installed.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@aspera/runtime'])
}
if (!existsSync(profile)) {
  const stage = mkdtempSync(resolve(home, '.controller-profile-'))
  execFileSync(process.execPath, [resolve(release, 'setup.mjs'), '--worker'],
    { env: { ...process.env, DSH_HOME: stage }, stdio: 'pipe', timeout: request.timeoutMs })
  const incoming = resolve(stage, 'profiles/aspera-worker')
  verify(incoming)
  renameSync(incoming, profile)
  rmdirSync(resolve(stage, 'profiles')); rmdirSync(stage)
}
verify(profile)
console.log(JSON.stringify({ profileName, home, release }))
