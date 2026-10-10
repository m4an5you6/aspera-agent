/** Exercise production overview components with explicitly recorded CPU display fixtures. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { expect } from '@playwright/test'
import { openAspera } from './test-app.mjs'
import { checkOverviewPhase } from './test-stage-layout.mjs'

/** @param page - real profile page. @param control - scoped CPU fixture control. @param create - normal experiment form flow.
 * @param browser - browser for a second locale context. @param url - authenticated profile entry. @param output - screenshots.
 * @returns stable UI facts and the display fixture identity; no GPU acceptance is inferred.
 */
export async function checkExecutionOverview(page, control, create, browser, url, output) {
  await create('CPU overview review', ['CPU A', 'CPU B'])
  await expect(page.locator('header').getByRole('status')).toHaveText(/已完成|Completed/)
  const row = (await control()).experiments.find(value => value.request.objective === 'CPU overview review')
  const id = row.request.experimentId
  const stage = page.getByRole('region', { name: /^(当前阶段|Current stage)$/ })
  const steps = page.getByRole('region', { name: /^(执行进展|Execution progress)$/ })
  const diagnostics = page.getByRole('region', { name: /^(诊断详情|Diagnostics)$/ })
  const setMode = async name => { await control('overview-' + name, id); await page.locator('header').getByRole('button', { name: /^(刷新|Refresh)$/ }).click() }
  await setMode('running')
  await checkOverviewPhase(page, 2, true)
  await expect(steps.locator('li')).toHaveCount(row.latest.plan.steps.length)
  await expect(steps.locator('[data-step-state="running"]')).toHaveAttribute('aria-busy', 'true')
  await expect(steps).toContainText(/Agent 上报|Agent reports/)
  await expect(stage.locator('dt')).toHaveCount(3)
  await expect(stage.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '540')
  await expect(stage.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '2000')
  await expect(stage).toContainText('27%')
  await expect(stage).not.toContainText('custom_fixture_metric')
  const resources = page.getByRole('region', { name: /^(节点进度|Node progress)$/ })
  await expect(resources.locator('article')).toHaveCount(2)
  await expect(resources).toContainText('CPU fixture GPU')
  await expect(resources).toContainText('GPU-11111111-1111-1111-1111-111111111111')
  await expect(resources).toContainText(/准备验收与当前执行进展分别记录|Preparation acceptance and current execution progress/)
  await page.setViewportSize({ width: 1440, height: 1100 })
  await stage.scrollIntoViewIfNeeded()
  await page.screenshot({ path: resolve(output, 'overview-production-running-light.png'), fullPage: true })
  const reportTimes = await steps.locator('time').allTextContents()
  await setMode('read-failure')
  await expect(steps).toContainText(/暂时无法刷新|could not refresh/)
  assert.deepEqual(await steps.locator('time').allTextContents(), reportTimes, 'A failed refresh retains the previous report and timestamp')
  await expect(steps.locator('[data-step-state="running"]')).toHaveCount(1)
  await setMode('partial')
  await expect(steps).not.toContainText(/暂时无法刷新|could not refresh/)
  await expect(stage.locator('dt')).toHaveCount(1)
  await expect(stage).toContainText('0.91')
  await expect(stage.getByRole('progressbar')).toHaveCount(0)
  await setMode('invalid-total')
  await expect(stage.locator('dt')).toHaveCount(3)
  await expect(stage.getByRole('progressbar')).toHaveCount(0)
  await setMode('blocked')
  await checkOverviewPhase(page, 2, false)
  await expect(stage).toContainText('CPU fixture dependency unavailable')
  await expect(stage.locator('dt')).toHaveCount(0)
  await expect(stage).not.toContainText('A long retained command error')
  await expect(steps.locator('[data-step-state="blocked"]')).toHaveCount(1)
  await expect(steps.locator('[data-state="ongoing"]')).toHaveCount(0)
  const disclosure = diagnostics.locator('details').first()
  await expect(disclosure).not.toHaveAttribute('open', '')
  await disclosure.locator('summary').first().focus()
  await page.keyboard.press('Enter')
  await expect(disclosure).toHaveAttribute('open', '')
  await expect(diagnostics.getByText(/^(命令尝试次数|Command attempts)$/)).toBeVisible()
  await expect(diagnostics.getByText('custom_fixture_metric', { exact: true })).toBeVisible()
  await disclosure.locator('summary').first().click()
  const themes = ['light', 'dark']
  for (const theme of themes) {
    await page.evaluate(dark => { if (dark) document.body.dataset.dsDarkTheme = ''; else delete document.body.dataset.dsDarkTheme }, theme === 'dark')
    for (const width of [1440, 620]) {
      await page.setViewportSize({ width, height: 1100 })
      await stage.scrollIntoViewIfNeeded()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Overview fits a narrow window')
      assert.ok(await stage.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Current work stays inside its column')
      const workBox = await stage.boundingBox(); const resourceBox = await resources.boundingBox()
      assert.ok(width === 1440 ? resourceBox.x > workBox.x + workBox.width : resourceBox.y > workBox.y + workBox.height, 'Work and resources follow the responsive column order')
      await page.screenshot({ path: resolve(output, `overview-production-blocked-${theme}-${width}.png`), fullPage: true, animations: 'disabled' })
    }
  }
  await page.evaluate(() => { delete document.body.dataset.dsDarkTheme })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await setMode('cancelled')
  await expect(page.locator('header').getByRole('status')).toHaveText(/已取消|Cancelled/)
  await expect(steps.locator('[data-step-state="running"]')).toHaveAttribute('aria-busy', 'false')
  await expect(steps).toContainText(/已停止|Stopped/)
  await expect(steps.locator('[data-state="ongoing"]')).toHaveCount(0)
  await setMode('legacy')
  await checkOverviewPhase(page, 3, false)
  await expect(steps).toContainText(/未记录步骤进度|Step progress has not been recorded/)
  await expect(steps.locator('[data-step-state="completed"]')).toHaveCount(0)
  await expect(steps.locator('li')).toHaveCount(row.latest.plan.steps.length)
  await page.screenshot({ path: resolve(output, 'overview-production-legacy.png'), fullPage: true })
  await setMode('completed')
  await expect(steps.locator('[data-step-state="completed"]')).toHaveCount(row.latest.plan.steps.length)
  await expect(steps.locator('[data-state="ongoing"]')).toHaveCount(0)
  await page.screenshot({ path: resolve(output, 'overview-production-completed.png'), fullPage: true })
  await setMode('read-failure')
  const english = await browser.newContext({ locale: 'en-US' })
  try {
    const translated = await english.newPage()
    await openAspera(translated, url)
    await translated.getByRole('button', { name: 'CPU overview review', exact: true }).click()
    const translatedSteps = translated.getByRole('region', { name: 'Execution progress', exact: true })
    await expect(translatedSteps).toContainText('Step progress could not be read')
    await expect(translatedSteps).not.toContainText('the last saved report is retained')
    await setMode('blocked')
    await expect(translatedSteps).toContainText('Agent reports')
    await expect(translated.getByRole('region', { name: 'Current stage', exact: true })).toContainText('Execution has stopped')
    await translated.setViewportSize({ width: 1440, height: 1100 })
    await translated.screenshot({ path: resolve(output, 'overview-production-blocked-en.png'), fullPage: true })
  } finally { await english.close() }
  return { id, facts: { actualPlanSteps: row.latest.plan.steps.length, savedNodes: 2, coreMetrics: 3, missingMetricsAbsent: true,
    reportedTrainingPercentage: 27, invalidTotalHidden: true, readFailureRetainsReports: true, initialReadFailureDistinct: true, internalFieldsCollapsed: true,
    stoppedAnimations: true, oldReleaseUnrecorded: true, localizedLabels: true, responsiveColumns: true, keyboardDisclosure: true } }
}
