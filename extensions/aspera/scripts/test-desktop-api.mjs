/** Exercise real desktop API startup with an upgraded profile and a Unicode state path. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron, expect } from '@playwright/test'
import { openAspera, removeTestDirectory } from './test-app.mjs'
import { desktopOutput } from './desktop-output.mjs'

const root = resolve(import.meta.dirname, '..')
const output = desktopOutput(root)
const executable = resolve(output, 'win-unpacked/Aspera.exe')
assert.ok(existsSync(executable), 'The unpacked desktop directory must exist')
const directory = mkdtempSync(resolve(tmpdir(), 'aspera-desktop-api-test-'))
const userData = resolve(directory, '用户 空间')
const home = resolve(userData, 'dsh')
const profile = resolve(home, 'profiles/aspera-desktop')
const runtime = JSON.parse(readFileSync(resolve(output, 'aspera-desktop-build.json'), 'utf8')).runtimeSource
assert.equal(JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8')).asperaEnvironmentTools.repairVersion, 1,
  'The retained desktop executable must load environment repair resources')
assert.equal(JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8')).asperaEnvironmentTools.materialFormat, '0.1.2',
  'The retained desktop executable must load material source binding resources')
assert.equal(JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8')).asperaEnvironmentTools.registrationFormat, '0.1.3',
  'The retained desktop executable must load storage registration and diagnostic resources')
assert.equal(JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8')).asperaEnvironmentTools.reuseVerificationVersion, 1,
  'The retained desktop executable must load automatic historical source verification resources')
mkdirSync(profile, { recursive: true })
symlinkSync(resolve(runtime, 'node_modules'), resolve(profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(resolve(profile, 'aspera-desktop-profile.json'), JSON.stringify({ version: 1, runtime: resolve(runtime, 'node_modules') }))
writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ name: 'aspera-desktop-profile', private: true,
  dependencies: { '@aspera/dispatch': '0.1.1', '@aspera/console': '0.1.1', '@deepseek-ai/dsh-web-app': '0.2.0-rc.2' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@aspera/dispatch'] } } }))
writeFileSync(resolve(profile, 'cordis.patch.yml'), JSON.stringify([
  { id: 'hmr', disabled: true }, { id: 'plugin-manager', disabled: true },
  { id: 'tool-plugin-manager', disabled: true }, { id: 'directory-picker', disabled: true },
  { id: 'ui-settings-general', name: '@deepseek-ai/dsh-client-ui-settings-general', config: { welcomeNoticeVersion: '2026-09-28.1' } },
]))
const registry = resolve(home, 'storages/aspera_fleet/registry')
mkdirSync(registry, { recursive: true })
writeFileSync(resolve(registry, 'servers.json'), JSON.stringify({ version: 1, record: { servers: [] } }) + '\n')
let app
try {
  const env = { ...process.env, ASPERA_DESKTOP_USER_DATA_DIR: userData, ASPERA_HOME: home, DEEPSEEK_API_KEY: '' }
  delete env.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ executablePath: executable, env, timeout: 60000 })
  const page = await app.firstWindow()
  await page.waitForURL(url => url.hostname === '127.0.0.1', { timeout: 60000 })
  const ownedOrigin = new URL(page.url()).origin
  await app.evaluate(async ({ BrowserWindow }, origin) => {
    const session = BrowserWindow.getAllWindows()[0].webContents.session
    for (let index = 0; index < 80; index++) {
      await session.cookies.set({ url: origin, name: 'dsh-auth-regression-' + index, value: 'x'.repeat(220), httpOnly: true })
    }
  }, ownedOrigin)
  const navigation = await page.reload()
  assert.equal(navigation?.status(), 200, 'Stored cookies from earlier Host ports must not overflow the navigation header')
  assert.equal(await app.evaluate(async ({ BrowserWindow }, origin) =>
    (await BrowserWindow.getAllWindows()[0].webContents.session.cookies.get({ url: origin }))
      .filter(cookie => cookie.name.startsWith('dsh-auth-regression-')).length, ownedOrigin), 80,
  'Routing must preserve stored cookies from earlier Host authorities')
  const result = await page.evaluate(async () => {
    const method = 'aspera/servers'
    const response = await fetch(new URL(`api/${method}`, location.href), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-upgrade-api', method, payload: { args: {} } }) })
    return { status: response.status, body: await response.text() }
  })
  assert.equal(result.status, 200, `Upgraded desktop server API returned ${result.status}: ${result.body}`)
  assert.deepEqual(JSON.parse(result.body).result, { ok: true, value: { servers: [] } })
  const recovery = await page.evaluate(async () => {
    const method = 'aspera/experimentSnapshot'
    const response = await fetch(new URL(`api/${method}`, location.href), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-installation-api', method, payload: { args: {} } }) })
    return { status: response.status, body: await response.text() }
  })
  assert.equal(recovery.status, 200)
  assert.deepEqual(JSON.parse(recovery.body).result.value.installations, [], 'The original EXE loads the new installation snapshot')
  assert.deepEqual(JSON.parse(recovery.body).result.value.interruptions, [], 'The original EXE loads durable interruption progress')
  assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/dispatch/scripts/install-release.py')), 'The independently shipped installer is present')
  assert.deepEqual(JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8')).asperaPlanningTools, { version: 1, formatVersion: '0.1.0', requirementsVersion: 1, inferenceVersion: 1 })
  for (const file of ['plan-draft.js', 'plan-tools.js', 'framework-documentation.js', 'planning-store.js']) {
    assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/runtime/lib', file)), 'The original EXE loads planning resources: ' + file)
  }
  for (const file of ['lib/preparation-command.js', 'scripts/preparation-command.py']) {
    assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/dispatch', file)), 'The original EXE loads preparation exit and log recovery: ' + file)
  }
  const steps = await page.evaluate(async () => {
    const method = 'aspera/experimentExecutionProgress'
    const response = await fetch(new URL(`api/${method}`, location.href), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-steps-api', method, payload: { args: { id: '00000000-0000-4000-8000-000000000000' } } }) })
    return { status: response.status, body: await response.text() }
  })
  assert.equal(steps.status, 200, 'The original EXE exposes the generated step progress API')
  assert.equal(JSON.parse(steps.body).result.ok, false, 'A foreign experiment cannot read step progress')
  for (const operation of ['reviewExperimentCompletion', 'experimentCompletionReviewStatus', 'cancelExperimentCompletionReview', 'experimentCompletionReviewTrace', 'experimentCompletionAssessment', 'experimentFinalizationStatus']) {
    const review = await page.evaluate(async operation => {
      const method = 'aspera/' + operation
      const response = await fetch(new URL(`api/${method}`, location.href), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-review-' + operation, method,
          payload: { args: { id: '00000000-0000-4000-8000-000000000000', operationId: '00000000-0000-4000-8000-000000000000', request: {} } } }) })
      return { status: response.status, body: await response.json() }
    }, operation)
    assert.equal(review.status, 200, 'The original EXE registers ' + operation)
    assert.equal(review.body.result.ok, false, 'A foreign experiment cannot review or read supplementary evidence')
  }
  for (const file of ['lib/completion-review.js', 'lib/completion-agent.js', 'lib/completion-reader.js']) assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/dispatch', file)))
  for (const file of ['lib/completion-check.js', 'lib/completion-evidence.js', 'scripts/completion-files.mjs']) assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/runtime', file)))
  for (const file of ['lib/stage-acceptance.js', 'lib/stage-runtime.js', 'lib/command-wait.js', 'lib/execution-commands.js', 'lib/finish-decision.js']) assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/runtime', file)))
  assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/runtime/lib/execution-steps.js')), 'The updated runtime includes scoped step-report tools')
  for (const operation of ['experimentArchiveStatus', 'syncExperimentArchive']) {
    const archive = await page.evaluate(async operation => {
      const method = 'aspera/' + operation
      const response = await fetch(new URL(`api/${method}`, location.href), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-archive-' + operation, method,
          payload: { args: { id: '00000000-0000-4000-8000-000000000000' } } }) })
      return { status: response.status, body: await response.json() }
    }, operation)
    assert.equal(archive.status, 200, 'The original EXE registers ' + operation)
    assert.equal(archive.body.result.ok, false, 'Unknown experiments cannot read or synchronize archives')
  }
  for (const file of ['lib/run-archive.js', 'lib/run-archive-store.js', 'scripts/read-archive.mjs']) {
    assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/dispatch', file)))
  }
  for (const operation of ['interruptExperiment', 'experimentInterruptionStatus']) {
    const interruption = await page.evaluate(async operation => {
      const method = 'aspera/' + operation
      const response = await fetch(new URL(`api/${method}`, location.href), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-interruption-' + operation, method,
          payload: { args: { id: '00000000-0000-4000-8000-000000000000' } } }) })
      return { status: response.status, body: await response.json() }
    }, operation)
    assert.equal(interruption.status, 200, 'The original EXE registers ' + operation)
    assert.equal(interruption.body.result.ok, false, 'An unknown experiment cannot be stopped or inspected')
  }
  assert.equal(existsSync(resolve(home, 'aspera-interruptions')), false, 'Refused interruption writes no operation journal')
  for (const file of ['lib/interruption.js', 'lib/interruption-remote.js', 'lib/remote-task.js', 'scripts/controller-recovery.py']) {
    assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/dispatch', file)))
  }
  for (const operation of ['remoteTaskStatus', 'settleRemoteTask']) {
    const task = await page.evaluate(async operation => {
      const method = 'aspera/' + operation, id = '00000000-0000-4000-8000-000000000000'
      const args = operation === 'settleRemoteTask' ? { raw: { taskId: id, mode: 'reconcile' } } : { id }
      const response = await fetch(new URL(`api/${method}`, location.href), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-task-' + operation, method, payload: { args } }) })
      return { status: response.status, body: await response.json() }
    }, operation)
    assert.equal(task.status, 200, 'The original EXE registers ' + operation)
    assert.equal(task.body.result.ok, operation === 'remoteTaskStatus', 'An unknown task cannot be settled')
  }
  assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/runtime/scripts/owned-command.py')))
  for (const operation of ['experimentStorageUsage', 'experimentStoragePlan', 'refreshExperimentStorage', 'previewExperimentCacheCleanup', 'cleanupExperimentCache']) {
    const storage = await page.evaluate(async operation => {
      const method = 'aspera/' + operation
      const id = '00000000-0000-4000-8000-000000000000'
      const args = operation === 'cleanupExperimentCache'
        ? { request: { experimentId: id, operationId: id, nodes: [{ serverId: id, fingerprint: '0'.repeat(64) }] } }
        : operation === 'refreshExperimentStorage' ? { id, serverId: id } : { id }
      const response = await fetch(new URL(`api/${method}`, location.href), { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-environment-' + operation, method, payload: { args } }) })
      return { status: response.status, body: await response.json() }
    }, operation)
    assert.equal(storage.status, 200, 'The original EXE registers ' + operation)
    assert.equal(storage.body.result.ok, false, 'An unknown experiment cannot inspect or clean environment storage')
  }
  assert.equal(existsSync(resolve(home, 'aspera-environments')), false, 'Refused storage operations write no journal')
  assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/runtime/scripts/managed-environment.py')))
  assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/runtime/lib/environment-operation.js')), 'The original EXE includes installation waiting')
  assert.equal(JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8')).asperaEnvironmentTools.installVersion, 3, 'Desktop resources require the isolated v3 installer')
  assert.equal(JSON.parse(readFileSync(resolve(runtime, 'package.json'), 'utf8')).asperaEnvironmentTools.storageVersion, 1, 'Desktop resources require storage governance')
  for (const file of ['lib/storage-governance.js', 'lib/material-operation.js', 'scripts/storage-governance.py']) {
    assert.ok(existsSync(resolve(runtime, 'node_modules/@aspera/runtime', file)), 'The original EXE loads storage verification: ' + file)
  }
  await openAspera(page, page.url())
  await page.getByRole('button', { name: /^(服务器|Servers)$/ }).click()
  await page.getByRole('button', { name: /^(添加服务器|Add server)$/ }).click()
  await page.locator('input[name=name]').fill('API regression server')
  await page.locator('input[name=host]').fill('127.0.0.1')
  await page.locator('input[name=username]').fill('trainer')
  await page.getByRole('dialog').getByLabel(/^(服务器密码|Server password)$/).fill('fixture-password')
  await expect(page.locator('input[name=remoteRoot]')).toHaveCount(0)
  await page.screenshot({ path: resolve(root, '.artifacts/desktop-server-auto.png'), fullPage: true })
  await page.locator('summary').filter({ hasText: /高级设置|Advanced settings/ }).click()
  await expect(page.locator('input[name=remotePort]')).toHaveValue('43019')
  await expect(page.locator('input[name=trainingAddress]')).toHaveValue('')
  await page.getByRole('button', { name: /^(存储位置|Storage location)$/ }).click()
  await page.getByText(/^(手动指定|Specify a directory)$/, { exact: true }).click()
  await page.locator('input[name=remoteRoot]').fill('/mnt/training')
  await page.screenshot({ path: resolve(root, '.artifacts/desktop-server-advanced.png'), fullPage: true })
  await page.getByRole('button', { name: /^(存储位置|Storage location)$/ }).click()
  await page.getByText(/^(自动选择|Choose automatically)$/, { exact: true }).click()
  await expect(page.locator('input[name=remoteRoot]')).toHaveCount(0)
  await page.locator('summary').filter({ hasText: /推理服务对外访问|External inference access/ }).click()
  await page.locator('input[name=inferenceUrl]').fill('https://inference.example.test:8443')
  await page.locator('input[name=inferencePort]').fill('17000')
  const dialogBounds = await page.getByRole('dialog').evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return { top: bounds.top, bottom: bounds.bottom, viewport: innerHeight }
  })
  assert.ok(dialogBounds.top >= 0 && dialogBounds.bottom <= dialogBounds.viewport, 'Expanded server settings must fit the desktop window')
  const save = page.getByRole('button', { name: /^(保存服务器|Save server)$/ })
  await save.scrollIntoViewIfNeeded()
  await expect(save).toBeInViewport()
  await page.screenshot({ path: resolve(root, '.artifacts/desktop-server-inference.png'), fullPage: true })
  await save.click()
  await expect(page.getByText('API regression server', { exact: true })).toBeVisible()
  const saved = JSON.parse(readFileSync(resolve(registry, 'servers.json'), 'utf8'))
  assert.equal(saved.record.servers[0].name, 'API regression server')
  assert.deepEqual(saved.record.servers[0].storagePreference, { mode: 'auto' })
  assert.deepEqual(saved.record.servers[0].inferenceMapping, { url: 'https://inference.example.test:8443', port: 17000 })
  assert.ok(!JSON.stringify(saved).includes('fixture-password'))
  const registeredId = saved.record.servers[0].id
  await page.getByRole('button', { name: /^(删除服务器|Delete server)$/ }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: /^(删除服务器|Delete server)$/ })).toBeEnabled()
  await page.screenshot({ path: resolve(root, '.artifacts/desktop-delete-server.png'), fullPage: true })
  await page.getByRole('dialog').getByRole('button', { name: /^(删除服务器|Delete server)$/ }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('API regression server', { exact: true })).toHaveCount(0)
  assert.deepEqual(JSON.parse(readFileSync(resolve(registry, 'servers.json'), 'utf8')).record.servers, [])
  const marker = resolve(home, 'storages/aspera_removals/removed_servers', registeredId + '.json')
  assert.ok(existsSync(marker), 'The updated original EXE writes the independent removal journal')
  console.log('Upgraded desktop: real server API, saved server form and version-1 registry passed outside the checkout with a Unicode state path.')
  console.log('Original EXE: new server-removal preview, compact confirmation and durable removal journal passed.')
  console.log('Original EXE: installation snapshot and versioned remote installer resources loaded.')
  console.log('Original EXE: generated execution progress API and scoped step-report runtime loaded.')
  console.log('Original EXE: local archive APIs, read-only SSH helper and unknown-experiment refusal loaded.')
  console.log('Original EXE: interruption APIs, version-1 snapshot, owned-process helper and unknown-experiment no-op refusal passed.')
  console.log('Original EXE: managed environment APIs and shipped Python manager loaded; foreign storage operations rejected.')
  console.log('Original EXE: installation wait implementation and installVersion 3 release requirement loaded.')
} finally { await app?.close(); removeTestDirectory(directory, tmpdir()) }
