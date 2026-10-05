/** Exercise official trajectory rendering with locally recorded CPU Sessions. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, expect } from '@playwright/test'
import { command, launchProfile, openAspera, removeTestDirectory } from './test-app.mjs'
import { fixtureOptions, fixtureProvider } from './fixtures/models.mjs'

const root = resolve(import.meta.dirname, '..')
mkdirSync(resolve(root, '.artifacts'), { recursive: true })
const directory = mkdtempSync(resolve(root, '.artifacts/observations-web-'))
const home = resolve(directory, 'home')
await command(process.execPath, ['scripts/setup.mjs'], root, { ASPERA_HOME: home })
writeFileSync(resolve(home, 'profiles/aspera/cordis.patch.yml'), JSON.stringify([
  { id: 'hmr', disabled: true }, { id: 'client-hmr', disabled: true }, { id: 'aspera-dispatch', disabled: true },
  { id: 'aspera-console', config: { pollIntervalMs: 500 } },
  { id: 'llm-pi-ai', config: { providers: { [fixtureProvider]: fixtureOptions } } },
  { id: 'agent-default-model', config: { provider: fixtureProvider, model: 'qwen-preparation' } },
  { insert: [{ id: 'aspera-test-fixture', name: pathToFileURL(resolve(root, 'scripts/fixtures/web.mjs')).href,
    config: { role: 'web', root: resolve(directory, 'remote'), release: root, observationHistory: true, profileStartupMs: 180000 } }] },
]))
let app; let browser; let page
try {
  app = await launchProfile(root, home, 'aspera', {}, 180000)
  browser = await chromium.launch({ ...(process.env.ASPERA_BROWSER_EXECUTABLE ? { executablePath: process.env.ASPERA_BROWSER_EXECUTABLE } : { channel: 'chrome' }), headless: true })
  page = await browser.newPage({ viewport: { width: 1440, height: 940 } })
  const errors = []
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message) })
  await openAspera(page, app.url)
  await page.getByRole('button', { name: /^(服务器|Servers)$/ }).click()
  await page.getByRole('button', { name: /^(添加服务器|Add server)$/ }).click()
  await page.locator('input[name=name]').fill('CPU observations')
  await page.locator('input[name=host]').fill('observations.test')
  await page.locator('input[name=username]').fill('trainer')
  await page.getByRole('dialog').getByLabel(/^(服务器密码|Server password)$/).fill('cpu-fixture-only')
  await page.getByRole('button', { name: /^(保存服务器|Save server)$/ }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('button', { name: /^(新建实验|New experiment)$/ }).click()
  await page.getByLabel(/^(实验名称|Experiment name)$/).fill('CPU completed experiment')
  await page.getByLabel('Goal', { exact: true }).fill('CPU completed experiment')
  await page.getByRole('button', { name: /^(计划模型|Planning model)$/ }).click()
  await page.getByRole('menuitem', { name: /CPU Qwen planning/ }).click()
  await page.getByRole('button', { name: /^(执行模型|Execution model)$/ }).click()
  await page.getByRole('menuitem', { name: /CPU Qwen execution/ }).click()
  await page.getByRole('checkbox', { name: /CPU observations/ }).check()
  await page.getByRole('button', { name: /^(提交实验|Submit experiment)$/ }).click()
  await expect(page.getByRole('status').first()).toHaveText(/已完成|Completed/, { timeout: 90000 })
  await page.getByRole('button', { name: /^(Agent 记录|Agent records)$/ }).click()
  await expect(page.getByRole('button', { name: /^(对话|Conversation)$/ })).toHaveCount(0)
  await page.getByRole('button', { name: /计划|Planning/ }).filter({ hasText: /计划|Planning/ }).last().click()
  const ledger = page.locator('[data-trajectory-scroll]:visible')
  await expect(ledger).toContainText('Planning history 219', { timeout: 20000 })
  await expect(ledger).not.toContainText('Planning history 000')
  await expect(async () => {
    await ledger.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')) })
    await expect(ledger).toContainText('Planning history 000', { timeout: 1500 })
  }).toPass({ timeout: 20000 })
  const search = page.getByPlaceholder(/^(搜索|Search)$/).filter({ visible: true })
  await search.fill('Planning history 180')
  await expect(ledger).toContainText('Planning history 180')
  await expect(ledger).not.toContainText('Planning history 179')
  await page.getByRole('button', { name: /^(执行|Execution)$/ }).click()
  await page.getByRole('button', { name: /^(计划|Planning)$/ }).click()
  await expect(search).toHaveValue('Planning history 180')
  await search.fill('')
  await expect(ledger).toContainText('Planning history 000')
  await ledger.evaluate(element => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => page.locator('[data-readonly-timeline]:visible').evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
  const savedPosition = await ledger.evaluate(element => element.scrollTop)
  await page.getByRole('button', { name: /^(执行|Execution)$/ }).click()
  await page.getByRole('button', { name: /^(计划|Planning)$/ }).click()
  await expect.poll(() => ledger.evaluate(element => element.scrollTop)).toBeGreaterThan(savedPosition - 32)
  await page.locator('[data-readonly-timeline]:visible').evaluate(element => { element.scrollLeft = 0 })
  await expect.poll(() => ledger.evaluate(element => element.scrollTop)).toBeLessThan(200)
  const title = page.getByRole('heading', { name: 'CPU completed experiment', exact: true })
  const top = (await title.boundingBox()).y
  await page.getByRole('button', { name: /^(执行|Execution)$/ }).click()
  await page.locator('[data-record-index]').filter({ hasText: 'run_experiment_command' }).click()
  await page.locator('#trajectory-detail-input:visible').click()
  await expect(page.locator('#trajectory-detail-panel:visible')).toContainText('fixture-service')
  await page.screenshot({ path: resolve(root, '.artifacts/observations-trace.png') })
  await page.getByRole('button', { name: /查看日志|View logs/ }).click()
  const logs = page.getByRole('region', { name: /^(进程日志|Process logs)$/ })
  await expect(logs).toContainText('CPU observation 239', { timeout: 15000 })
  await page.screenshot({ path: resolve(root, '.artifacts/observations-monitor.png') })
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  await page.screenshot({ path: resolve(root, '.artifacts/observations-monitor-dark.png') })
  await page.setViewportSize({ width: 1000, height: 760 })
  await expect(logs).toBeInViewport()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Monitoring must fit a narrow window')
  await page.screenshot({ path: resolve(root, '.artifacts/observations-monitor-narrow.png') })
  await page.evaluate(() => { delete document.body.dataset.dsDarkTheme })
  await page.setViewportSize({ width: 1440, height: 940 })
  const control = async kind => {
    const url = new URL('/aspera-test/' + (kind ?? 'state'), app.url)
    const state = await (await fetch(new URL('/aspera-test/state', app.url))).json()
    url.searchParams.set('id', state.experiments[0].request.experimentId)
    return (await fetch(url)).json()
  }
  await logs.evaluate(element => { element.scrollTop = 180 })
  await expect(page.getByRole('button', { name: /回到最新|Back to latest/ })).toBeVisible()
  const position = await logs.evaluate(element => element.scrollTop)
  await control('observation-append')
  await expect(page.getByRole('button', { name: /新输出|New output/ })).toBeVisible({ timeout: 10000 })
  assert.equal(await logs.evaluate(element => element.scrollTop), position)
  await page.getByRole('button', { name: /回到最新|Back to latest/ }).click()
  await expect(logs).toContainText('CPU newly received output')
  const downloading = page.waitForEvent('download')
  await page.getByRole('button', { name: /下载完整日志|Download complete log/ }).click()
  assert.ok(readFileSync(await (await downloading).path(), 'utf8').includes('CPU newly received output'))
  await page.getByRole('button', { name: /^(Agent 记录|Agent records)$/ }).click()
  await control('fail-status')
  await expect(page.getByRole('alert')).toContainText(/操作失败|operation failed/, { timeout: 10000 })
  assert.equal((await title.boundingBox()).y, top)
  await page.getByRole('alert').getByRole('button', { name: '×', exact: true }).click()
  await page.getByRole('button', { name: /^(刷新|Refresh)$/ }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.reload(); await openAspera(page, app.url)
  await page.getByRole('button').filter({ has: page.getByText('CPU completed experiment', { exact: true }) }).click()
  await page.getByRole('button', { name: /^(刷新|Refresh)$/ }).click()
  await expect(page.getByRole('alert')).toHaveCount(0)
  await control('timeout-status')
  await expect(page.getByRole('alert')).toContainText(/超时|timed out/, { timeout: 10000 })
  await page.screenshot({ path: resolve(root, '.artifacts/observations-toast.png') })
  assert.deepEqual(errors, [])
  console.log('Official phases/inspector, tool-to-log navigation, independent receiving/reading, full download and persistent non-shifting Toasts passed.')
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: resolve(root, '.artifacts/observations-failure.png') })
    console.error((await page.locator('body').innerText()).slice(-6000))
  }
  console.error(app?.output().replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>').slice(-5000)); throw error
} finally {
  await browser?.close(); await app?.close(); removeTestDirectory(directory, resolve(root, '.artifacts'))
}
