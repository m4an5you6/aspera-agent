/** Check the real management profile's authenticated API without substituting its dispatch plugin. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { command, launchProfile, removeTestDirectory } from './test-app.mjs'

const source = resolve(import.meta.dirname, '..')
const release = process.env.ASPERA_API_TEST_RELEASE ?? source
const artifacts = resolve(source, '.artifacts')
mkdirSync(artifacts, { recursive: true })
const directory = mkdtempSync(resolve(artifacts, 'api-test-'))
const home = resolve(directory, 'home')
const ready = resolve(directory, 'ready.json')
let app
try {
  await command(process.execPath, [release === source ? 'scripts/setup.mjs' : 'setup.mjs'], release, { ASPERA_HOME: home, DSH_HOME: home })
  const registry = resolve(home, 'storages/aspera_fleet/registry')
  mkdirSync(registry, { recursive: true })
  writeFileSync(resolve(registry, 'servers.json'), JSON.stringify({ version: 1, record: { servers: [] } }) + '\n')
  writeFileSync(resolve(home, 'profiles/aspera/cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'api-readiness',
    name: pathToFileURL(resolve(source, 'scripts/fixtures/api-ready.mjs')).href, config: { ready } }] }]))
  app = await launchProfile(release, home, 'aspera', { DEEPSEEK_API_KEY: '' })
  const deadline = Date.now() + 30000
  while (!existsSync(ready)) {
    assert.ok(Date.now() < deadline, 'Management API profile did not settle')
    await delay(50)
  }
  const exchange = await fetch(app.url, { redirect: 'manual', signal: AbortSignal.timeout(5000) })
  assert.equal(exchange.status, 303)
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0]
  assert.ok(cookie, 'Management profile did not issue its browser cookie')
  const base = new URL(app.url).origin
  for (const method of ['aspera/servers', 'aspera/experiments']) {
    const response = await fetch(`${base}/api/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: 'api-startup', method, payload: { args: {} } }),
      signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200, `${method} returned HTTP ${response.status}; services: ${readFileSync(ready, 'utf8')}`)
    const value = await response.json()
    assert.equal(value.result.ok, true, JSON.stringify(value.result))
    if (method === 'aspera/servers') assert.deepEqual(value.result.value, { servers: [] })
    else assert.deepEqual(value.result.value, [])
  }
  console.log('Production management profile: authenticated server and experiment APIs passed without a model key.')
} finally { await app?.close(); removeTestDirectory(directory, artifacts) }
