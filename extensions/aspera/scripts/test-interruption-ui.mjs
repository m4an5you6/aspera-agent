/** Real Host interruption, original queue cleanup and profile-launched service exit in the CPU Web replay. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { expect as baseExpect } from '@playwright/test'
import { openAspera } from './test-app.mjs'
const expect = baseExpect.configure({ timeout: 40000 })

/** @param page - formal profile detail page. @param control - scoped CPU transport controls. @param id - running experiment.
 * @param output - screenshots. @param browser - locale context owner. @param url - authenticated Web entry.
 * @returns observed operation identities; this replay does not claim Linux or GPU acceptance.
 */
export async function checkInterruption(page, control, id, output, browser, url) {
  const progress = page.getByRole('region', { name: /^(停止任务与释放占用|Stopping and resource release)$/ })
  const button = page.locator('header').getByRole('button', { name: /^(中断实验|Interrupt experiment)$/ })
  await control('hold-interruption', id)
  await button.click()
  await expect(progress).toHaveAttribute('aria-busy', 'true')
  const steps = page.getByRole('region', { name: /^(执行进展|Execution progress)$/ })
  await expect(steps).toContainText(/最后上报为进行中 · 当前状态待核验|Last reported running · current activity unverified/)
  await expect(steps).not.toContainText(/已停止 · 最后上报为进行中|Stopped · last reported running/)
  await expect(page.locator('header').getByRole('button', { name: /^(正在中断…|Interrupting…)$/ })).toBeDisabled()
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.screenshot({ path: resolve(output, 'interruption-production-running.png'), fullPage: true })
  const operationId = (await control()).interruptions.find(status => status.experimentId === id).operationId
  await page.getByRole('button', { name: /^(返回实验|Back to experiments)$/ }).click()
  await expect(page.getByRole('row').filter({ has: page.getByText('CPU shared experiment', { exact: true }) })).toContainText(/正在中断|Interrupting/)
  await page.getByRole('button').filter({ has: page.getByText('CPU shared experiment', { exact: true }) }).click()
  await expect(progress).toHaveAttribute('aria-busy', 'true')
  await control('fail-interruption', id)
  await expect(progress).toHaveAttribute('aria-busy', 'false')
  await expect(progress).toContainText(/退出待核验|Exit awaiting verification/)
  await expect(progress.locator('[data-state="ongoing"]')).toHaveCount(0)
  const blocked = (await control()).experiments.find(row => row.request.experimentId === id)
  assert.equal(blocked.latest.resourcesReleased, false)
  assert.equal(blocked.latest.state, 'serving')
  await expect(steps).toContainText(/最后上报为进行中 · 当前状态待核验|Last reported running · current activity unverified/)
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  await page.screenshot({ path: resolve(output, 'interruption-production-blocked-dark.png'), fullPage: true })
  await page.setViewportSize({ width: 520, height: 950 })
  await expect(progress).toBeVisible()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Interruption progress fits the narrow window')
  await page.screenshot({ path: resolve(output, 'interruption-production-blocked-narrow.png'), fullPage: true })
  await page.evaluate(() => { delete document.body.dataset.dsDarkTheme })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await control('release-interruption', id)
  await page.locator('header').getByRole('button', { name: /^(重试中断|Retry interruption)$/ }).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('header').getByRole('status')).toHaveText(/已中断|Interrupted/, { timeout: 40000 })
  await expect(progress).toContainText(/已释放|Released/)
  await expect(progress).toHaveAttribute('aria-busy', 'false')
  await expect(progress.locator('[data-state="ongoing"]')).toHaveCount(0)
  await expect(steps).toContainText(/已停止 · 最后上报为进行中|Stopped · last reported running/)
  const final = (await control()).interruptions.find(status => status.experimentId === id)
  assert.equal(final.phase, 'released'); assert.equal(final.operationId, operationId)
  assert.equal(final.result.state, 'cancelled'); assert.equal(final.result.resourcesReleased, true)
  assert.ok(final.nodes.every(node => node.agentsExited && node.commandsReleased && node.servicesReleased))
  await page.screenshot({ path: resolve(output, 'interruption-production-released.png'), fullPage: true })
  const english = await browser.newContext({ locale: 'en-US' })
  try {
    const translated = await english.newPage(); await openAspera(translated, url)
    await translated.getByRole('button', { name: 'CPU shared experiment', exact: true }).click()
    await expect(translated.locator('header').getByRole('status')).toHaveText('Interrupted')
    await expect(translated.getByRole('region', { name: 'Stopping and resource release', exact: true })).toContainText('Resources released')
    await translated.screenshot({ path: resolve(output, 'interruption-production-released-en.png'), fullPage: true })
  } finally { await english.close() }
  return { id, operationId, confirmedNodes: final.nodes.length, blockedRetryRetainsIdentity: true, hiddenPageContinues: true, originalOutcome: final.result.state }
}
