/** Production Host, standard restricted Agent, Remote and Web review flow without credentials or GPUs. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium, expect as baseExpect } from '@playwright/test'
import { command, launchProfile, openAspera, removeTestDirectory } from './test-app.mjs'
import { fixtureOptions, fixtureProvider, fixtureSelections } from './fixtures/models.mjs'

const root = resolve(import.meta.dirname, '..'), artifacts = resolve(root, '.artifacts')
mkdirSync(artifacts, { recursive: true })
const directory = mkdtempSync(resolve(artifacts, 'completion-profile-')), home = resolve(directory, 'home')
const expect = baseExpect.configure({ timeout: 40000 })
let app, browser
try {
  await command(process.execPath, ['scripts/setup.mjs'], root, { ASPERA_HOME: home })
  writeFileSync(resolve(home, 'profiles/aspera/cordis.patch.yml'), JSON.stringify([
    { id: 'hmr', disabled: true }, { id: 'client-hmr', disabled: true }, { id: 'aspera-dispatch', disabled: true },
    { id: 'llm-pi-ai', config: { providers: { [fixtureProvider]: fixtureOptions } } },
    { id: 'agent-default-model', config: { provider: fixtureProvider, model: 'qwen-preparation' } },
    { insert: [{ id: 'completion-fixture', name: pathToFileURL(resolve(root, 'scripts/fixtures/web.mjs')).href,
      config: { role: 'web', root: resolve(directory, 'remote'), release: root, home, profileStartupMs: 180000 } }] },
  ]))
  app = await launchProfile(root, home, 'aspera', { DEEPSEEK_API_KEY: '' }, 180000)
  const exchange = await fetch(app.url, { redirect: 'manual' }), cookie = exchange.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie)
  const base = new URL(app.url).origin
  const control = async (kind = 'status', id = '') => {
    const response = await fetch(`${base}/aspera-test/${kind}?id=${id}`, { headers: { cookie }, signal: AbortSignal.timeout(30000) })
    const result = await response.json(); assert.equal(response.status, 200, JSON.stringify(result)); return result
  }
  const rpc = async (operation, args) => {
    const method = 'aspera/' + operation
    const response = await fetch(`${base}/api/${method}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }), signal: AbortSignal.timeout(30000) })
    const result = await response.json(); assert.equal(response.status, 200); assert.equal(result.result.ok, true, JSON.stringify(result)); return result.result.value
  }
  for (let attempt = 0; ; attempt++) {
    try { await control(); break } catch (error) { if (attempt > 100) throw error; await delay(50) }
  }
  const serverId = randomUUID(), account = { host: 'completion.fixture', username: 'trainer', sshPort: 22 }
  await rpc('setPassword', { account, password: 'cpu-only-review-password' })
  await rpc('saveServer', { server: { ...account, id: serverId, name: 'CPU review node', remotePort: 43019, authMode: 'password', storagePreference: { mode: 'auto' } } })
  const create = async (name, mode) => {
    const id = randomUUID()
    await rpc('createExperiment', { input: { experimentId: id, name, objective: 'CPU completed experiment', serverIds: [serverId], coordinatorId: serverId, mode: 'automatic', models: fixtureSelections } })
    await expect.poll(async () => (await rpc('experiments', {})).find(row => row.request.experimentId === id)?.state).toBe('submitted')
    await expect.poll(async () => (await rpc('refreshExperiment', { id })).latest?.state).toBe('completed')
    await control('completion-' + mode, id)
    return id
  }
  const id = await create('CPU evidence review', 'passed')
  const before = (await rpc('experiments', {})).find(row => row.request.experimentId === id)
  assert.equal(before.latest.state, 'failed'); assert.equal(before.latest.executions.length, 0)
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1440, height: 1100 } }), page = await context.newPage()
  await openAspera(page, app.url)
  await page.getByRole('button', { name: 'CPU evidence review', exact: true }).click()
  const review = page.getByRole('region', { name: '完成证据复验', exact: true })
  await expect(review).toContainText('原结果：失败')
  await review.getByRole('button', { name: '补录并重新验收', exact: true }).focus(); await page.keyboard.press('Enter')
  const reviewDeadline = Date.now() + 40000
  for (;;) {
    const status = await rpc('experimentCompletionReviewStatus', { id })
    if (status?.phase === 'passed') break
    if (status?.phase === 'blocked') throw new Error('Review blocked: ' + JSON.stringify(status))
    assert.ok(Date.now() < reviewDeadline, 'Review did not finish'); await delay(100)
  }
  await expect(page.locator('header').getByRole('status')).toHaveText('复验通过')
  await expect(review).toContainText('原结果：失败')
  await expect(page.getByRole('region', { name: '当前阶段', exact: true })).toHaveAttribute('aria-busy', 'false')
  await page.screenshot({ path: resolve(artifacts, 'completion-production-passed-light.png'), fullPage: true })
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  await page.screenshot({ path: resolve(artifacts, 'completion-production-passed-dark.png'), fullPage: true })
  await page.setViewportSize({ width: 520, height: 950 }); await expect(review).toBeVisible()
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Review fits the narrow window')
  await page.screenshot({ path: resolve(artifacts, 'completion-production-passed-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1100 }); await page.evaluate(() => { delete document.body.dataset.dsDarkTheme })
  const final = await rpc('experimentCompletionReviewStatus', { id })
  appendFileSync(resolve(home, 'aspera-completion-reviews', `${id}.${final.operationId}.events.jsonl`), '{"data":"broken"quote"}\n')
  const trace = await rpc('experimentCompletionReviewTrace', { id, operationId: final.operationId, request: { limit: 100 } })
  const names = trace.records.filter(event => event.type === 'tool/call').map(event => JSON.parse(event.data).name)
  assert.ok(names.includes('record_experiment_execution') && names.includes('verify_experiment_completion'))
  assert.ok(!names.some(name => /run_experiment_command|prepare_experiment_environment|start_inference_service/.test(name)))
  assert.ok(!JSON.stringify(trace).includes('private-fixture-token') && !JSON.stringify(trace).includes('private-fixture-key'))
  for (const event of trace.records) JSON.parse(event.data)
  assert.equal(final.entries[0].environment.kind, 'historical')
  const after = (await rpc('experiments', {})).find(row => row.request.experimentId === id)
  assert.deepEqual(after.latest, before.latest); assert.deepEqual(after.submission, before.submission)
  await review.getByRole('button', { name: '补录 Agent 记录', exact: true }).click()
  await expect(page.getByRole('button', { name: '补录 Agent 记录', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: resolve(artifacts, 'completion-production-review-trace.png'), fullPage: true })
  const english = await browser.newContext({ locale: 'en-US' })
  try {
    const translated = await english.newPage(); await openAspera(translated, app.url)
    await translated.getByRole('button', { name: 'CPU evidence review', exact: true }).click()
    await expect(translated.locator('header').getByRole('status')).toHaveText('Revalidation passed')
    await expect(translated.getByRole('region', { name: 'Completion evidence review', exact: true })).toContainText('Original result: failed')
  } finally { await english.close() }
  const continuationId = await create('CPU original blocked continuation', 'continuation')
  const originalContinuation = (await rpc('experiments', {})).find(row => row.request.experimentId === continuationId).latest
  assert.equal(originalContinuation.state, 'blocked')
  await rpc('reviewExperimentCompletion', { id: continuationId })
  await expect.poll(async () => {
    const value = await rpc('experimentCompletionReviewStatus', { id: continuationId })
    if (value?.phase === 'blocked') throw new Error('Continuation review blocked: ' + JSON.stringify(value))
    return value?.phase
  }).toBe('passed')
  const assessment = await rpc('experimentCompletionAssessment', { id: continuationId })
  assert.equal(assessment.stages[0].baseControl, undefined, 'The Agent must correct the invalid evidence path before acceptance')
  assert.deepEqual(assessment.verifications.map(stage => [stage.startStep, stage.additionalSteps, stage.endStep, stage.ready]), [[30, 200, 230, true]])
  assert.equal(assessment.steps[0].step, 2); assert.equal(assessment.steps[0].state, 'completed')
  assert.deepEqual((await rpc('experiments', {})).find(row => row.request.experimentId === continuationId).latest, originalContinuation)
  const continuationReview = await rpc('experimentCompletionReviewStatus', { id: continuationId })
  const continuationTrace = await rpc('experimentCompletionReviewTrace', { id: continuationId, operationId: continuationReview.operationId, request: { limit: 100 } })
  const continuationCalls = continuationTrace.records.filter(event => event.type === 'tool/call').map(event => JSON.parse(event.data).name)
  const correction = continuationTrace.records.filter(event => event.type === 'tool/call').map(event => JSON.parse(event.data))
    .find(event => event.name === 'register_experiment_stage' && Number.isInteger(JSON.parse(event.arguments).expected_revision))
  assert.ok(correction, 'The formal Agent must submit a revision-checked evidence correction')
  for (const name of ['register_experiment_stage', 'verify_experiment_stage', 'report_experiment_step']) assert.ok(continuationCalls.includes(name))
  assert.ok(!continuationCalls.some(name => /run_experiment|prepare_experiment|start_inference/.test(name)))
  await page.getByRole('button', { name: '返回实验', exact: true }).click()
  await page.getByRole('button', { name: 'CPU original blocked continuation', exact: true }).click()
  const continuationRegion = page.getByRole('region', { name: '完成证据复验', exact: true })
  await expect(continuationRegion).toContainText('原结果：受阻')
  await expect(continuationRegion).toContainText('200')
  const finalizationRegion = page.getByRole('region', { name: '程序执行核验', exact: true })
  await expect(finalizationRegion).toHaveAttribute('aria-busy', 'false')
  await expect(finalizationRegion).toContainText('Agent 上报')
  await expect(page.locator('header').getByRole('status')).toHaveText('复验通过')
  await page.screenshot({ path: resolve(artifacts, 'finalization-production-continuation-light.png'), fullPage: true })
  await page.evaluate(() => { document.body.dataset.dsDarkTheme = '' })
  await page.screenshot({ path: resolve(artifacts, 'finalization-production-continuation-dark.png'), fullPage: true })
  await page.setViewportSize({ width: 520, height: 950 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))
  await page.screenshot({ path: resolve(artifacts, 'finalization-production-continuation-narrow.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1100 }); await page.evaluate(() => { delete document.body.dataset.dsDarkTheme })
  const blockedId = await create('CPU missing artifact', 'blocked')
  await rpc('reviewExperimentCompletion', { id: blockedId })
  await expect.poll(async () => (await rpc('experimentCompletionReviewStatus', { id: blockedId }))?.phase).toBe('blocked')
  await page.getByRole('button', { name: '返回实验', exact: true }).click()
  await page.getByRole('button', { name: 'CPU missing artifact', exact: true }).click()
  await expect(page.getByRole('region', { name: '完成证据复验', exact: true }).getByRole('button', { name: '重试补录验收', exact: true })).toBeVisible()
  await page.screenshot({ path: resolve(artifacts, 'completion-production-blocked.png'), fullPage: true })
  const blockedReview = await rpc('experimentCompletionReviewStatus', { id: blockedId })
  const blockedOriginal = (await rpc('experiments', {})).find(row => row.request.experimentId === blockedId).latest
  assert.match(blockedReview.detail, /Original adapter evidence is unavailable/)
  let blockedGoal
  await expect.poll(async () => {
    const blockedTrace = await rpc('experimentCompletionReviewTrace', { id: blockedId, operationId: blockedReview.operationId, request: { limit: 100 } })
    const event = blockedTrace.records.filter(event => event.type === 'goal/change').at(-1)
    blockedGoal = event === undefined ? undefined : JSON.parse(event.data).goal
    return blockedGoal?.phase === 'blocked' && blockedTrace.records.some(row => row.type === 'turn/end' && row.seq > event.seq)
  }).toBe(true)
  await control('completion-retry', blockedId)
  await rpc('reviewExperimentCompletion', { id: blockedId })
  await expect.poll(async () => {
    const value = await rpc('experimentCompletionReviewStatus', { id: blockedId })
    if (value?.phase === 'blocked') throw new Error('Resumed review blocked: ' + JSON.stringify(value))
    return value?.phase
  }).toBe('passed')
  const resumedReview = await rpc('experimentCompletionReviewStatus', { id: blockedId })
  assert.equal(resumedReview.operationId, blockedReview.operationId); assert.equal(resumedReview.sessionId, blockedReview.sessionId)
  assert.deepEqual((await rpc('experiments', {})).find(row => row.request.experimentId === blockedId).latest, blockedOriginal)
  let resumedGoal
  let resumedGoalTrace
  await expect.poll(async () => {
    const resumedTrace = await rpc('experimentCompletionReviewTrace', { id: blockedId, operationId: resumedReview.operationId, request: { limit: 100 } })
    resumedGoalTrace = resumedTrace
    resumedGoal = resumedTrace.records.filter(event => event.type === 'goal/change').map(event => JSON.parse(event.data).goal).at(-1)
    return resumedGoal?.phase
  }).toBe('complete').catch(error => {
    writeFileSync(resolve(artifacts, 'completion-retry-goal-debug.json'), JSON.stringify(resumedGoalTrace, null, 2) + '\n')
    throw error
  })
  assert.equal(resumedGoal.id, blockedGoal.id)
  assert.equal(resumedGoal.maxGoalRounds, blockedGoal.maxGoalRounds)
  assert.ok(resumedGoal.revision > blockedGoal.revision)
  const holdId = await create('CPU cancel review', 'hold')
  await rpc('reviewExperimentCompletion', { id: holdId })
  await expect.poll(async () => (await rpc('experimentCompletionReviewStatus', { id: holdId }))?.phase).toBe('collecting')
  await page.getByRole('button', { name: '返回实验', exact: true }).click()
  await page.getByRole('button', { name: 'CPU cancel review', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前阶段', exact: true })).toHaveAttribute('aria-busy', 'true')
  await page.getByRole('region', { name: '完成证据复验', exact: true }).getByRole('button', { name: '取消补录', exact: true }).click()
  await expect.poll(async () => (await rpc('experimentCompletionReviewStatus', { id: holdId }))?.phase).toBe('cancelled')
  await expect(page.getByRole('region', { name: '当前阶段', exact: true })).toHaveAttribute('aria-busy', 'false')
  const expected = { originalOutcomeRetained: true, originalSubmissionRetained: true, omittedEvidenceCorrected: true, crossNodeRejected: true,
    historicalEnvironmentReadOnly: true, restrictedStandardAgent: true, retrainingToolsAbsent: true, passed: true, missingArtifactBlocked: true,
    cancelled: true, traceRecorded: true, structuredJsonRedaction: true, aggregateDiagnostics: true, originalSessionTraceRecovery: true,
    localized: true, responsive: true, blockedContinuationSupplemented: true, cumulativeAndAdditionalStepsSeparated: true,
    stageToolsCalledByRestrictedAgent: true, originalStepReportsRetained: true, blockedReviewGoalResumedWithSameIdentity: true, gpuAcceptance: 'not run' }
  const snapshot = resolve(root, 'scripts/fixtures/completion.snapshot.json')
  if (process.argv.includes('--record')) writeFileSync(snapshot, JSON.stringify(expected, null, 2) + '\n')
  assert.deepEqual(expected, JSON.parse(readFileSync(snapshot, 'utf8')))
  writeFileSync(resolve(artifacts, 'completion-profile-verification.json'), JSON.stringify({ ...expected, operationId: final.operationId, events: trace.records.length }, null, 2) + '\n')
  console.log('Production completion review: restricted DSH Agent, correction, independent verification, retained failure, cancellation and Web passed without model credentials.')
} catch (error) { throw new Error(String(error) + '\n' + (app?.output().slice(-8000) ?? ''), { cause: error }) }
finally { await browser?.close(); await app?.close(); removeTestDirectory(directory, artifacts) }
