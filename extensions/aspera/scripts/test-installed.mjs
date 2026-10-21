/** Verify frozen release installation outside the source checkout and its actual Web profile. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { create, extract } from 'tar'
import { chromium } from '@playwright/test'
import { snapshotSource, verifySourceArchive } from '../packages/dispatch/lib/snapshot.js'
import { command, launchProfile, openAspera, removeTestDirectory } from './test-app.mjs'
import { checkGpuIdentityQuery } from './test-controller-query.mjs'

const root = resolve(import.meta.dirname, '..')
const installRoot = mkdtempSync(join(tmpdir(), 'aspera-installed-'))
const snapshot = await snapshotSource(root, 120000)
let app; let browser
try {
  const requirements = await verifySourceArchive(snapshot.archive, snapshot.digest)
  assert.equal(requirements.pnpm, '11.7.0')
  assert.equal(requirements.uv, '0.13.0', 'Fixed releases retain the managed installer version')
  assert.equal(requirements.pip, '26.2.1', 'Fixed releases retain the isolated installer pip version')
  const verificationRoot = mkdtempSync(join(installRoot, 'material-check-'))
  await extract({ file: snapshot.archive, cwd: verificationRoot, strict: true })
  const files = ['experiments.tgz', 'runtime.tgz', 'dispatch.tgz', 'console.tgz', 'patches',
    'pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', 'setup.mjs', 'LICENSE', '.npmrc', 'aspera-release.json']
  const altered = join(installRoot, 'altered.tar')
  writeFileSync(join(verificationRoot, 'pnpm-lock.yaml'), readFileSync(join(verificationRoot, 'pnpm-lock.yaml'), 'utf8') + '\n# changed material\n')
  await create({ cwd: verificationRoot, file: altered }, files)
  await assert.rejects(verifySourceArchive(altered, snapshot.digest), /material digest differs/)
  await extract({ file: snapshot.archive, cwd: verificationRoot, strict: true })
  writeFileSync(join(verificationRoot, '.pnpmfile.cjs'), 'module.exports = {}\n')
  await create({ cwd: verificationRoot, file: altered }, [...files, '.pnpmfile.cjs'])
  await assert.rejects(verifySourceArchive(altered, snapshot.digest), /unindexed installation file/)
  removeTestDirectory(verificationRoot, installRoot)
  await extract({ file: snapshot.archive, cwd: installRoot, strict: true })
  const pnpm = process.env.npm_execpath
  assert.ok(pnpm, 'Run the check through pnpm')
  const store = dirname((await command(process.execPath, [pnpm, 'store', 'path'], root)).trim())
  await command(process.execPath, [pnpm, 'install', '--offline', '--frozen-lockfile', '--prod', '--store-dir', store], installRoot)
  const manifest = JSON.parse(readFileSync(resolve(installRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.asperaEnvironmentTools.storageVersion, 1, 'Fixed releases require account storage, historical loans and managed materials')
  assert.equal(manifest.asperaEnvironmentTools.storageFormat, '0.1.0')
  assert.equal(manifest.asperaFinalizationVersion, 2, 'Installed releases require unified stage acceptance and command waiting')
  assert.equal(manifest.asperaCompletionVersion, 1, 'Source snapshots retain completion acceptance requirements')
  assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/runtime/lib/stage-acceptance.js')))
  assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/runtime/lib/command-wait.js')))
  assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/runtime/scripts/storage-placement.py')), 'Purpose placement must ship in the installed runtime')
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '0.2.0-rc.2')
  assert.equal(JSON.parse(readFileSync(resolve(installRoot, 'aspera-release.json'), 'utf8')).extension, '0.1.1')
  assert.equal(existsSync(resolve(installRoot, 'packages')), false)
  for (const file of ['lib/preparation-command.js', 'scripts/preparation-command.py']) {
    assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/dispatch', file)), 'The installed preparation supervisor is present: ' + file)
  }
  assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/console/lib/client/index.d.ts')))
  for (const name of ['experiments', 'runtime', 'dispatch', 'console']) {
    const packageRoot = resolve(installRoot, 'node_modules/@aspera', name)
    const publicPackage = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
    assert.equal(publicPackage.version, '0.1.1')
    for (const [entry, fields] of Object.entries(publicPackage.exports)) {
      for (const file of typeof fields === 'string' ? [fields] : Object.values(fields)) assert.ok(existsSync(resolve(packageRoot, file)), `${name} export ${entry} is missing ${file}`)
    }
    assert.ok(existsSync(resolve(packageRoot, 'LICENSE')))
  }
  const { gpuIdentityQueryScript } = await import(pathToFileURL(resolve(installRoot, 'node_modules/@aspera/runtime/lib/gpu-query.js')).href)
  const { parseGpuInventory } = await import(pathToFileURL(resolve(installRoot, 'node_modules/@aspera/experiments/lib/controller-protocol.js')).href)
  checkGpuIdentityQuery(gpuIdentityQueryScript, parseGpuInventory)
  const { experimentSandboxArgv } = await import(pathToFileURL(resolve(installRoot, 'node_modules/@aspera/runtime/lib/experiment-sandbox.js')).href)
  const sandboxArgs = experimentSandboxArgv({ backendPath: '/usr/bin/bwrap', workspaceRoot: '/fixture/workspace',
    devicePaths: ['/dev/nvidia3'], hiddenPaths: ['/fixture/control'] }, ['true'])
  for (const flag of ['--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--clearenv', '--cap-drop']) assert.ok(sandboxArgs.includes(flag))
  assert.equal(sandboxArgs[sandboxArgs.indexOf('--cap-drop') + 1], 'ALL')
  assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/dispatch/scripts/repair-sandbox.py')))
  for (const file of ['lib/controller-recovery.js', 'scripts/controller-recovery.py', 'scripts/controller-profile.mjs']) {
    assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/dispatch', file)), `Installed controller recovery entry is missing ${file}`)
  }
  for (const file of ['lib/run-archive.js', 'lib/run-archive-reader.js', 'lib/run-archive-store.js', 'scripts/read-archive.mjs']) {
    assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/dispatch', file)), `Installed archive entry is missing ${file}`)
  }
  const { experimentArchiveStatusSchema } = await import(pathToFileURL(resolve(installRoot, 'node_modules/@aspera/experiments/lib/index.js')).href)
  assert.equal(experimentArchiveStatusSchema.parse({ version: 1, experimentId: '11111111-1111-4111-8111-111111111111', state: 'idle',
    runtimeAvailable: false, savedBytes: 0, complete: false, sources: [], gaps: [] }).version, 1)
  const remoteDeclarations = readFileSync(resolve(installRoot, 'node_modules/@aspera/dispatch/lib/typert.remote-client.d.ts'), 'utf8')
  for (const method of ['experimentArchiveStatus', 'syncExperimentArchive', 'interruptExperiment', 'experimentInterruptionStatus',
    'remoteTaskStatus', 'settleRemoteTask', 'experimentStorageUsage', 'experimentStoragePlan', 'refreshExperimentStorage', 'previewExperimentCacheCleanup', 'cleanupExperimentCache']) assert.ok(remoteDeclarations.includes(method))
  for (const file of ['lib/interruption.js', 'lib/interruption-remote.js', 'lib/remote-task.js']) assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/dispatch', file)))
  assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/runtime/scripts/owned-command.py')))
  for (const file of ['lib/managed-environment.js', 'lib/storage-governance.js', 'lib/material-operation.js', 'scripts/managed-environment.py', 'scripts/storage-governance.py']) {
    assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/runtime', file)), `Installed environment entry is missing ${file}`)
  }
  const installedAgent = readFileSync(resolve(installRoot, 'node_modules/@aspera/runtime/lib/cluster-agent.js'), 'utf8')
  for (const tool of ['inspect_experiment_environment', 'prepare_experiment_environment', 'recover_experiment_environment',
    'preview_experiment_cache_cleanup', 'cleanup_experiment_cache', 'assess_experiment_storage', 'inspect_experiment_materials',
    'prepare_experiment_materials']) assert.ok(installedAgent.includes(tool))
  writeFileSync(resolve(installRoot, 'environment-smoke.mjs'), `import assert from 'node:assert/strict'\nimport { managedEnvironmentPolicySchema, managedEnvironmentProgram } from '@aspera/runtime'\nassert.equal(managedEnvironmentPolicySchema.parse({}).uvVersion, process.argv[2])\nassert.ok(managedEnvironmentProgram().includes('release-references'))\n`)
  // Published imports may load native files; their owning process exits before directory removal.
  await command(process.execPath, ['environment-smoke.mjs', requirements.uv], installRoot)
  const { experimentInterruptionSchema } = await import(pathToFileURL(resolve(installRoot, 'node_modules/@aspera/experiments/lib/index.js')).href)
  assert.throws(() => experimentInterruptionSchema.parse({ version: 1, experimentId: '11111111-1111-4111-8111-111111111111',
    operationId: '22222222-2222-4222-8222-222222222222', submissionHash: 'a'.repeat(64), reason: 'user', stopRequested: true,
    phase: 'released', startedAt: 1, updatedAt: 1, nodes: [{ serverId: '33333333-3333-4333-8333-333333333333', name: 'Original node',
      phase: 'pending', agentsExited: false, commandsReleased: false, servicesReleased: false, updatedAt: 1 }] }), /complete node exit evidence/)
  assert.deepEqual(sandboxArgs.slice(-2), ['--', 'true'])
  writeFileSync(resolve(installRoot, 'consumer.mts'), `import type { FleetCreateRequest } from '@aspera/dispatch/types'\nimport { TYPERT_REMOTE } from '@aspera/dispatch/remote'\nimport { serverRemovalBlockers } from '@aspera/dispatch/server-usage'\nimport { prepareSshHostKey } from '@aspera/runtime/transport'\nimport { clusterSubmissionSchema, executionProgressReadSchema } from '@aspera/experiments'\nimport type { ExecutionProgressRead } from '@aspera/experiments/types'\nimport { setupWorkerProfile } from '@aspera/runtime'\nconst model = {provider:'qwen-chat',model:'qwen-test'}\nconst request: FleetCreateRequest = {experimentId:'draft',objective:'train',serverIds:[],coordinatorId:'node',mode:'semi',models:{preparation:model,planning:model,execution:model},uploads:[{name:'data.json',size:0}]}\nconst progress: ExecutionProgressRead = executionProgressReadSchema.parse({supported:false})\nvoid [request, progress, TYPERT_REMOTE, serverRemovalBlockers, prepareSshHostKey, clusterSubmissionSchema, setupWorkerProfile]\n`)
  await command(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), 'consumer.mts', '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2024'], installRoot)
  const repacked = await snapshotSource(installRoot, 120000)
  try { assert.ok(existsSync(repacked.archive)); assert.equal(repacked.digest.length, 64); await verifySourceArchive(repacked.archive, repacked.digest) }
  finally { repacked.dispose() }
  const home = resolve(installRoot, 'home')
  await command(process.execPath, ['setup.mjs'], installRoot, { DSH_HOME: home })
  const startup = performance.now()
  console.log('Starting the independently installed profile')
  app = await launchProfile(installRoot, home, 'aspera', {}, 180000)
  console.log(`Installed profile ready in ${Math.round(performance.now() - startup)} ms`)
  browser = await chromium.launch({ ...(process.env.ASPERA_BROWSER_EXECUTABLE ? { executablePath: process.env.ASPERA_BROWSER_EXECUTABLE } : { channel: process.env.ASPERA_BROWSER_CHANNEL || 'chrome' }), headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await openAspera(page, app.url)
  await page.getByRole('button', { name: /^(服务器|Servers)$/ }).click()
  await page.getByRole('button', { name: /^(添加服务器|Add server)$/ }).click()
  await page.locator('input[name=username]').fill('trainer')
  assert.equal(await page.getByRole('dialog').getByLabel(/^(服务器密码|Server password)$/).getAttribute('type'), 'password')
  assert.deepEqual(errors, [])
  mkdirSync(resolve(root, '.artifacts'), { recursive: true })
  await page.screenshot({ path: resolve(root, '.artifacts/installed-web.png'), fullPage: true })
  console.log('Installed release: original/repacked material verification, tamper rejection, frozen production install, NodeNext types, dsh profile, sidebar and generated Remote stream passed.')
} finally {
  await browser?.close()
  await app?.close()
  snapshot.dispose()
  removeTestDirectory(installRoot, tmpdir())
}
