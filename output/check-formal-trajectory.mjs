import { resolve } from 'node:path'
import { writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { chromium, expect } from '../extensions/aspera/node_modules/@playwright/test/index.mjs'
import { launchProfile, openAspera } from '../extensions/aspera/scripts/test-app.mjs'
const root=resolve('extensions/aspera')
const store=resolve(root,'node_modules/.pnpm')
const yaml=createRequire(resolve('package.json'))(resolve(store,readdirSync(store).find(name=>name.startsWith('yaml@')),'node_modules/yaml'))
const patch=resolve(root,'.artifacts/web-test-YGaYR4/home/profiles/aspera/cordis.patch.yml')
writeFileSync(patch,JSON.stringify(yaml.parse(readFileSync(patch,'utf8'))))
const app=await launchProfile(root, resolve(root,'.artifacts/web-test-YGaYR4/home'),'aspera',{},180000)
let browser
try {
 browser=await chromium.launch({headless:true,executablePath:'C:/Users/陈昊/AppData/Local/ms-playwright/chromium_headless_shell-1208/chrome-headless-shell-win64/chrome-headless-shell.exe'})
 const page=await browser.newPage({viewport:{width:1440,height:940}})
 page.on('pageerror', error=>console.error(error.message))
 await openAspera(page,app.url)
 await page.getByRole('button').filter({has:page.getByText('CPU semi experiment',{exact:true})}).click()
 await page.getByRole('button',{name:/^(Agent 记录|Agent records)$/}).click()
 await page.getByRole('button',{name:/计划|Planning/}).filter({hasText:/计划|Planning/}).last().click()
 await expect(page.locator('[data-record-index]').first()).toBeVisible({timeout:20000})
 await page.screenshot({path:resolve('output/playwright/formal-trace-first.png')})
 console.log((await page.locator('body').innerText()).slice(-7000))
} catch(error){console.error(error); writeFileSync(resolve('output/formal-profile.log'),app.output());process.exitCode=1}
finally {await browser?.close(); await app.close()}
