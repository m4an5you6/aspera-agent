/** Validate recorded failure and recovery controls inside the production stage card. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { expect } from '@playwright/test'

/**
 * Inspect a failed experiment rendered by the real Web profile.
 * @param page - selected experiment detail page.
 * @param directory - screenshot output directory.
 * @param preparation - whether the failure occurred before remote handover.
 * @returns the stable presentation facts recorded with the Session replay.
 */
export async function checkStageLayout(page, directory, preparation) {
  const stage = page.getByRole('region', { name: /^(当前阶段|Current stage)$/ })
  const info = page.getByRole('complementary', { name: /^(实验信息|Experiment information)$/ })
  const retry = stage.getByRole('button', { name: /^(重试准备|Retry preparation)$/ })
  await expect(stage.getByRole('alert')).toHaveCount(1)
  await expect(retry).toHaveCount(preparation ? 1 : 0)
  await expect(info.getByText(/^(执行位置|Execution location)$/)).toBeVisible()
  await expect(info.getByText(/^(执行方式|Execution mode)$/)).toBeVisible()
  await expect(info.getByText(preparation ? /^(本机准备|Preparing on this computer)$/ : /^(远端服务器|Remote servers)$/)).toBeVisible()
  const pipeline = await checkOverviewPhase(page, preparation ? 0 : 2, false)
  if (preparation) await expect(stage.getByRole('heading', { name: /^(准备未完成|Preparation could not finish)$/ })).toBeVisible()
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dark: 'dsDarkTheme' in document.body.dataset }))
  const error = stage.getByRole('alert').locator('details')
  try {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => { if (dark) document.body.dataset.dsDarkTheme = ''; else delete document.body.dataset.dsDarkTheme }, theme === 'dark')
      for (const width of [1440, 680]) {
        await page.setViewportSize({ width, height: 960 })
        await error.locator('summary').click()
        await expect(error).toHaveAttribute('open', '')
        assert.ok(await stage.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Stage content must fit with diagnostics expanded')
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Stage content must not widen the window')
        if (preparation) { await retry.scrollIntoViewIfNeeded(); await expect(retry).toBeInViewport() }
        await stage.screenshot({ path: resolve(directory, `stage-${preparation ? 'preparation' : 'remote'}-${theme}-${width}.png`) })
        await error.locator('summary').click()
        await expect(error).not.toHaveAttribute('open', '')
      }
    }
  } finally {
    await page.setViewportSize({ width: original.width, height: original.height })
    await page.evaluate(dark => { if (dark) document.body.dataset.dsDarkTheme = ''; else delete document.body.dataset.dsDarkTheme }, original.dark)
  }
  return { errorInStage: true, retryInStage: preparation, nodes: await page.getByRole('region', { name: /^(节点进度|Node progress)$/ }).locator('article').count(), pipeline }
}

/**
 * Assert phase and activity from a real scheduling transition.
 * @param page - selected experiment detail.
 * @param phase - zero-based expected main phase.
 * @param busy - whether work should animate.
 * @returns stable pipeline states for the recorded Session snapshot.
 */
export async function checkOverviewPhase(page, phase, busy) {
  const pipeline = page.getByRole('region', { name: /^(实验进度|Experiment progress)$/ })
  const steps = pipeline.locator('li')
  await expect(steps).toHaveCount(4)
  await expect(steps.nth(phase)).toHaveAttribute('aria-current', 'step')
  const stage = page.getByRole('region', { name: /^(当前阶段|Current stage)$/ })
  await expect(stage).toHaveAttribute('aria-busy', String(busy))
  await expect(pipeline.locator('[data-state="ongoing"]')).toHaveCount(busy ? 1 : 0)
  return steps.evaluateAll(items => items.map(item => item.dataset.state))
}
