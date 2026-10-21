/** Verify new and retained desktop profiles through the original EXE, real Agent loop and local Messages transport. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect } from '@playwright/test'
import { desktopOutput } from './desktop-output.mjs'
import { removeTestDirectory } from './test-app.mjs'

const root = resolve(import.meta.dirname, '..')
const output = desktopOutput(root)
const executable = resolve(output, 'win-unpacked/Aspera.exe')
assert.ok(existsSync(executable), 'The unpacked desktop must exist')
const directory = mkdtempSync(resolve(tmpdir(), 'aspera-deepseek-profile-'))
const expected = JSON.parse(readFileSync(new URL('./fixtures/desktop-deepseek.snapshot.json', import.meta.url), 'utf8'))
const requests = []
const server = createServer((request, response) => {
  void respond(request, response).catch(error => { response.destroy(error) })
})
async function respond(request, response) {
  if (request.method === 'GET' && request.url.endsWith('/models')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'deepseek-flash', object: 'model' }] }))
    return
  }
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/v1/messages')
  assert.equal(request.headers['x-api-key'], 'keyless-desktop-fixture')
  const parts = []
  for await (const bytes of request) parts.push(bytes)
  const body = JSON.parse(Buffer.concat(parts).toString('utf8'))
  requests.push(body)
  const events = [
    { type: 'message_start', message: { id: 'desktop-fixture', model: body.model, usage: { input_tokens: 12, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'DESKTOP_EXTENSION_OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''))
}

let app
try {
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready) })
  const baseURL = `http://127.0.0.1:${server.address().port}`
  for (const retained of [false, true]) {
    const label = retained ? 'retained' : 'new'
    const userData = resolve(directory, label)
    const home = resolve(userData, 'dsh')
    const profile = resolve(home, 'profiles/aspera-desktop')
    const observed = resolve(userData, 'replay.json')
    const workspace = resolve(userData, 'workspace')
    mkdirSync(profile, { recursive: true }); mkdirSync(workspace)
    if (retained) writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ name: 'aspera-desktop-profile', private: true,
      dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@aspera/dispatch'] } },
      userField: 'retained' }))
    // The test plugin belongs to this profile, so it exercises the lifecycle proxy's exact package identity.
    const fixture = resolve(profile, 'deepseek-replay.mjs')
    writeFileSync(fixture, readFileSync(new URL('./fixtures/desktop-deepseek.mjs', import.meta.url)))
    const patch = JSON.stringify([{ insert: [{ id: 'desktop-deepseek-replay', name: pathToFileURL(fixture).href,
      config: { observed, workspace } }] }]) + '\n'
    writeFileSync(resolve(profile, 'cordis.patch.yml'), patch)
    const env = { ...process.env, ASPERA_DESKTOP_USER_DATA_DIR: userData, ASPERA_HOME: home,
      DEEPSEEK_API_KEY: 'keyless-desktop-fixture', DEEPSEEK_BASE_URL: baseURL }
    delete env.ELECTRON_RUN_AS_NODE
    const requestStart = requests.length
    app = await electron.launch({ executablePath: executable, env, timeout: 60000 })
    const page = await app.firstWindow()
    await page.waitForURL(url => url.hostname === '127.0.0.1', { timeout: 60000 })
    await expect.poll(() => existsSync(observed), { timeout: 60000 }).toBe(true)
    const replay = JSON.parse(readFileSync(observed, 'utf8'))
    writeFileSync(resolve(root, `.artifacts/desktop-deepseek-${label}-events.json`), JSON.stringify(replay, null, 2) + '\n')
    assert.deepEqual(replay.result, expected, JSON.stringify(replay.error ?? replay.result))
    const manifest = JSON.parse(readFileSync(resolve(profile, 'package.json'), 'utf8'))
    assert.equal(manifest.name, 'aspera-desktop-profile')
    assert.equal(manifest.version, '0.1.1')
    if (retained) assert.equal(manifest.userField, 'retained')
    assert.equal(readFileSync(resolve(profile, 'cordis.patch.yml'), 'utf8'), patch)
    const sent = requests.slice(requestStart).find(body => body.dsh_session_log?.session?.id === 'desktop-deepseek-profile-replay')
    assert.ok(sent, 'The Agent Session must reach the local HTTP transport')
    assert.ok(sent.dsh_plugin_packages.packages.some(item => item.name === 'aspera-desktop-profile' && item.version === '0.1.1'))
    const assistant = replay.events.find(event => event.type === 'assistant/message')
    assert.ok(assistant?.data.stream.some(item => item.type === 'chunk' && item.chunk.type === 'finish'
      && item.chunk.reason.kind === 'stop'), 'The successful provider stream is retained in the canonical Agent message')
    for (const { phase, layout, events } of replay.phaseEvents) {
      const sent = requests.slice(requestStart).find(body => body.dsh_session_log?.session?.id === `desktop-${phase}-${layout}`)
      assert.ok(sent, `${phase} ${layout}: the captured phase Session must reach the local transport`)
      assert.ok(events.some(event => event.type === 'session-log-deepseek/delivery-accepted'))
      assert.ok(!JSON.stringify(events).includes('keyless-desktop-fixture'), 'Private keys must not enter the Session')
    }
    await app.close(); app = undefined
    console.log(`Original EXE: ${label} profile, standard Agent and six captured/legacy phase Agent replays passed.`)
  }
} finally {
  await app?.close()
  server.closeAllConnections()
  await new Promise((done, reject) => server.close(error => error ? reject(error) : done()))
  removeTestDirectory(directory, tmpdir())
}
