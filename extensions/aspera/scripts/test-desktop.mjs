/** Exercise the actual packaged Electron window, frozen profile, tray and joined Host shutdown. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { _electron as electron, expect } from '@playwright/test'
import { openAspera, removeTestDirectory } from './test-app.mjs'
import { desktopOutput } from './desktop-output.mjs'

const root = resolve(import.meta.dirname, '..')
const output = desktopOutput(root)
const executable = resolve(output, 'win-unpacked/Aspera.exe')
assert.ok(existsSync(executable), 'Build the Windows desktop package first')
const directory = mkdtempSync(resolve(tmpdir(), 'aspera-desktop-test-')); const userData = resolve(directory, 'user-data')
const home = resolve(directory, 'home'); const fixture = resolve(directory, 'plugin')
const apiReady = resolve(directory, 'api-ready.json')
const profile = resolve(home, 'profiles/aspera-desktop')
mkdirSync(profile, { recursive: true })
writeFileSync(resolve(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'api-readiness',
  name: new URL('./fixtures/api-ready.mjs', import.meta.url).href, config: { ready: apiReady } }] }]))
mkdirSync(fixture)
writeFileSync(resolve(fixture, 'package.json'), JSON.stringify({ name: 'aspera-desktop-smoke-plugin', version: '1.0.0',
  type: 'module', description: 'Desktop smoke plugin', exports: { './plugin': './plugin.mjs' },
  dsh: { bundle: { patch: './cordis.patch.yml' } } }))
writeFileSync(resolve(fixture, 'cordis.patch.yml'), JSON.stringify([{ insert: [
  { id: 'desktop-smoke-plugin', name: 'aspera-desktop-smoke-plugin/plugin' },
] }]))
writeFileSync(resolve(fixture, 'plugin.mjs'), `import { writeFileSync, readFileSync, statSync } from 'node:fs'; import { resolve } from 'node:path'; import { pathToFileURL } from 'node:url';
export async function apply() {
  const root = process.env.ASPERA_EXTENSION_ROOT;
  const { snapshotSource } = await import(pathToFileURL(resolve(root, 'node_modules/@aspera/dispatch/lib/snapshot.js')).href);
  const source = await snapshotSource(root, 30000);
  try {
    const manifest = JSON.parse(readFileSync(resolve(source.directory, 'release/package.json'), 'utf8'));
    writeFileSync(resolve(process.env.DSH_HOME, 'desktop-plugin-loaded'), JSON.stringify({ digest: source.digest, bytes: statSync(source.archive).size, dependencies: manifest.dependencies }));
  } finally { source.dispose(); }
}\n`)
let app; let page; let installResult
async function quit() {
  const applicationProcess = app.process()
  const exit = new Promise(resolveExit => { applicationProcess.once('exit', (code, signal) => { resolveExit({ code, signal }) }) })
  await app.evaluate(({ app }) => { app.quit() })
  const timeout = setTimeout(() => { applicationProcess.kill('SIGKILL') }, 45000)
  try { assert.deepEqual(await exit, { code: 0, signal: null }) }
  finally { clearTimeout(timeout) }
  app = undefined
}
try {
  const environment = { ...process.env, ASPERA_DESKTOP_USER_DATA_DIR: userData,
    ASPERA_HOME: home, DEEPSEEK_API_KEY: '' }
  delete environment.ELECTRON_RUN_AS_NODE
  app = await electron.launch({ executablePath: executable, env: environment, timeout: 60000 })
  page = await app.firstWindow()
  const errors = []; page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()) })
  page.on('requestfailed', request => { console.error('Desktop request failed:', new URL(request.url()).pathname, request.failure()?.errorText) })
  page.on('response', async response => {
    if (new URL(response.url()).pathname.endsWith('/pluginManager/installBundle')) installResult = await response.json()
  })
  await page.waitForURL(url => url.hostname === '127.0.0.1', { timeout: 60000 })
  await openAspera(page, page.url())
  const api = await page.evaluate(async () => {
    const method = 'aspera/servers'
    const response = await fetch(new URL(`api/${method}`, location.href), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-api-smoke', method, payload: { args: {} } }) })
    return { status: response.status, body: await response.text() }
  })
  assert.equal(api.status, 200, `Desktop server API returned ${api.status}; required services: ${existsSync(apiReady) ? readFileSync(apiReady, 'utf8') : 'profile not settled'}`)
  assert.equal(JSON.parse(api.body).result.ok, true)
  await page.getByRole('button', { name: /^(服务器|Servers)$/ }).click()
  await page.getByRole('button', { name: /^(添加服务器|Add server)$/ }).click()
  await page.locator('input[name=username]').fill('trainer')
  assert.equal(await page.locator('input[name=password]').getAttribute('type'), 'password')
  const isolation = await app.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences()
    return { sandbox: preferences.sandbox, nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation }
  })
  assert.deepEqual(isolation, { sandbox: true, nodeIntegration: false, contextIsolation: true })
  assert.equal(await page.evaluate(() => typeof Reflect.get(window, 'require')), 'undefined')
  assert.deepEqual(errors, [])
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMenuBarVisible()), false)
  assert.equal(await page.locator('html').getAttribute('data-windows-titlebar'), '')
  assert.equal(await page.getByRole('heading', { name: /^(服务器|Servers)$/ }).evaluate(element => getComputedStyle(element).fontSize), '20px')
  assert.equal(await page.locator('form label').first().evaluate(element => getComputedStyle(element).fontSize), '13px')
  mkdirSync(output, { recursive: true })
  await page.screenshot({ path: resolve(output, 'desktop-window.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click()
  await page.getByRole('heading', { name: /^(插件|Plugins)$/ }).waitFor()
  const addPlugin = page.getByRole('button', { name: /添加插件|Add plugin/i })
  await addPlugin.waitFor()
  await addPlugin.click()
  await page.getByRole('dialog').waitFor()
  await page.getByRole('textbox', { name: /包名或地址|Package name or address/ }).fill(fixture)
  await page.getByRole('button', { name: /^(安装|Install)$/ }).click()
  await expect(page.getByRole('dialog')).toContainText(/已安装，下次启动后加载|Installed; it loads at the next start|插件安装失败|Installation failed/i, { timeout: 60000 })
  await expect(page.getByText(/已安装，下次启动后加载|Installed; it loads at the next start/)).toBeVisible({ timeout: 1000 })
  const manifest = JSON.parse(readFileSync(resolve(home, 'profiles/aspera-desktop/package.json'), 'utf8'))
  assert.ok(manifest.dependencies['aspera-desktop-smoke-plugin'])
  assert.equal(manifest.dsh.profile.bundles.includes('aspera-desktop-smoke-plugin'), false)
  await page.getByRole('button', { name: /^(立即启用|Enable now)$/i }).click()
  await expect.poll(() => JSON.parse(readFileSync(resolve(home, 'profiles/aspera-desktop/package.json'), 'utf8'))
    .dsh.profile.bundles.includes('aspera-desktop-smoke-plugin')).toBe(true)
  assert.equal(existsSync(resolve(home, 'desktop-plugin-loaded')), false)
  await page.keyboard.press('Escape')
  const beforeBuiltin = JSON.parse(readFileSync(resolve(home, 'profiles/aspera-desktop/package.json'), 'utf8')).dsh.profile.bundles
  await page.getByRole('switch', { name: /启用 自动化任务|Enable .*schedul/i }).click()
  await expect.poll(() => JSON.parse(readFileSync(resolve(home, 'profiles/aspera-desktop/package.json'), 'utf8'))
    .dsh.profile.bundles.length).toBe(beforeBuiltin.length + 1)
  await page.screenshot({ path: resolve(output, 'plugins-window.png'), fullPage: true })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close() })
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), false)
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show() })
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true)
  await quit()
  app = await electron.launch({ executablePath: executable, env: environment, timeout: 60000 })
  page = await app.firstWindow()
  await page.waitForURL(url => url.hostname === '127.0.0.1', { timeout: 60000 })
  await openAspera(page, page.url())
  const snapshot = JSON.parse(readFileSync(resolve(home, 'desktop-plugin-loaded'), 'utf8'))
  assert.match(snapshot.digest, /^[a-f0-9]{64}$/)
  assert.ok(snapshot.bytes > 0)
  assert.equal(snapshot.dependencies['@deepseek-ai/dsh'], '0.2.0-rc.2')
  for (const name of ['console', 'dispatch', 'experiments', 'runtime']) assert.equal(snapshot.dependencies[`@aspera/${name}`], `file:./${name}.tgz`)
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window.focus(); window.webContents.focus()
  })
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true)
  const nativeInputs = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents
    const inputs = []
    const observe = (_event, input) => { inputs.push({ type: input.type, code: input.code, control: input.control }) }
    contents.on('before-input-event', observe)
    try {
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'N', modifiers: ['control'] })
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'N', modifiers: ['control'] })
    } finally { contents.off('before-input-event', observe) }
    return inputs
  })
  assert.ok(nativeInputs.some(input => input.type === 'keyDown' && input.code === 'KeyN' && input.control))
  await expect(page.getByRole('heading', { name: /^(实验|Experiments)$/ })).not.toBeVisible()
  await page.getByRole('button', { name: /^(实验|Experiments)$/ }).click()
  await page.getByRole('button', { name: /^(新建实验|New experiment)$/ }).click()
  const mode = page.getByRole('button', { name: /^全自动执行|^Automatic/ })
  await expect(mode).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('input[name=runtime],input[name=maxCommands],input[name=maxGoalRounds],input[name=maxServiceSeconds]')).toHaveCount(0)
  await app.evaluate(({ BrowserWindow, Tray }) => {
    globalThis.asperaAttentionEvidence = { overlays: [], trays: [], tooltips: [] }
    const overlay = BrowserWindow.prototype.setOverlayIcon
    BrowserWindow.prototype.setOverlayIcon = function(image, description) {
      globalThis.asperaAttentionEvidence.overlays.push({ empty: image === null || image.isEmpty(), description })
      return overlay.call(this, image, description)
    }
    const image = Tray.prototype.setImage
    Tray.prototype.setImage = function(value) { globalThis.asperaAttentionEvidence.trays.push(value.toPNG().toString('base64')); return image.call(this, value) }
    const tip = Tray.prototype.setToolTip
    Tray.prototype.setToolTip = function(value) { globalThis.asperaAttentionEvidence.tooltips.push(value); return tip.call(this, value) }
  })
  for (const count of [1, 99, 100]) await page.evaluate(count => window.asperaDesktop.setAttentionCount(count), count)
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].hide() })
  await page.evaluate(() => window.asperaDesktop.setAttentionCount(12))
  const evidence = await app.evaluate(() => globalThis.asperaAttentionEvidence)
  assert.equal(evidence.overlays.filter(item => !item.empty).length >= 4, true)
  assert.ok(evidence.tooltips.some(item => item.includes('100')))
  assert.notEqual(evidence.trays[0], evidence.trays.at(-1))
  await page.evaluate(() => window.asperaDesktop.setAttentionCount(0))
  assert.equal((await app.evaluate(() => globalThis.asperaAttentionEvidence)).overlays.at(-1).empty, true)
  await assert.rejects(page.evaluate(() => window.asperaDesktop.setAttentionCount(-1)))
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].show() })
  await page.screenshot({ path: resolve(output, 'new-experiment-window.png'), fullPage: true })
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  await page.screenshot({ path: resolve(output, 'dark-window.png'), fullPage: true })
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(680, 820) })
  await page.screenshot({ path: resolve(output, 'narrow-window.png'), fullPage: true })
  await quit()
  console.log('Packaged desktop: official typography/caption, real plugin installation and restart activation, native shortcut, menu dismissal, isolated renderer, tray and graceful Host shutdown passed.')
} catch (error) {
  if (page !== undefined && !page.isClosed()) {
    const details = page.getByRole('button', { name: /查看安装详情|View install details/i })
    if (await details.isVisible()) await details.click()
    await page.screenshot({ path: resolve(output, 'desktop-failure.png'), fullPage: true })
    console.error((await page.locator('body').innerText()).slice(-5000))
    if (installResult !== undefined) console.error(JSON.stringify(installResult).slice(-7000))
  }
  throw error
} finally { await app?.close(); removeTestDirectory(directory, tmpdir()) }
