/** Replay preparation timeout and deleted-task recovery through the shipped DSH profile without model credentials. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect as baseExpect } from '@playwright/test'
import { command, launchProfile, openAspera, removeTestDirectory } from './test-app.mjs'
import { fixtureOptions, fixtureProvider, fixtureSelections } from './fixtures/models.mjs'

const root = resolve(import.meta.dirname, '..')
const artifacts = resolve(root, '.artifacts')
mkdirSync(artifacts, { recursive: true })
const directory = mkdtempSync(resolve(artifacts, 'preparation-profile-'))
const home = resolve(directory, 'home')
let app; let browser
const expect = baseExpect.configure({ timeout: 40000 })
try {
  await command(process.execPath, ['scripts/setup.mjs'], root, { ASPERA_HOME: home })
  writeFileSync(resolve(home, 'profiles/aspera/cordis.patch.yml'), JSON.stringify([
    { id: 'hmr', disabled: true }, { id: 'client-hmr', disabled: true }, { id: 'aspera-dispatch', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { [fixtureProvider]: fixtureOptions } } },
    { id: 'agent-default-model', config: { provider: fixtureProvider, model: 'qwen-preparation' } },
    { insert: [{ id: 'aspera-preparation-fixture', name: pathToFileURL(resolve(root, 'scripts/fixtures/web.mjs')).href,
      config: { role: 'web', root: resolve(directory, 'remote'), release: root, home, profileStartupMs: 180000 } }] },
  ]))
  app = await launchProfile(root, home, 'aspera', { DEEPSEEK_API_KEY: '' }, 180000)
  const exchange = await fetch(app.url, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const base = new URL(app.url).origin
  const readyDeadline = Date.now() + 30000
  for (;;) {
    const response = await fetch(base + '/aspera-test/status', { headers: { cookie }, signal: AbortSignal.timeout(5000) })
    if (response.status === 200) break
    assert.ok(Date.now() < readyDeadline, 'Preparation fixture did not register its ready endpoint')
    await delay(50)
  }
  const rpc = async (operation, args) => {
    const method = 'aspera/' + operation
    const response = await fetch(base + '/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(30000) })
    const result = await response.json()
    assert.equal(response.status, 200); assert.equal(result.result.ok, true, JSON.stringify(result))
    return result.result.value
  }
  const serverId = randomUUID(), experimentId = randomUUID()
  const account = { host: 'preparation-recovery.fixture', username: 'trainer', sshPort: 22 }
  await rpc('setPassword', { account, password: 'cpu-only-ssh-password' })
  await rpc('saveServer', { server: { ...account, id: serverId, name: 'CPU preparation timeout', remotePort: 43019,
    authMode: 'password', storagePreference: { mode: 'auto' } } })
  await rpc('createExperiment', { input: { experimentId, name: 'CPU preparation timeout', objective: 'CPU preparation timeout recovery',
    serverIds: [serverId], coordinatorId: serverId, mode: 'semi', models: fixtureSelections } })
  let record
  const deadline = Date.now() + 120000
  for (;;) {
    record = (await rpc('experiments', {})).find(row => row.request.experimentId === experimentId)
    assert.notEqual(record?.state, 'failed', record?.detail)
    if (record?.handoverRecorded) break
    assert.ok(Date.now() < deadline, 'Preparation profile did not complete its verification')
    await delay(50)
  }
  const response = await fetch(base + '/aspera-test/status', { headers: { cookie }, signal: AbortSignal.timeout(10000) })
  const state = await response.json()
  const calls = state.environmentCalls.filter(call => call.experimentId === experimentId)
  assert.ok(calls.some(call => call.name === 'prepare_preparation_tool' && call.timeoutRecovered))
  assert.ok(calls.some(call => call.name === 'verify_preparation_environment' && call.timeoutRecovered))
  assert.equal(state.preparationCommands.filter(call => call.host === account.host && !call.exitConfirmed).length, 1)
  assert.ok(record.preparation.environments.every(node => node.phase === 'environment-ready' && node.pendingCommand === undefined))
  const snapshot = { role: 'preparation', calls: calls.map(call => call.name), timeoutRecovered: true,
    originalCommandSubmissions: 1, independentVerification: true }
  browser = await chromium.launch({ ...(process.env.ASPERA_BROWSER_EXECUTABLE ? { executablePath: process.env.ASPERA_BROWSER_EXECUTABLE }
    : { channel: process.env.ASPERA_BROWSER_CHANNEL || 'chrome' }), headless: true })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } })
  const sessionCookie = { name: cookie.slice(0, cookie.indexOf('=')), value: cookie.slice(cookie.indexOf('=') + 1), url: base }
  await context.addCookies([sessionCookie])
  const page = await context.newPage()
  const browserErrors = []
  page.on('pageerror', error => { browserErrors.push(error.message) })
  await openAspera(page, base)
  const servers = page.getByRole('button', { name: /^(服务器|Servers)$/ })
  if (!await servers.isVisible()) await page.getByRole('button', { name: 'Aspera', exact: true }).click()
  await servers.click()
  const control = async (kind, id = experimentId) => {
    const response = await fetch(base + '/aspera-test/' + kind + '?id=' + encodeURIComponent(id), { headers: { cookie }, signal: AbortSignal.timeout(40000) })
    const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value
  }
  const seeded = await control('deleted-task-recovery')
  const recoveryId = seeded.deletedTaskPreparation
  assert.ok(recoveryId)
  const originalSession = seeded.experiments.find(row => row.request.experimentId === recoveryId).sessionId
  const notice = page.locator(`[data-remote-task-id="${experimentId}"]`)
  await expect(notice).toBeVisible(); await expect(notice).toHaveAttribute('aria-busy', 'true')
  await expect(notice.getByRole('button', { name: /^(正在核验任务退出…|Verifying task exit…)$/ })).toBeDisabled()
  await page.screenshot({ path: resolve(artifacts, 'remote-task-production-light.png'), fullPage: true })
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  await page.screenshot({ path: resolve(artifacts, 'remote-task-production-dark.png'), fullPage: true })
  await page.setViewportSize({ width: 520, height: 1000 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Remote task recovery fits a narrow window')
  await page.screenshot({ path: resolve(artifacts, 'remote-task-production-narrow.png'), fullPage: true })
  await page.evaluate(() => { delete document.body.dataset.dsDarkTheme })
  await page.setViewportSize({ width: 1440, height: 1050 })
  const english = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 1050 } })
  try {
    await english.addCookies([sessionCookie])
    const translated = await english.newPage(); await openAspera(translated, base)
    const englishServers = translated.getByRole('button', { name: 'Servers', exact: true })
    if (!await englishServers.isVisible()) await translated.getByRole('button', { name: 'Aspera', exact: true }).click()
    await englishServers.click()
    await expect(translated.locator(`[data-remote-task-id="${experimentId}"]`)).toContainText('Deleted experiment · release unconfirmed')
    await translated.screenshot({ path: resolve(artifacts, 'remote-task-production-en.png'), fullPage: true })
  } finally { await english.close() }
  await control('release-interruption')
  const recoveryDeadline = Date.now() + 120000
  let recovered
  for (;;) {
    recovered = (await rpc('experiments', {})).find(row => row.request.experimentId === recoveryId)
    assert.notEqual(recovered?.state, 'failed', recovered?.detail)
    if (recovered?.handoverRecorded) break
    assert.ok(Date.now() < recoveryDeadline, 'Deleted-task recovery did not finish independent verification')
    await delay(50)
  }
  const after = await control('status')
  const release = await rpc('remoteTaskStatus', { id: experimentId })
  assert.equal(release.released, true); assert.equal(release.deleted, true)
  assert.ok(after.deletedIds.includes(experimentId)); assert.ok(!after.experiments.some(row => row.request.experimentId === experimentId))
  assert.equal(after.deletedTaskRecords.find(row => row.submission.experimentId === experimentId).state, 'interrupted')
  assert.equal(recovered.sessionId, originalSession)
  const taskCalls = after.interruptionCalls.filter(call => call.experimentId === experimentId)
  assert.equal(new Set(taskCalls.map(call => call.operationId)).size, 1)
  assert.ok(!taskCalls.some(call => call.mode === 'interrupt-stop'))
  const recoveryCalls = after.environmentCalls.filter(call => call.experimentId === recoveryId && call.step === 'controller')
  assert.ok(recoveryCalls.some(call => call.name === 'verify_preparation_environment' && call.taskReleaseObserved))
  await expect(notice).toHaveCount(0)
  snapshot.deletedTaskRecovery = { calls: recoveryCalls.map(call => call.name), programReceiptObserved: true, independentVerification: true,
    originalOperationCount: 1, deletedExperimentRestored: false, processStopIssued: false, originalSessionPreserved: true,
    ui: ['light', 'dark', 'narrow', 'english'] }
  await control('deleted-task-ui', recoveryId)
  const manual = page.locator(`[data-remote-task-id="${recoveryId}"]`)
  await expect(manual).toBeVisible()
  await manual.getByRole('button', { name: /^(核验并释放|Verify and release)$/ }).focus()
  await page.keyboard.press('Enter')
  await expect(manual).toContainText(/退出待核验|Exit awaiting verification/)
  await expect(manual).toHaveAttribute('aria-busy', 'false')
  await expect(manual.locator('[data-state="ongoing"]')).toHaveCount(0)
  const blocked = await rpc('remoteTaskStatus', { id: recoveryId })
  assert.equal(blocked.released, false); assert.equal(blocked.interruption.phase, 'blocked')
  await page.screenshot({ path: resolve(artifacts, 'remote-task-production-blocked.png'), fullPage: true })
  await control('release-interruption', recoveryId)
  await manual.getByRole('button', { name: /^(中断远端任务|Interrupt remote task)$/ }).focus()
  await page.keyboard.press('Enter')
  await expect(manual).toHaveCount(0)
  const final = await rpc('remoteTaskStatus', { id: recoveryId })
  assert.equal(final.released, true); assert.equal(final.deleted, true)
  assert.equal(final.interruption.operationId, blocked.interruption.operationId)
  const manualState = await control('status')
  assert.equal(manualState.deletedTaskRecords.find(row => row.submission.experimentId === recoveryId).state, 'cancelled')
  assert.ok(!manualState.experiments.some(row => row.request.experimentId === recoveryId))
  snapshot.deletedTaskRecovery.manualBlockedRetry = { keyboard: true, operationPreserved: true, explicitInterrupt: true, result: 'cancelled' }
  assert.deepEqual(browserErrors, [])
  const expected = resolve(root, 'scripts/fixtures/preparation.snapshot.json')
  if (process.argv.includes('--record')) writeFileSync(expected, JSON.stringify(snapshot, null, 2) + '\n')
  assert.deepEqual(snapshot, JSON.parse(readFileSync(expected, 'utf8')))
  writeFileSync(resolve(artifacts, 'preparation-command-profile-result.json'), JSON.stringify(snapshot, null, 2) + '\n')
  writeFileSync(resolve(artifacts, 'remote-task-profile-result.json'), JSON.stringify(snapshot, null, 2) + '\n')
  console.log('Production preparation profile: timeout recovery, deleted-task discovery and settlement, logged Agent repair, independent verification and server UI passed.')
} catch (error) {
  console.error('Preparation profile tail: ' + (app?.output() ?? '').replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>').slice(-5000))
  throw error
} finally { await browser?.close(); await app?.close(); removeTestDirectory(directory, artifacts) }
