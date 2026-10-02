/** Measure the packaged desktop's visible startup and inspect the reported UI regressions. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { _electron as electron, expect } from '@playwright/test'
import { removeTestDirectory } from './test-app.mjs'

const root = resolve(import.meta.dirname, '..'); const artifacts = resolve(root, '.artifacts')
mkdirSync(artifacts, { recursive: true })
const directory = mkdtempSync(resolve(artifacts, 'desktop-measure-'))
const samples = []
const runs = Number(process.argv.find(argument => argument.startsWith('--runs='))?.slice('--runs='.length) ?? 1)
assert.ok(Number.isInteger(runs) && runs >= 1 && runs <= 10, '--runs must be an integer from 1 to 10')
let application; let desktopVersion
try {
  for (let run = 0; run < runs; run++) for (const state of process.argv.includes('--existing-home') ? ['first-launch', 'existing-home'] : ['first-launch']) {
    const environment = { ...process.env, ASPERA_DESKTOP_USER_DATA_DIR: resolve(directory, String(run), 'user-data'),
      ASPERA_HOME: resolve(directory, String(run), 'home'), DEEPSEEK_API_KEY: 'desktop-startup-fixture' }
    delete environment.ELECTRON_RUN_AS_NODE
    const started = performance.now()
    const version = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')).version
    const executablePath = process.env.ASPERA_DESKTOP_EXECUTABLE || resolve(artifacts, `desktop-${version}/win-unpacked/Aspera.exe`)
    application = await electron.launch({ executablePath, env: environment, timeout: 60000 })
    const page = await application.firstWindow()
    const windowMs = performance.now() - started
    desktopVersion = await application.evaluate(({ app }) => app.getVersion())
    await page.waitForURL(url => url.hostname === '127.0.0.1', { timeout: 60000 })
    const documentMs = performance.now() - started
    console.log(JSON.stringify({ state, windowMs: Math.round(windowMs), documentMs: Math.round(documentMs) }))
    const notice = page.getByText(/^(继续|Continue)$/, { exact: true })
    const later = page.getByText(/^(稍后配置|Configure later)$/, { exact: true })
    const sidebar = page.getByRole('button', { name: 'Aspera', exact: true })
    const dismissed = new Set()
    for (let attempt = 0; attempt < 120; attempt++) {
      for (const [id, control] of [['notice', notice], ['later', later]]) {
        if (!dismissed.has(id) && await control.isVisible() && await control.isEnabled()) {
          dismissed.add(id)
          await control.click()
          await control.waitFor({ state: 'hidden' })
        }
      }
      if (await sidebar.click({ trial: true, timeout: 150 }).then(() => true, () => false)) break
      await page.waitForTimeout(100)
    }
    await sidebar.waitFor({ timeout: 15000 })
    const usableMs = performance.now() - started
    await sidebar.click()
    await page.getByRole('heading', { name: 'Aspera', exact: true }).waitFor()
    await page.getByRole('button', { name: /^(服务器|Servers)$/ }).click()
    await page.getByRole('button', { name: /^(添加服务器|Add server)$/ }).click()
    const typography = await page.locator('form').evaluate(form => {
      const label = form.querySelector('label'); const input = form.querySelector('input')
      const style = element => { const css = getComputedStyle(element); return { fontFamily: css.fontFamily, fontSize: css.fontSize, lineHeight: css.lineHeight } }
      return { label: style(label), input: style(input), body: style(document.body) }
    })
    await page.getByRole('button', { name: /^(插件|Plugins)$/, exact: true }).click()
    await page.getByRole('heading', { name: /^(插件|Plugins)$/ }).waitFor()
    await expect.poll(async () => await page.getByText(/本部署没有可管理的 profile|no manageable profile/i).isVisible()
      || await page.getByRole('button', { name: /添加插件|Add plugin/i }).isEnabled(), { timeout: 15000 }).toBe(true)
    const unavailable = await page.getByText(/本部署没有可管理的 profile|no manageable profile/i).isVisible()
    const addEnabled = await page.getByRole('button', { name: /添加插件|Add plugin/i }).isEnabled()
    const chrome = await application.evaluate(({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0]
      return { nativeMenuVisible: main.isMenuBarVisible(), contentBounds: main.getContentBounds(), windowBounds: main.getBounds() }
    })
    const sample = { run: run + 1, state, windowMs: Math.round(windowMs), documentMs: Math.round(documentMs), usableMs: Math.round(usableMs), plugins: { unavailable, addEnabled }, typography, chrome }
    samples.push(sample)
    console.log(JSON.stringify(sample))
    await application.close(); application = undefined
  }
  const report = JSON.stringify({ desktop: desktopVersion, runtime: process.version, platform: process.platform, arch: process.arch, samples }, null, 2) + '\n'
  mkdirSync(resolve(artifacts, 'desktop'), { recursive: true })
  writeFileSync(resolve(artifacts, 'desktop/startup-measurement.json'), report)
  writeFileSync(resolve(artifacts, `desktop/startup-measurement-${desktopVersion}.json`), report)
  if (process.argv.includes('--assert-fixed')) {
    for (const sample of samples) {
      assert.equal(sample.plugins.unavailable, false, 'DSH plugin manager is unavailable')
      assert.equal(sample.plugins.addEnabled, true, 'DSH plugin installation is disabled')
      assert.equal(sample.typography.label.fontSize, '13px', 'Form labels lost the shared typography')
      assert.equal(sample.chrome.nativeMenuVisible, false, 'Windows should use the official in-page application menu')
    }
  }
} finally { await application?.close(); removeTestDirectory(directory, artifacts) }
