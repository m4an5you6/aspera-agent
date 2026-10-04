/** Browser checks for long model labels and the official-style Aspera disclosure. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { expect } from '@playwright/test'

const modelOptions = [
  { provider: 'qwen-chat', name: 'nvidia/Qwen3.8-Flash-Next-NVFP4' },
  { provider: 'qwen-chat', name: 'nvidia/Qwen3.8-Flash-Next-NVFP4-Long-Context-Research-Preview-International' },
  { provider: 'qwen-chat-international-research-custom-api-provider', name: 'nvidia/Qwen3.8-Flash-Next-NVFP4-Long-Context-Research-Preview-International-Experimental' },
]
const phaseLabels = [/^(准备模型|Preparation model)$/, /^(计划模型|Planning model)$/, /^(执行模型|Execution model)$/]
const labelFor = row => `${row.provider} · ${row.name}`

async function checkSingleLine(control) {
  const bounds = await control.evaluate(element => {
    const label = element.querySelector('span'); const arrow = element.querySelector('svg')
    const box = element.getBoundingClientRect(); const text = label.getBoundingClientRect(); const icon = arrow.getBoundingClientRect()
    const range = document.createRange(); range.selectNodeContents(label)
    return { height: box.height, textHeight: text.height, contained: text.top >= box.top && text.bottom <= box.bottom
      && text.left >= box.left && text.right <= icon.left && icon.right <= box.right,
    lineCount: new Set(Array.from(range.getClientRects(), rect => Math.round(rect.top))).size }
  })
  assert.ok(bounds.contained && bounds.lineCount === 1, `Model label must stay on one line inside the control: ${JSON.stringify(bounds)}`)
}

/**
 * Check real selectors with public catalog display fixtures; no experiment is submitted.
 * @param page - actual DSH page.
 * @param directory - screenshot directory.
 * @param prefix - Web or packaged desktop artifact prefix.
 * @param activateWindow - optional native activation before keyboard checks.
 * @param resize - viewport or native window resize operation.
 * @returns after labels, tooltips, menus, settings and summary fit their containers.
 */
export async function checkModelPickerLayout(page, directory, prefix, resize = size => page.setViewportSize(size)) {
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dark: 'dsDarkTheme' in document.body.dataset }))
  const pattern = '**/api/aspera/experimentModels'
  const intercept = async route => {
    const response = await route.fetch()
    const body = await response.json()
    assert.equal(body.result.ok, true)
    const models = modelOptions.map(row => ({ provider: row.provider, providerName: row.provider, model: row.name, name: row.name,
      reasoning: [], configured: true, transferable: true }))
    await route.fulfill({ response, json: { ...body, result: { ...body.result, value: { models,
      current: { provider: models[0].provider, model: models[0].model } } } } })
  }
  await page.route(pattern, intercept)
  try {
    await resize({ width: 1440, height: 960 })
    await page.getByRole('button', { name: /^(新建实验|New experiment)$/ }).click()
    const controls = phaseLabels.map(name => page.getByRole('button', { name }))
    await expect(controls[0]).toContainText(labelFor(modelOptions[0]))
    await checkSingleLine(controls[0])
    for (const [index, control] of controls.entries()) {
      await control.click()
      const item = page.getByRole('menuitem', { name: labelFor(modelOptions[index]), exact: true })
      await expect(item).toBeVisible()
      const fits = await item.evaluate(element => {
        const range = document.createRange(); range.selectNodeContents(element.querySelector('span'))
        const text = range.getBoundingClientRect(); const box = element.getBoundingClientRect()
        return text.left >= box.left && text.right <= box.right && text.top >= box.top && text.bottom <= box.bottom
      })
      assert.ok(fits, 'Full model menu text must fit the option row')
      if (index === controls.length - 1) await page.screenshot({ path: resolve(directory, `${prefix}-models-menu.png`), fullPage: true })
      await item.click()
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(dark => { if (dark) document.body.dataset.dsDarkTheme = ''; else delete document.body.dataset.dsDarkTheme }, theme === 'dark')
      for (const width of [1440, 980, 680]) {
        await resize({ width, height: 960 })
        for (const control of controls) {
          await control.scrollIntoViewIfNeeded()
          await checkSingleLine(control)
          const card = control.locator('xpath=../..')
          assert.ok(await card.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Provider label must fit the model card')
        }
        assert.ok(await page.locator('form aside').evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Model summary must fit its column')
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Long model labels must not widen the window')
        await page.screenshot({ path: resolve(directory, `${prefix}-models-${theme}-${width}.png`), fullPage: true })
        if (theme === 'light' && width === 1440) await controls[0].locator('xpath=../../..').screenshot({ path: resolve(directory, `${prefix}-model-cards.png`) })
      }
    }
    await resize({ width: 1440, height: 960 })
    await controls[0].hover()
    await expect(page.getByRole('tooltip').filter({ hasText: labelFor(modelOptions[0]) })).toBeVisible()
    await page.mouse.move(1, 1)
    await page.getByRole('button', { name: /将准备模型应用到全部阶段|Apply preparation model to all phases/ }).focus()
    await page.keyboard.press('Shift+Tab')
    await expect(controls[2]).toBeFocused()
    const tooltip = page.getByRole('tooltip').filter({ hasText: labelFor(modelOptions[2]) })
    await expect(tooltip).toBeVisible()
    await expect.poll(() => tooltip.evaluate(element => getComputedStyle(element).opacity)).toBe('1')
    assert.ok(await tooltip.evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element)
      const text = range.getBoundingClientRect(); const box = element.getBoundingClientRect()
      return box.left >= 0 && box.right <= innerWidth && text.left >= box.left && text.right <= box.right
        && text.top >= box.top && text.bottom <= box.bottom
    }), 'The complete model tooltip must fit its container and the viewport')
    await page.screenshot({ path: resolve(directory, `${prefix}-models-tooltip.png`), fullPage: true })
    await page.getByRole('button', { name: /Aspera 模型设置|Aspera model settings/ }).first().click()
    const dialog = page.getByRole('dialog')
    await expect(dialog).toContainText(modelOptions[2].name)
    await expect(dialog.getByRole('status')).toHaveCount(0)
    assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'Long settings rows must fit the dialog')
    await page.screenshot({ path: resolve(directory, `${prefix}-models-settings.png`), fullPage: true })
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: /^(实验|Experiments)$/ }).click()
  } finally {
    await page.unrouteAll({ behavior: 'wait' })
    await resize({ width: original.width, height: original.height })
    await page.evaluate(dark => { if (dark) document.body.dataset.dsDarkTheme = ''; else delete document.body.dataset.dsDarkTheme }, original.dark)
  }
  await page.reload()
  await page.getByRole('button', { name: /^(实验|Experiments)$/, exact: true }).click()
  await page.getByRole('heading', { name: /^(实验|Experiments)$/, exact: true }).waitFor()
  console.log('Model selectors: single-line labels, full menus/tooltips, provider status, settings and summary fit light/dark wide/narrow windows.')
}

/**
 * Check icon replacement, keyboard activation, gear independence and rail behavior.
 * @param page - actual DSH page with its wide sidebar initially open.
 * @param directory - screenshot directory.
 * @param prefix - Web or packaged desktop artifact prefix.
 * @returns after the original expanded group has been restored.
 */
export async function checkAsperaDisclosure(page, directory, prefix, activateWindow) {
  const group = page.getByRole('button', { name: 'Aspera', exact: true })
  const icons = () => group.locator('svg').evaluateAll(elements => elements.map(element => Number(getComputedStyle(element).opacity)))
  await page.getByRole('heading', { name: /^(实验|Experiments)$/, exact: true }).click()
  await expect.poll(icons).toEqual([1, 0])
  const label = group.getByText('Aspera', { exact: true })
  const original = await label.boundingBox()
  await group.hover()
  await expect.poll(icons).toEqual([0, 1])
  assert.deepEqual(await label.boundingBox(), original, 'Replacing the icon must not move the title')
  const dark = await page.evaluate(() => 'dsDarkTheme' in document.body.dataset)
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  await expect.poll(icons).toEqual([0, 1])
  await page.screenshot({ path: resolve(directory, `${prefix}-sidebar-dark-hover.png`), fullPage: true })
  await page.evaluate(wasDark => { if (!wasDark) delete document.body.dataset.dsDarkTheme }, dark)
  await group.click()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => group.locator('svg').nth(1).evaluate(element => getComputedStyle(element).transform)).toBe('none')
  await group.locator('xpath=../..').screenshot({ path: resolve(directory, `${prefix}-sidebar-collapsed.png`) })
  await page.mouse.move(1, 1)
  await expect.poll(icons).toEqual([1, 0])
  await page.reload()
  await expect(group).toHaveAttribute('aria-expanded', 'false')
  await activateWindow?.()
  await page.bringToFront()
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
  await page.keyboard.press('Tab')
  await group.focus()
  console.log('Sidebar keyboard state:', await group.evaluate(element => ({ active: element === document.activeElement,
    focus: element.matches(':focus'), focusVisible: element.matches(':focus-visible'), documentFocus: document.hasFocus(),
    activeTag: document.activeElement?.tagName, activeLabel: document.activeElement?.getAttribute('aria-label') })))
  await expect.poll(icons).toEqual([0, 1])
  await page.keyboard.press('Enter')
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await expect.poll(() => group.locator('svg').nth(1).evaluate(element => getComputedStyle(element).transform)).toBe('matrix(0, 1, -1, 0, 0, 0)')
  await group.locator('xpath=../..').screenshot({ path: resolve(directory, `${prefix}-sidebar-expanded.png`) })
  await page.getByRole('button', { name: /Aspera 模型设置|Aspera model settings/ }).click()
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^(收起侧边栏|Collapse sidebar)$/ }).click()
  const hidesSidebar = await page.evaluate(() => document.documentElement.hasAttribute('data-windows-titlebar')
    || document.documentElement.dataset.platform === 'darwin')
  if (hidesSidebar) {
    await expect(group).not.toBeInViewport()
    await page.getByRole('button', { name: /^(打开侧边栏|Open sidebar)$/ }).click()
  } else {
    await group.hover()
    await expect.poll(icons).toEqual([1, 0])
    await group.click()
  }
  await expect(page.getByRole('button', { name: /^(服务器|Servers)$/ })).toBeVisible()
  await expect(group).toHaveAttribute('aria-expanded', 'true')
  console.log('Aspera sidebar: idle icon, hover/focus triangles, fixed label position, persisted disclosure, independent gear and official icon rail passed.')
}
