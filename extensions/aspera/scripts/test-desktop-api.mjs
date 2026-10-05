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
  const result = await page.evaluate(async () => {
    const method = 'aspera/servers'
    const response = await fetch(new URL(`api/${method}`, location.href), { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'desktop-upgrade-api', method, payload: { args: {} } }) })
    return { status: response.status, body: await response.text() }
  })
  assert.equal(result.status, 200, `Upgraded desktop server API returned ${result.status}: ${result.body}`)
  assert.deepEqual(JSON.parse(result.body).result, { ok: true, value: { servers: [] } })
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
  console.log('Upgraded desktop: real server API, saved server form and version-1 registry passed outside the checkout with a Unicode state path.')
} finally { await app?.close(); removeTestDirectory(directory, tmpdir()) }
