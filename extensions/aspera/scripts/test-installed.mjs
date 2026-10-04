/** Verify frozen release installation outside the source checkout and its actual Web profile. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, dirname } from 'node:path'
import { extract } from 'tar'
import { chromium } from '@playwright/test'
import { snapshotSource } from '../packages/dispatch/lib/snapshot.js'
import { command, launchProfile, openAspera, removeTestDirectory } from './test-app.mjs'

const root = resolve(import.meta.dirname, '..')
const installRoot = mkdtempSync(join(tmpdir(), 'aspera-installed-'))
const snapshot = await snapshotSource(root, 120000)
let app; let browser
try {
  await extract({ file: snapshot.archive, cwd: installRoot, strict: true })
  const pnpm = process.env.npm_execpath
  assert.ok(pnpm, 'Run the check through pnpm')
  const store = dirname((await command(process.execPath, [pnpm, 'store', 'path'], root)).trim())
  await command(process.execPath, [pnpm, 'install', '--offline', '--frozen-lockfile', '--prod', '--store-dir', store], installRoot)
  const manifest = JSON.parse(readFileSync(resolve(installRoot, 'package.json'), 'utf8'))
  assert.equal(manifest.dependencies['@deepseek-ai/dsh'], '0.2.0-rc.2')
  assert.equal(JSON.parse(readFileSync(resolve(installRoot, 'aspera-release.json'), 'utf8')).extension, '0.1.1')
  assert.equal(existsSync(resolve(installRoot, 'packages')), false)
  assert.ok(existsSync(resolve(installRoot, 'node_modules/@aspera/console/lib/client/index.d.ts')))
  for (const name of ['experiments', 'runtime', 'dispatch', 'console']) {
    const packageRoot = resolve(installRoot, 'node_modules/@aspera', name)
    const publicPackage = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'))
    assert.equal(publicPackage.version, '0.1.1')
    for (const [entry, fields] of Object.entries(publicPackage.exports)) {
      for (const file of typeof fields === 'string' ? [fields] : Object.values(fields)) assert.ok(existsSync(resolve(packageRoot, file)), `${name} export ${entry} is missing ${file}`)
    }
    assert.ok(existsSync(resolve(packageRoot, 'LICENSE')))
  }
  writeFileSync(resolve(installRoot, 'consumer.mts'), `import type { FleetCreateRequest } from '@aspera/dispatch/types'\nimport { TYPERT_REMOTE } from '@aspera/dispatch/remote'\nimport { serverRemovalBlockers } from '@aspera/dispatch/server-usage'\nimport { prepareSshHostKey } from '@aspera/runtime/transport'\nimport { clusterSubmissionSchema } from '@aspera/experiments'\nimport { setupWorkerProfile } from '@aspera/runtime'\nconst model = {provider:'qwen-chat',model:'qwen-test'}\nconst request: FleetCreateRequest = {experimentId:'draft',objective:'train',serverIds:[],coordinatorId:'node',mode:'semi',models:{preparation:model,planning:model,execution:model},uploads:[{name:'data.json',size:0}]}\nvoid [request, TYPERT_REMOTE, serverRemovalBlockers, prepareSshHostKey, clusterSubmissionSchema, setupWorkerProfile]\n`)
  await command(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), 'consumer.mts', '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2024'], installRoot)
  const repacked = await snapshotSource(installRoot, 120000)
  try { assert.ok(existsSync(repacked.archive)); assert.equal(repacked.digest.length, 64) }
  finally { repacked.dispose() }
  const home = resolve(installRoot, 'home')
  await command(process.execPath, ['setup.mjs'], installRoot, { DSH_HOME: home })
  const startup = performance.now()
  console.log('Starting the independently installed profile')
  app = await launchProfile(installRoot, home, 'aspera', {}, 180000)
  console.log(`Installed profile ready in ${Math.round(performance.now() - startup)} ms`)
  browser = await chromium.launch({ ...(process.env.ASPERA_BROWSER_EXECUTABLE ? { executablePath: process.env.ASPERA_BROWSER_EXECUTABLE } : { channel: process.env.ASPERA_BROWSER_CHANNEL || 'chrome' }), headless: true })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await openAspera(page, app.url)
  await page.getByRole('button', { name: /^(服务器|Servers)$/ }).click()
  await page.getByRole('button', { name: /^(添加服务器|Add server)$/ }).click()
  await page.locator('input[name=username]').fill('trainer')
  assert.equal(await page.getByRole('dialog').getByLabel(/^(服务器密码|Server password)$/).getAttribute('type'), 'password')
  assert.deepEqual(errors, [])
  mkdirSync(resolve(root, '.artifacts'), { recursive: true })
  await page.screenshot({ path: resolve(root, '.artifacts/installed-web.png'), fullPage: true })
  console.log('Installed release: frozen production install, NodeNext types, dsh profile, sidebar and generated Remote stream passed.')
} finally {
  await browser?.close()
  await app?.close()
  snapshot.dispose()
  removeTestDirectory(installRoot, tmpdir())
}
