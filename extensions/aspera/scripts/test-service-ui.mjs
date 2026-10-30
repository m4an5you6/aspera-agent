/** Production service UI checks use only profile-launched CPU services and temporary fixture records. */
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { expect as baseExpect } from '@playwright/test'
import { openAspera } from './test-app.mjs'

const expect = baseExpect.configure({ timeout: 40000 })
const serviceTab = page => page.getByRole('button', { name: /^(推理服务|Inference services)$/ }).last()
const serviceRegion = page => page.getByRole('region', { name: /^(推理服务|Inference services)$/ })
const exampleRegion = page => page.getByRole('region', { name: /^(调用示例|Calling examples)$/ })

/** @param page - production Web page. @param control - fixture observations. @param externalUrl - isolated authenticated gateway.
 * @param output - screenshot directory. @returns UI and HTTP observations without calling a GPU model.
 */
export async function checkServiceConnection(page, control, externalUrl, output) {
  await expect(page.getByText(/^(外部地址已验证|External address verified)$/)).toBeVisible()
  const examples = exampleRegion(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
  await expect(examples.getByRole('button', { name: /^(直接调用模型|Call the model)$/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(examples.locator('pre')).toContainText('/v1/chat/completions')
  await expect(examples.locator('pre')).toContainText('cpu-fixture')
  await expect(examples.getByRole('button', { name: 'PowerShell', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(examples.locator('pre')).toContainText('YOUR_API_KEY')
  await expect(examples.locator('pre')).toContainText('ConvertTo-Json -Depth 6')
  await expect(examples.locator('pre')).toContainText('Invoke-RestMethod @params')
  await expect(examples.locator('pre')).toContainText('$raw.RawContentStream.ToArray()')
  const initialCalls = (await control()).controlCalls.filter(call => call.operation === 'access-service').length
  for (const language of ['PowerShell','cURL']) {
    await examples.getByRole('button', { name: language, exact: true }).click()
    await examples.getByRole('button', { name: /^(服务健康检查|Service health check)$/ }).click()
    await expect(examples.locator('pre')).toContainText('/_aspera/health')
    await expect(examples.locator('pre')).not.toContainText('messages')
    await examples.getByRole('button', { name: /^(直接调用模型|Call the model)$/ }).click()
    await expect(examples.locator('pre')).toContainText('messages')
    const copied = await examples.locator('pre').innerText()
    await examples.getByRole('button', {name:/^(复制调用示例|Copy Calling examples)$/}).click()
    await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n','\n')).toBe(copied)
  }
  assert.equal((await control()).controlCalls.filter(call => call.operation === 'access-service').length, initialCalls)
  assert.equal((await page.request.get(externalUrl)).status(), 401)
  await serviceRegion(page).getByRole('button', { name: /^(查看|Show)$/ }).click()
  const connection = page.getByRole('region', { name: /^(接入信息|Connection information)$/ })
  let token
  try {
    await expect(connection.locator('code').last()).toHaveText(/^[a-f0-9]{64}$/)
    token = await connection.locator('code').last().innerText()
    assert.equal(JSON.stringify(await control()).includes(token), false)
    assert.equal((await examples.innerText()).includes(token), false)
    for (const language of ['PowerShell', 'cURL']) {
      await examples.getByRole('button', { name: language, exact: true }).click()
      for (const kind of [/^(服务健康检查|Service health check)$/, /^(直接调用模型|Call the model)$/]) {
        await examples.getByRole('button', { name: kind }).click()
        await examples.getByRole('button', { name: /^(复制命令（含密钥）|Copy command with key)$/ }).click()
        await expect.poll(async () => (await page.evaluate(() => navigator.clipboard.readText())).includes(token)).toBe(true)
        const command = await page.evaluate(() => navigator.clipboard.readText())
        assert.equal(command.includes('YOUR_API_KEY'), false)
        assert.equal(command.includes(externalUrl), true)
        assert.equal((await examples.innerText()).includes(token), false)
        await page.evaluate(() => navigator.clipboard.writeText(''))
      }
    }
    assert.equal((await control()).controlCalls.filter(call => call.operation === 'access-service').length, initialCalls)
    assert.equal((await page.request.get(externalUrl + '/_aspera/health', { headers: { authorization: 'Bearer ' + token } })).status(), 200)
    const generated = await page.request.post(externalUrl + '/v1/chat/completions', { headers: { authorization: 'Bearer ' + token },
      data: { model: 'cpu-fixture', messages: [{ role:'user', content:'中文 CPU 接口验证' }], max_tokens:256, stream:false } })
    assert.equal(generated.status(), 200)
    assert.equal((await generated.json()).choices[0].message.content, 'CPU fixture response: 中文 CPU 接口验证')
  } finally {
    const hide = connection.getByRole('button', { name: /^(隐藏|Hide)$/ })
    if (await hide.count()) await hide.click()
    token = undefined
  }
  await expect(connection.locator('code').last()).toContainText('••••')
  const debug = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^(请求调试|Request test)/ }) })
  await debug.locator('summary').click()
  await expect(debug.getByRole('textbox').first()).toHaveValue('/health')
  await debug.getByRole('textbox').first().fill('/')
  await debug.getByRole('button', { name: /^(发送请求|Send request)$/ }).click()
  await expect(debug.getByRole('region', { name: /^(返回结果|Response)$/ })).toContainText('CPU fixture response')
  await debug.getByRole('button', { name: /^(请求方法|Request method)$/ }).click()
  await page.getByRole('menuitem', { name: 'POST', exact: true }).click()
  await debug.getByRole('textbox').first().fill('/v1/chat/completions')
  await debug.locator('textarea').fill('{ invalid json')
  const beforeInvalid = (await control()).controlCalls.filter(call => call.operation === 'access-service').length
  await debug.getByRole('button', { name: /^(发送请求|Send request)$/ }).click()
  await expect(debug.getByRole('alert')).toBeVisible()
  assert.equal((await control()).controlCalls.filter(call => call.operation === 'access-service').length, beforeInvalid)
  await debug.locator('textarea').fill(JSON.stringify({ model:'cpu-fixture', messages:[{role:'user',content:'managed test'}], max_tokens:256, stream:false }))
  await debug.getByRole('button', { name: /^(发送请求|Send request)$/ }).click()
  await expect(debug.getByRole('region', { name: /^(返回结果|Response)$/ })).toContainText('managed test')
  await debug.locator('summary').click()
  await examples.getByRole('button', {name:'PowerShell',exact:true}).click()
  await page.screenshot({path:resolve(output,'inference-services-production-light.png')})
  return { publicAuthentication:true, modelPost:true, managedGetPost:true, invalidJsonRejected:true, examplesDoNotCall:true, keyAbsentFromSnapshots:true, defaultPowerShell:true, copyCommandWithKey:true }
}

/** @param page - production page. @param control - fixture control. @returns after confirmed fixture process release. */
export async function stopFixtureService(page, control) {
  await serviceRegion(page).getByRole('button', { name:/^(管理|Manage)$/ }).click()
  await page.getByRole('menuitem', {name:/^(停止服务|Stop service)$/}).click()
  const dialog=page.getByRole('dialog', {name:/停止这项推理服务|Stop this inference service/})
  await expect(dialog).toContainText(/模型、训练结果和历史记录会保留|Model files, training results and historical records are retained/)
  await dialog.getByRole('button', {name:/^(继续运行|Keep running)$/}).click()
  await expect(dialog).toHaveCount(0)
  await serviceRegion(page).getByRole('button', {name:/^(管理|Manage)$/}).click()
  await page.getByRole('menuitem', {name:/^(停止服务|Stop service)$/}).click()
  await dialog.getByRole('button', {name:/^(停止服务|Stop service)$/}).click()
  await expect(serviceRegion(page).getByText(/^(已停止|Stopped)$/).first()).toBeVisible()
  await expect(page.getByRole('region', {name:/^(调用示例|Calling examples)$/})).toHaveCount(0)
  assert.ok((await control()).queue.some(row=>row.services.some(service=>service.released)))
}

/** @param page - real profile page. @param control - CPU provider. @param create - ordinary creation flow.
 * @param browser - isolated browser. @param url - profile entry. @param externalUrl - CPU gateway. @param output - screenshots.
 * @returns source selection, isolation, appearance and stopped-service observations.
 */
export async function checkInferenceServices(page, control, create, browser, url, externalUrl, output) {
  await create('CPU service review','CPU A')
  await expect(page.locator('header').getByRole('status')).toHaveText(/服务中|Serving/,{timeout:180000})
  const owner=(await control()).experiments.find(row=>row.request.name==='CPU service review')
  await serviceTab(page).click()
  const observations=await checkServiceConnection(page,control,externalUrl,output)
  await control('service-view',owner.request.experimentId)
  await page.getByRole('button',{name:/^(实验|Experiments)$/}).first().click()
  await page.getByRole('button',{name:'CPU service source',exact:true}).click()
  await serviceTab(page).click()
  const root=serviceRegion(page)
  const selection=root.getByRole('group',{name:/^(选择服务|Choose a service)$/})
  await expect(selection.getByRole('button')).toHaveCount(2)
  await expect(selection.getByRole('button').first()).toContainText('cpu-fixture')
  await control('hold-service-key')
  await root.getByRole('button',{name:/^(查看|Show)$/}).click()
  await selection.getByRole('button').last().click()
  await control('release-service-key')
  await expect(root.getByRole('region',{name:/^(接入信息|Connection information)$/}).locator('code').last()).toContainText('••••')
  await selection.getByRole('button').first().click()
  await expect(root.getByRole('region',{name:/^(接入信息|Connection information)$/}).locator('code').last()).toContainText('••••')
  await page.evaluate(() => navigator.clipboard.writeText('pending-copy-sentinel'))
  await control('hold-service-key')
  await exampleRegion(page).getByRole('button',{name:/^(复制命令（含密钥）|Copy command with key)$/}).click()
  await selection.getByRole('button').last().click()
  await control('release-service-key')
  await selection.getByRole('button').first().click()
  await root.getByRole('button',{name:/^(查看|Show)$/}).click()
  await expect(root.getByRole('region',{name:/^(接入信息|Connection information)$/}).locator('code').last()).toHaveText(/^[a-f0-9]{64}$/)
  await root.getByRole('button',{name:/^(隐藏|Hide)$/}).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'pending-copy-sentinel')
  await page.evaluate(() => navigator.clipboard.writeText(''))
  await selection.getByRole('button').last().click()
  await expect(root.getByText(/^(健康检查异常|Health check needs attention)$/).last()).toBeVisible()
  await page.getByRole('button',{name:/^(刷新状态|Refresh status)$/}).click()
  await expect(selection.getByRole('button').last()).toHaveAttribute('aria-pressed','true')
  await selection.getByRole('button').first().click()
  await control('fail-status')
  await root.getByRole('button',{name:/^(刷新状态|Refresh status)$/}).click()
  await expect(root.getByText(/^(状态待确认|Status unconfirmed)$/).first()).toBeVisible()
  await expect(root.getByRole('button',{name:/^(查看|Show)$/})).toBeEnabled()
  await root.getByRole('button',{name:/^(查看|Show)$/}).click()
  const offlineConnection=root.getByRole('region',{name:/^(接入信息|Connection information)$/})
  try {
    await expect(offlineConnection.locator('code').last()).toHaveText(/^[a-f0-9]{64}$/)
    await offlineConnection.getByRole('button',{name:/^(复制API Key|Copy API Key)$/}).click()
    await expect.poll(()=>page.evaluate(()=>navigator.clipboard.readText())).toBe(await offlineConnection.locator('code').last().textContent())
    await page.evaluate(()=>navigator.clipboard.writeText(''))
    await expect(root.getByText(/^(状态待确认|Status unconfirmed)$/).first()).toBeVisible()
  } finally {const hide=offlineConnection.getByRole('button',{name:/^(隐藏|Hide)$/});if(await hide.count())await hide.click()}
  await control('restore-status')
  await root.getByRole('button',{name:/^(刷新状态|Refresh status)$/}).click()
  await expect(root.getByText(/^(服务可用|Service available)$/).first()).toBeVisible()
  for(const dark of [false,true]) {
    await page.evaluate(value=>{if(value)document.body.dataset.dsDarkTheme='';else delete document.body.dataset.dsDarkTheme},dark)
    for(const width of [1440,760,560]) {
      await page.setViewportSize({width,height:1050})
      assert.ok(await root.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'Service UI must fit its available width')
      await page.evaluate(() => { for (const el of document.querySelectorAll('main,article,section,div')) if (el.scrollHeight > el.clientHeight && ['auto','scroll'].includes(getComputedStyle(el).overflowY)) el.scrollTop=0 })
      await page.screenshot({path:resolve(output,`inference-services-production-${dark?'dark':'light'}-${width}.png`)})
    }
  }
  await page.setViewportSize({width:1440,height:1050})
  await page.evaluate(()=>{delete document.body.dataset.dsDarkTheme})
  const english=await browser.newContext({locale:'en-US'})
  try {
    const en=await english.newPage();await openAspera(en,url)
    await en.getByRole('button',{name:/^(实验|Experiments)$/}).first().click()
    await en.getByRole('button',{name:'CPU service source',exact:true}).click();await serviceTab(en).click()
    await expect(en.getByRole('heading',{name:'Connection information',exact:true})).toBeVisible()
    await en.screenshot({path:resolve(output,'inference-services-production-en.png')})
  } finally {await english.close()}
  await control('service-view-clear')
  await page.getByRole('button',{name:/^(实验|Experiments)$/}).first().click()
  await page.getByRole('button',{name:'CPU service review',exact:true}).click();await serviceTab(page).click()
  await stopFixtureService(page,control)
  return {...observations,ownerId:owner.request.experimentId,recoveryAliasesDeduplicated:true,unreleasedFailureVisible:true,selectionPreserved:true,lateKeyDiscarded:true,offlineRetainsRecords:true,unconfirmedKeyReadAndCopy:true,keyReadKeepsStatusError:true,confirmedStop:true,appearanceCases:6,english:true}
}
