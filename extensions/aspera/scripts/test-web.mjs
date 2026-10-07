/** Exercise the real Web composition against the explicitly local CPU test provider. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { chromium, expect as baseExpect } from '@playwright/test'
import { command, launchProfile, openAspera, removeTestDirectory } from './test-app.mjs'
import { checkModelPickerLayout, checkAsperaDisclosure } from './test-ui-layout.mjs'
import { checkServerManagement, checkExperimentManagement } from './test-management-ui.mjs'
import { checkStageLayout, checkOverviewPhase } from './test-stage-layout.mjs'
import { checkExecutionOverview } from './test-overview.mjs'

import { fixtureOptions, fixtureProvider } from './fixtures/models.mjs'

const root = resolve(import.meta.dirname, '..')
const expect = baseExpect.configure({ timeout: 40000 })
// Fresh published DSH profiles have measured 128 s cold starts on Windows; readiness still requires the profile's own signal.
const profileStartupMs = 180000
mkdirSync(resolve(root, '.artifacts'), { recursive: true })
const directory = mkdtempSync(resolve(root, '.artifacts/web-test-'))
const home = resolve(directory, 'home')
const portReservation = createServer()
await new Promise((ready, reject) => { portReservation.once('error', reject); portReservation.listen(0, '127.0.0.1', ready) })
const mappedPort = portReservation.address().port
const portLease = resolve(directory, 'mapped-port-lease')
const leaseWatcher = setInterval(() => {
  if (!existsSync(portLease)) return
  clearInterval(leaseWatcher)
  portReservation.close(() => { writeFileSync(portLease + '.released', '') })
}, 50)
const externalUrl = `http://127.0.0.1:${mappedPort}`
await command(process.execPath, ['scripts/setup.mjs'], root, { ASPERA_HOME: home })
const profile = resolve(home, 'profiles/aspera')
writeFileSync(resolve(profile, 'cordis.patch.yml'), JSON.stringify([
  { id: 'hmr', disabled: true },
  { id: 'client-hmr', disabled: true },
  { id: 'aspera-dispatch', disabled: true },
  { id: 'aspera-console', config: { pollIntervalMs: 500 } },
  { id: 'llm-pi-ai', config: { providers: { [fixtureProvider]: fixtureOptions } } },
  { id: 'agent-default-model', config: { provider: fixtureProvider, model: 'qwen-preparation' } },
  { insert: [{ id: 'aspera-test-fixture', name: pathToFileURL(resolve(root, 'scripts/fixtures/web.mjs')).href,
    config: { role: 'web', root: resolve(directory, 'remote'), release: root, profileStartupMs, portLease } }] },
]))
let app; let browser; let page; let verified = false
try {
  app = await launchProfile(root, home, 'aspera', {}, profileStartupMs)
  browser = await chromium.launch({ ...(process.env.ASPERA_BROWSER_EXECUTABLE ? { executablePath: process.env.ASPERA_BROWSER_EXECUTABLE } : { channel: process.env.ASPERA_BROWSER_CHANNEL || 'chrome' }), headless: true })
  const context = await browser.newContext({ acceptDownloads: true })
  const errors = []
  context.on('page', opened => {
    opened.on('pageerror', error => { errors.push(error.message); console.error('Browser exception:', error.message) })
    opened.on('console', message => { if (message.type() === 'error') console.error('Browser:', message.text()) })
  })
  page = await context.newPage()
  await openAspera(page, app.url)
  await checkModelPickerLayout(page, resolve(root, '.artifacts'), 'web')
  await checkAsperaDisclosure(page, resolve(root, '.artifacts'), 'web')
  const group = () => page.getByRole('button', { name: 'Aspera', exact: true })
  await group().click()
  await expect(page.getByRole('button', { name: /^(服务器|Servers)$/ })).toHaveCount(0)
  await page.reload()
  await expect(group()).toHaveAttribute('aria-expanded', 'false')
  await group().click()
  await page.getByRole('button', { name: /Aspera 模型设置|Aspera model settings/ }).click()
  await expect(page.getByRole('dialog')).toContainText(/Aspera 模型设置|Aspera model settings/)
  await page.getByRole('button', { name: /管理模型 API|Manage model APIs/ }).click()
  await expect(page.getByRole('dialog')).toContainText(/模型|Models/)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click()
  await expect(page.getByRole('button', { name: /添加插件|Add plugin/ })).toBeEnabled()
  await page.getByText(/^(新会话|New session)$/).first().click()
  await expect(page.getByRole('heading', { name: /^(实验|Experiments)$/ })).toHaveCount(0)
  await page.getByRole('button', { name: /^(实验|Experiments)$/ }).click()
  await page.getByRole('button', { name: /^(服务器|Servers)$/ }).click()
  for (const name of ['Retired coordinator', 'CPU A', 'CPU B']) {
    await page.getByRole('button', { name: /^(添加服务器|Add server)$/ }).click()
    await page.locator('input[name=name]').fill(name)
    await page.locator('input[name=host]').fill(name === 'CPU A' ? 'cpu-a.test' : name === 'CPU B' ? 'cpu-b.test' : 'retired.test')
    await page.locator('input[name=username]').fill('trainer')
    await page.getByRole('dialog').getByLabel(/^(服务器密码|Server password)$/).fill('test-fixture-password')
    await expect(page.locator('input[name=remoteRoot]')).toHaveCount(0)
    if (name === 'CPU A') await page.screenshot({ path: resolve(root, '.artifacts/web-server-basic.png'), fullPage: true })
    if (name === 'CPU A') {
      await page.getByText(/推理服务对外访问（可选）|External inference access \(optional\)/, { exact: true }).click()
      await page.locator('input[name=inferenceUrl]').fill(externalUrl)
      await page.locator('input[name=inferencePort]').fill(String(mappedPort))
      await page.locator('summary').filter({ hasText: /高级设置|Advanced settings/ }).click()
      const dialogBounds = await page.getByRole('dialog').evaluate(element => {
        const bounds = element.getBoundingClientRect()
        return { top: bounds.top, bottom: bounds.bottom, viewport: innerHeight }
      })
      assert.ok(dialogBounds.top >= 0 && dialogBounds.bottom <= dialogBounds.viewport, 'Expanded server settings must fit the browser window')
      const save = page.getByRole('button', { name: /^(保存服务器|Save server)$/ })
      await save.scrollIntoViewIfNeeded()
      await expect(save).toBeInViewport()
      await page.screenshot({ path: resolve(root, '.artifacts/web-server-inference.png'), fullPage: true })
    }
    await page.getByRole('button', { name: /^(保存服务器|Save server)$/ }).click()
    await expect(page.getByRole('heading', { name: new RegExp(name) })).toBeVisible()
  }
  const retired = page.locator('article').filter({ has: page.getByRole('heading', { name: 'Retired coordinator', exact: true }) })
  await expect(retired.getByRole('button', { name: /^(删除服务器|Delete server)$/ })).toBeEnabled()
  await retired.getByRole('button', { name: /^(删除服务器|Delete server)$/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: /^(删除服务器|Delete server)$/ }).click()
  await expect(page.getByRole('heading', { name: 'Retired coordinator', exact: true })).toHaveCount(0)
  const coordinator = page.locator('article').filter({ has: page.getByRole('heading', { name: 'CPU A', exact: true }) })
  await expect(coordinator.getByText(/^(调度主机|Coordinator)$/)).toHaveCount(0)
  const serverRegistration = { removedUnusedCoordinator: true, perExperimentCoordinator: true, connectionBusy: false, linkedCoordinatorDeletionAvailable: false }
  async function create(goal, server, mode = 'automatic', upload = false, preparationFails = false, installationPending = false) {
    await page.getByRole('button', { name: /^(实验|Experiments)$/ }).click()
    await page.getByRole('button', { name: /^(新建实验|New experiment)$/ }).click()
    await page.getByLabel(/^(实验名称|Experiment name)$/).fill(goal)
    await page.getByLabel('Goal', { exact: true }).fill(goal)
    await expect(page.getByRole('button', { name: /^(准备模型|Preparation model)$/ })).toContainText('CPU Qwen preparation')
    await page.getByRole('button', { name: /^(计划模型|Planning model)$/ }).click()
    await page.getByRole('menuitem', { name: /CPU Qwen planning/ }).click()
    await page.getByRole('button', { name: /^(执行模型|Execution model)$/ }).click()
    await page.getByRole('menuitem', { name: /CPU Qwen execution/ }).click()
    for (const selected of Array.isArray(server) ? server : [server]) await page.getByRole('checkbox', { name: new RegExp(selected) }).check()
    if (mode === 'semi') await page.getByRole('button', { name: /半自动执行|Semi-automatic/ }).click()
    if (upload) await page.locator('input[name=uploads]').setInputFiles({ name: 'data.txt', mimeType: 'text/plain', buffer: Buffer.from('dataset') })
    await page.getByRole('button', { name: /^(提交实验|Submit experiment)$/ }).click()
    await expect(page.getByRole('heading', { name: goal, exact: true })).toBeVisible()
    if (installationPending) await expect(page.getByRole('region', { name: /^(运行环境安装|Release installation)$/ })).toBeVisible()
    else if (preparationFails) await expect(page.getByRole('heading', { name: /^(准备未完成|Preparation could not finish)$/ })).toBeVisible()
    else await expect(page.getByText('本机派发完成，远端实验已接管', { exact: true })).toBeVisible()
  }
  const control = async (action = 'status', id) => {
    // Fixture mutations use fresh connections across the browser's offline transition.
    const response = await page.request.get(new URL(`/aspera-test/${action}${id === undefined ? '' : '?id=' + id}`, app.url).href,
      { headers: { connection: 'close' } })
    assert.equal(response.status(), 200)
    return response.json()
  }
  await control('hold-host-key')
  const checkConnection = coordinator.getByRole('button', { name: /^(检查连接|检查中…|Check connection|Checking…)$/ })
  await checkConnection.click()
  await expect(checkConnection).toHaveAttribute('aria-busy', 'true')
  await expect(checkConnection).toBeDisabled()
  serverRegistration.connectionBusy = true
  await control('release-host-key')
  await expect(page.getByText(/CPU test provider/, { exact: true }).first()).toBeVisible()
  await expect(checkConnection).toHaveAttribute('aria-busy', 'false')
  assert.deepEqual((await control()).storageCalls, [], 'Connection checks must not call a model')
  assert.deepEqual((await control()).environmentCalls, [], 'Connection checks must not configure the environment')
  await expect(page.getByText(/^(环境待准备|Environment needs preparation)$/).first()).toBeVisible()
  await page.getByText(/磁盘与网络信息|Disk and network observations/, { exact: true }).first().click()
  await page.screenshot({ path: resolve(root, '.artifacts/web-storage-inventory.png'), fullPage: true })
  const managementChecks = await checkServerManagement(page, control, resolve(root, '.artifacts'))
  await control('hold-plan')
  await create('CPU semi experiment', 'CPU A', 'semi', true)
  await expect(page.locator('header').getByRole('status')).toHaveText(/准备计划|Preparing plan/)
  const planningPipeline = await checkOverviewPhase(page, 1, true)
  await page.screenshot({ path: resolve(root, '.artifacts/web-overview-planning.png'), fullPage: true })
  await control('release-plan')
  await expect(page.getByRole('button', { name: /^(确认此计划|Confirm this plan)$/ })).toBeVisible()
  const approvalPipeline = await checkOverviewPhase(page, 1, false)
  const semi = (await control()).experiments.find(row => row.request.objective === 'CPU semi experiment')
  assert.ok(semi.preparation.environments.every(environment => environment.phase === 'environment-ready'))
  assert.equal(semi.latest.resourcesReleased, true)
  assert.equal(semi.submission.protocol, 4)
  assert.equal(semi.submission.versions.extension, '0.1.1')
  assert.deepEqual(semi.submission.nodes[0].server.inferenceMapping, { url: externalUrl, port: mappedPort })
  assert.equal(semi.preparation.placements[0].layout, 'separated')
  assert.equal(semi.preparation.placements[0].candidate.persistence, 'unknown')
  await page.screenshot({ path: resolve(root, '.artifacts/web-storage-plan.png'), fullPage: true })
  await page.getByRole('button', { name: /^(返回实验|Back to experiments)$/ }).click()
  await expect(page.getByText(/首次等待计划确认时，不占用训练服务器或 GPU|Initial plan confirmation does not reserve/)).toBeVisible()
  await page.getByRole('button', { name: /关闭本次提醒|Dismiss this reminder/ }).click()
  await page.reload(); await openAspera(page, app.url)
  await expect(page.getByRole('button', { name: /关闭本次提醒|Dismiss this reminder/ })).toHaveCount(0)
  await expect(page.getByLabel(/1 个实验待处理|1 experiments need attention/)).toBeVisible()
  await create('CPU independent experiment', 'CPU B')
  await expect(page.locator('header').getByRole('status')).toHaveText(/服务中|Serving/, { timeout: profileStartupMs })
  const executionPipeline = await checkOverviewPhase(page, 2, true)
  await page.screenshot({ path: resolve(root, '.artifacts/web-overview-execution.png'), fullPage: true })
  await page.getByRole('button', { name: /^(服务器|Servers)$/ }).click()
  await coordinator.getByRole('button', { name: /^(删除服务器|Delete server)$/ }).click()
  await expect(page.getByRole('dialog').getByRole('button', { name: /^(删除服务器|Delete server)$/ })).toBeEnabled()
  await expect(page.getByRole('dialog')).toContainText('CPU semi experiment')
  await page.keyboard.press('Escape')
  serverRegistration.linkedCoordinatorDeletionAvailable = true
  await page.screenshot({ path: resolve(root, '.artifacts/web-server-removal-linked.png'), fullPage: true })
  await page.getByRole('button', { name: /^(实验|Experiments)$/ }).click()
  await page.getByRole('button').filter({ has: page.getByText('CPU independent experiment', { exact: true }) }).click()
  await page.getByRole('button', { name: /^(返回实验|Back to experiments)$/ }).click()
  await page.getByRole('button').filter({ has: page.getByText('CPU semi experiment', { exact: true }) }).click()
  await page.getByRole('button', { name: /^(确认此计划|Confirm this plan)$/ }).click()
  await expect(page.locator('header').getByRole('status')).toHaveText(/服务中|Serving/, { timeout: profileStartupMs })
  await create('CPU shared experiment', 'CPU A')
  await expect(page.locator('header').getByRole('status')).toHaveText(/排队中|Queued/)
  const queuedPipeline = await checkOverviewPhase(page, 2, false)
  await expect(page.getByText(/等待服务器|Waiting for servers/)).toBeVisible()
  const saved = await control()
  const first = saved.experiments.find(row => row.request.objective === 'CPU semi experiment')
  const separate = saved.experiments.find(row => row.request.objective === 'CPU independent experiment')
  assert.equal(first.latest.state, 'serving')
  assert.equal(separate.latest.state, 'serving')
  assert.notEqual(first.latest.sessionId, separate.latest.sessionId)
  assert.equal(JSON.stringify(saved.experiments).includes('test-fixture-password'), false)
  await page.getByRole('button', { name: /^(返回实验|Back to experiments)$/ }).click()
  await page.getByRole('button').filter({ has: page.getByText('CPU semi experiment', { exact: true }) }).click()
  await page.getByRole('button', { name: /^(运行监控|Runtime monitor)$/ }).click()
  const log = () => page.getByRole('region', { name: /^(进程日志|Process logs)$/ })
  await expect(log()).toContainText('服务健康')
  await context.setOffline(true)
  await control('append', first.request.experimentId)
  await context.setOffline(false)
  await expect(log()).toContainText('断线后继续')
  await control('rotate', first.request.experimentId)
  await expect(page.getByText(/日志已轮转|log was rotated/)).toBeVisible()
  await expect(log()).toContainText('轮转后日志')
  await page.getByRole('button', { name: /^(Agent 记录|Agent records)$/ }).click()
  await page.getByRole('button', { name: /^(计划|Planning)$/ }).click()
  await expect(page.getByRole('button', { name: /^(对话|Conversation)$/ })).toHaveCount(0)
  await expect(page.getByText('Prepare a CPU fixture service in the experiment directory.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^(执行|Execution)$/ }).click()
  await expect(page.getByText('Run the approved CPU fixture plan.', { exact: true })).toBeVisible()
  await page.locator('[data-record-index]').filter({ hasText: 'run_experiment_command' }).click()
  await page.screenshot({ path: resolve(root, '.artifacts/web-agent-trace.png'), fullPage: true })
  await page.locator('#trajectory-detail-input:visible').click()
  const inspector = page.locator('#trajectory-detail-panel:visible')
  assert.ok((await inspector.boundingBox()).height >= 230, 'The event inspector must retain readable height')
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  await page.screenshot({ path: resolve(root, '.artifacts/web-agent-trace-dark.png'), fullPage: true })
  await page.setViewportSize({ width: 1000, height: 760 })
  await expect(inspector).toBeInViewport()
  await page.screenshot({ path: resolve(root, '.artifacts/web-agent-trace-narrow.png'), fullPage: true })
  await page.evaluate(() => { delete document.body.dataset.dsDarkTheme })
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.getByRole('tab', { name: /^(概述|概览|Overview|Summary)$/ }).click()
  await page.getByRole('button', { name: /查看日志|View logs/ }).click()
  await expect(page.getByRole('region', { name: /运行监控|Runtime monitor/ })).toBeVisible()
  const processOutput = log()
  await expect(processOutput).toContainText('CPU fixture service ready')
  await expect(page.getByRole('button', { name: /^(暂停跟随|Pause follow)$/ })).toHaveCount(0)
  await page.getByRole('button', { name: /^(节点日志|Node logs)$/ }).click()
  await page.getByRole('menuitem', { name: 'stderr', exact: true }).click()
  await expect(processOutput).toContainText('CPU fixture diagnostic stream')
  await expect(processOutput).not.toContainText('CPU fixture service ready')
  await page.screenshot({ path: resolve(root, '.artifacts/web-process-log.png'), fullPage: true })
  await page.getByRole('button', { name: /^(输出文件|Output files)$/ }).click()
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: /^(下载|Download)$/ }).click()
  const downloaded = await downloadEvent
  assert.equal(readFileSync(await downloaded.path(), 'utf8'), 'local output\n')
  await page.getByRole('button', { name: /^(推理服务|Inference services)$/ }).last().click()
  await expect(page.getByText(/外部地址已验证|External address verified/, { exact: true })).toBeVisible()
  assert.equal((await page.request.get(externalUrl)).status(), 401)
  await page.getByRole('button', { name: /查看调用信息与密钥|Show calling information and key/ }).click()
  const keyExample = page.locator('pre').filter({ hasText: 'Authorization: Bearer' })
  await expect(keyExample).toBeVisible()
  const serviceKey = (await keyExample.innerText()).match(/Bearer ([a-f0-9]{64})/)[1]
  assert.equal(JSON.stringify(await control()).includes(serviceKey), false)
  assert.equal((await page.request.get(externalUrl, { headers: { authorization: 'Bearer ' + serviceKey } })).status(), 200)
  await page.getByRole('button', { name: /隐藏调用信息|Hide calling information/ }).click()
  await page.getByRole('button', { name: /^(通过受管理的连接访问|Access through managed connection)$/ }).click()
  await expect(page.locator('pre').last()).toContainText('CPU fixture response')
  await page.screenshot({ path: resolve(root, '.artifacts/web-service.png'), fullPage: true })
  await page.close()
  page = await context.newPage()
  await openAspera(page, app.url)
  await page.getByRole('button').filter({ has: page.getByText('CPU semi experiment', { exact: true }) }).click()
  await expect(page.locator('header').getByRole('status')).toHaveText(/服务中|Serving/, { timeout: profileStartupMs })
  await page.getByRole('button', { name: /^(推理服务|Inference services)$/ }).last().click()
  await page.getByRole('button', { name: /^(停止服务|Stop service)$/ }).click()
  await expect(page.locator('header').getByRole('status')).toHaveText(/已完成|Completed/)
  await expect(page.getByText(/外部访问已停止|External access stopped/, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /^(返回实验|Back to experiments)$/ }).click()
  await page.getByRole('button').filter({ has: page.getByText('CPU shared experiment', { exact: true }) }).click()
  await expect(page.locator('header').getByRole('status')).toHaveText(/服务中|Serving/, { timeout: profileStartupMs })
  await page.getByRole('button', { name: /^(取消实验|Cancel experiment)$/ }).click()
  await expect(page.locator('header').getByRole('status')).toHaveText(/已取消|Cancelled/)
  await page.getByRole('button', { name: /^(返回实验|Back to experiments)$/ }).click()
  await page.getByRole('button').filter({ has: page.getByText('CPU independent experiment', { exact: true }) }).click()
  await control('crash', separate.request.experimentId)
  await expect(page.locator('header').getByRole('status')).toHaveText(/失败|Failed/)
  await page.getByRole('button', { name: /^(推理服务|Inference services)$/ }).last().click()
  await expect(page.getByText('CPU fixture exited unexpectedly', { exact: true })).toBeVisible()
  const crashed = (await control()).experiments.find(row => row.request.experimentId === separate.request.experimentId)
  assert.equal(crashed.latest.services.length, 1)
  assert.equal(crashed.latest.services[0].state, 'failed')
  assert.equal(crashed.latest.services[0].released, true)
  await create('CPU failure experiment', 'CPU A')
  await expect(page.getByRole('region', { name: /^(当前阶段|Current stage)$/ })).toContainText('CPU fixture dependency failed')
  const remoteFailureStage = await checkStageLayout(page, resolve(root, '.artifacts'), false)
  await page.screenshot({ path: resolve(root, '.artifacts/web-error.png'), fullPage: true })
  await create('CPU preparation recovery', 'CPU A', 'automatic', false, true)
  const preparationFailureStage = await checkStageLayout(page, resolve(root, '.artifacts'), true)
  const beforeRetry = (await control()).experiments.find(row => row.request.objective === 'CPU preparation recovery')
  await control('restore-release', beforeRetry.request.experimentId)
  await control('hold-retry')
  await page.getByRole('region', { name: /^(当前阶段|Current stage)$/ }).getByRole('button', { name: /^(重试准备|Retry preparation)$/ }).click()
  const retryPipeline = await checkOverviewPhase(page, 0, true)
  await expect(page.getByRole('button', { name: /^(正在重试…|Retrying…)$/ })).toBeDisabled()
  await page.screenshot({ path: resolve(root, '.artifacts/web-overview-retrying.png'), fullPage: true })
  await page.getByRole('button', { name: /^(返回实验|Back to experiments)$/ }).click()
  await page.getByRole('button', { name: 'CPU preparation recovery', exact: true }).click()
  await expect(page.getByRole('button', { name: /^(正在重试…|Retrying…)$/ })).toBeDisabled()
  await control('release-retry')
  await expect(page.getByText('本机派发完成，远端实验已接管', { exact: true })).toBeVisible()
  await expect(page.locator('header').getByRole('status')).toHaveText(/服务中|Serving/, { timeout: profileStartupMs })
  const afterRetry = (await control()).experiments.find(row => row.request.experimentId === beforeRetry.request.experimentId)
  assert.equal(afterRetry.sessionId, beforeRetry.sessionId)
  assert.deepEqual(afterRetry.preparation.placements, beforeRetry.preparation.placements)
  await expect(page.getByRole('button', { name: /^(重试准备|Retry preparation)$/ })).toHaveCount(0)
  await page.getByRole('button', { name: /^(取消实验|Cancel experiment)$/ }).click()
  await expect(page.locator('header').getByRole('status')).toHaveText(/已取消|Cancelled/)
  await create('CPU completed experiment', 'CPU A')
  await expect(page.locator('header').getByRole('status')).toHaveText(/已完成|Completed/)
  const completedPipeline = await checkOverviewPhase(page, 3, false)
  await page.screenshot({ path: resolve(root, '.artifacts/web-overview-completed.png'), fullPage: true })
  await page.getByRole('button', { name: /^(查看输出文件|View output files)$/ }).click()
  await expect(page.getByText('result.txt', { exact: true })).toBeVisible()
  await create('CPU operator question', 'CPU A', 'semi')
  await page.getByRole('button', { name: /^(确认此计划|Confirm this plan)$/ }).click()
  const questionCard = () => page.getByRole('region', { name: /需要你的决定|Your decision is needed/ })
  await expect(questionCard()).toBeVisible()
  const questionPipeline = await checkOverviewPhase(page, 2, false)
  await expect(page.getByLabel(/1 个实验待处理|1 experiments need attention/)).toBeVisible()
  const waiting = (await control()).experiments.find(row => row.request.objective === 'CPU operator question')
  await page.screenshot({ path: resolve(root, '.artifacts/web-question.png'), fullPage: true })
  await page.close(); page = await context.newPage()
  await openAspera(page, app.url)
  await page.locator('header').getByRole('button', { name: /待处理|Needs attention/ }).click()
  await expect(page.locator('tbody tr[data-experiment-id]')).toHaveCount(1)
  await page.getByRole('button', { name: 'CPU operator question', exact: true }).click()
  await expect(questionCard()).toBeVisible()
  await expect(page.getByLabel(/1 个实验待处理|1 experiments need attention/)).toBeVisible()
  await questionCard().getByRole('checkbox', { name: 'Use the held-out split' }).check()
  await questionCard().getByRole('textbox').fill('Keep the specified data and server group.')
  await questionCard().getByRole('button', { name: /回复并继续|Save reply and continue/ }).click()
  await expect(questionCard()).toHaveCount(0)
  await expect(page.getByLabel(/1 个实验待处理|1 experiments need attention/)).toHaveCount(0)
  await expect(page.locator('header').getByRole('status')).toHaveText(/服务中|Serving/, { timeout: profileStartupMs })
  const answered = (await control()).experiments.find(row => row.request.experimentId === waiting.request.experimentId)
  assert.equal(answered.latest.sessionId, waiting.latest.sessionId)
  assert.equal(answered.latest.goalId, waiting.latest.goalId)
  assert.equal(answered.latest.questions[0].state, 'answered')
  await page.getByRole('button', { name: /^(取消实验|Cancel experiment)$/ }).click()
  await expect(page.locator('header').getByRole('status')).toHaveText(/已取消|Cancelled/)
  await control('hold-installation')
  await create('CPU installation recovery', 'CPU A', 'automatic', false, false, true)
  const recoveryRegion = page.getByRole('region', { name: /^(运行环境安装|Release installation)$/ })
  const sourceToast = page.getByText(/准备 Agent 已切换下载源|Preparation Agent changed the download source/)
  await expect(sourceToast).toBeVisible()
  await expect(recoveryRegion).toContainText('https://cpu-mirror.example.test/npm/')
  const recoveryBefore = (await control()).installations.find(value => value.round.changes.some(change => change.applied))
  assert.equal(recoveryBefore.round.attempts.length, 2)
  assert.equal(recoveryBefore.policy.installationMaxRetries, 2)
  const beforeToastClose = await page.getByRole('heading', { name: 'CPU installation recovery', exact: true }).boundingBox()
  await page.screenshot({ path: resolve(root, '.artifacts/web-installation-source-toast.png'), fullPage: true })
  await page.getByRole('button', { name: '×', exact: true }).click()
  assert.deepEqual(await page.getByRole('heading', { name: 'CPU installation recovery', exact: true }).boundingBox(), beforeToastClose)
  await page.screenshot({ path: resolve(root, '.artifacts/web-installation-recovery-light.png'), fullPage: true })
  await page.reload(); await openAspera(page, app.url)
  await page.getByRole('button', { name: 'CPU installation recovery', exact: true }).click()
  await expect(sourceToast).toHaveCount(0)
  await page.setViewportSize({ width: 820, height: 740 })
  await page.screenshot({ path: resolve(root, '.artifacts/web-installation-recovery-small.png'), fullPage: true })
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  await page.screenshot({ path: resolve(root, '.artifacts/web-installation-recovery-dark.png'), fullPage: true })
  await page.evaluate(() => { delete document.body.dataset.dsDarkTheme })
  await page.setViewportSize({ width: 1440, height: 900 })
  await control('release-installation')
  await expect(page.locator('header').getByRole('status')).toHaveText(/已完成|Completed/)
  const recovered = (await control()).experiments.find(row => row.request.objective === 'CPU installation recovery')
  const installationRecovery = { attempts: recoveryBefore.round.attempts.length, fixedDeadline: recoveryBefore.round.attempts.every(attempt => attempt.status.deadline === recoveryBefore.round.deadline),
    sources: recoveryBefore.round.sources, toastOnce: true, completed: recovered.latest.state === 'completed',
    tools: (await control()).environmentCalls.filter(call => call.experimentId === recovered.request.experimentId).map(call => call.name) }
  const final = await control()
  const dispatchEvents = final.events.filter(item => item.sessionId === first.sessionId)
  const overview = await checkExecutionOverview(page, control, create, browser, app.url, resolve(root, '.artifacts'))
  const managementDeletion = await checkExperimentManagement(page, control, resolve(root, '.artifacts'))
  const snapshot = {
    managementChecks, managementDeletion, serverRegistration, installationRecovery, executionOverview: overview.facts,
    overviewPhases: { planning: planningPipeline, approval: approvalPipeline, execution: executionPipeline, queued: queuedPipeline, retry: retryPipeline, completed: completedPipeline, question: questionPipeline },
    stageCards: { preparation: preparationFailureStage, remote: remoteFailureStage, retryRetainsSession: afterRetry.sessionId === beforeRetry.sessionId,
      recoveryHandover: final.events.filter(item => item.sessionId === afterRetry.sessionId && item.event.type === 'user/message'
        && item.event.data.content[0].text.startsWith('本机派发完成')).map(item => item.event.data.content[0].text.split('\n')[0]) },
    environmentTools: final.environmentCalls.filter(item => item.experimentId === semi.request.experimentId).map(item => item.name),
    environmentCommands: final.preparationCommands.filter(item => item.host === semi.coordinator.host).map(({ exitCode, stdout, stderr }) => ({ exitCode, stdout, stderr })),
    agentModels: Object.fromEntries(Object.entries(first.models).map(([phase, model]) => [phase, { provider: model.provider, model: model.model }])),
    dispatchGoalPhases: dispatchEvents.filter(item => item.event.type === 'goal/change').map(item => item.event.data.goal?.phase),
    handover: dispatchEvents.filter(item => item.event.type === 'user/message' && item.event.data.content[0].text.startsWith('本机派发完成')).map(item => item.event.data.content[0].text.split('\n')[0]),
    storageTools: final.storageCalls.filter(item => item.experimentId === first.request.experimentId).map(item => item.name),
    storage: first.preparation.placements.map(item => ({ layout: item.layout, systemVolume: item.candidate.systemVolume, persistence: item.candidate.persistence })),
    inference: { mapped: first.submission.nodes[0].server.inferenceMapping !== undefined,
      external: first.latest.services[0].external.state, modelName: first.latest.services[0].modelName,
      stopped: final.experiments.find(row => row.request.experimentId === first.request.experimentId).latest.services[0].external.state },
    receiptStates: final.experiments.filter(row => ['CPU semi experiment', 'CPU shared experiment', 'CPU failure experiment'].includes(row.request.objective))
      .sort((a, b) => a.request.objective.localeCompare(b.request.objective)).map(row => ({ goal: row.request.objective, handover: row.receipt.handover, state: row.latest.state })),
  }
  const snapshotFile = resolve(root, 'scripts/fixtures/session.snapshot.json')
  if (process.argv.includes('--record')) writeFileSync(snapshotFile, JSON.stringify(snapshot, null, 2) + '\n')
  const expected = JSON.parse(readFileSync(snapshotFile, 'utf8'))
  assert.deepEqual(snapshot, expected)
  assert.deepEqual(errors, [])
  verified = true
  if (process.argv.includes('--keep-preview')) {
    await page.getByRole('button', { name: /^(实验|Experiments)$/ }).click()
    await page.getByRole('textbox', { name: /^(搜索实验|Search experiments)$/ }).fill('CPU overview review')
    await page.getByRole('button', { name: 'CPU overview review', exact: true }).click()
    writeFileSync(resolve(root, '.artifacts/overview-preview.json'), JSON.stringify({ url: app.url, directory, experimentId: overview.id, source: 'Production profile with CPU test data' }, null, 2) + '\n')
    console.log('Production overview preview is running; its local entry is saved in .artifacts/overview-preview.json.')
  }
  console.log('Real Web: servers/passwords, attachments, independent Goals, plan confirmation, parallelism/queue, handover Session snapshot, UTF-8/reconnect/rotation, download, service access/survival/stop/unexpected exit, cancellation and errors passed.')
} catch (error) {
  if (page !== undefined && !page.isClosed()) {
    await page.screenshot({ path: resolve(root, '.artifacts/web-failure.png'), fullPage: true })
    console.error((await page.locator('body').innerText()).slice(-5000))
    console.error((await page.locator('details').allTextContents()).map(value => value.slice(0, 1000)))
  }
  console.error('Web test profile tail: ' + (app?.output() ?? '').replace(/token=[A-Za-z0-9_-]+/g, 'token=<redacted>').slice(-7000))
  throw error
} finally {
  clearInterval(leaseWatcher)
  if (portReservation.listening) await new Promise(done => { portReservation.close(done) })
  await browser?.close()
  if (!verified || !process.argv.includes('--keep-preview')) {
    await app?.close()
    removeTestDirectory(directory, resolve(root, '.artifacts'))
  } else {
    const stopPreview = async () => { await app.close(); removeTestDirectory(directory, resolve(root, '.artifacts')); process.exit(0) }
    process.once('SIGINT', stopPreview); process.once('SIGTERM', stopPreview)
  }
}
