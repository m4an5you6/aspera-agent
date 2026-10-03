/** Profile launch helpers shared by artifact and browser integration checks. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve, sep } from 'node:path'
import { readFileSync, writeFileSync, lstatSync, readdirSync, unlinkSync, rmSync, realpathSync } from 'node:fs'

/** Remove one generated test directory, unlinking junctions before recursive cleanup. */
export function removeTestDirectory(directory, parent) {
  const target = resolve(directory); const intended = realpathSync(parent)
  if (!target.startsWith(resolve(parent) + sep) || lstatSync(target).isSymbolicLink()
    || !realpathSync(target).startsWith(intended + sep)) throw new Error('Test cleanup target is outside its owned parent')
  const unlinkLinks = folder => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const file = resolve(folder, entry.name); const info = lstatSync(file)
      if (info.isSymbolicLink()) unlinkSync(file)
      else if (info.isDirectory()) unlinkLinks(file)
    }
  }
  unlinkLinks(target)
  rmSync(target, { recursive: true, force: true })
}

/** Run a bounded maintenance command; application starts use launchProfile. */
export async function command(file, args, cwd, env = {}, timeoutMs = 180000) {
  const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', bytes => { output += bytes })
  child.stderr.on('data', bytes => { output += bytes })
  const timer = setTimeout(() => { child.kill('SIGTERM') }, timeoutMs)
  try {
    const [code] = await once(child, 'exit')
    if (code !== 0) throw new Error(`Maintenance command failed (${code}): ${output.slice(-5000)}`)
    return output
  } finally { clearTimeout(timer) }
}

/** Start an installed dsh profile and join its process on cleanup. */
export async function launchProfile(release, home, profile, env = {}, startupTimeoutMs = 60000) {
  const manifestPath = resolve(home, 'profiles', profile, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.dependencies['@deepseek-ai/dsh-host-directory-picker-browse'] = '0.2.0-rc.2'
  manifest.dependencies['@deepseek-ai/dsh-client-ui-directory-picker-browse'] = '0.2.0-rc.2'
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const patchPath = resolve(home, 'profiles', profile, 'cordis.patch.yml')
  const patch = JSON.parse(readFileSync(patchPath, 'utf8'))
  const picker = JSON.parse(readFileSync(resolve(import.meta.dirname, 'fixtures/picker.overlay.yml'), 'utf8'))
  writeFileSync(patchPath, JSON.stringify([...patch, ...picker]))
  const child = spawn(process.execPath, [resolve(release, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '--profile', profile, '--no-open', '--port', '0'],
    { cwd: release, env: { ...process.env, DSH_HOME: home, ASPERA_EXTENSION_ROOT: release, DSH_TELEMETRY_DISABLED: '1', ...env },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let output = ''
  child.stdout.on('data', bytes => { output += bytes })
  child.stderr.on('data', bytes => { output += bytes })
  async function close() {
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 15000)
    child.kill('SIGTERM')
    try { await exited } finally { clearTimeout(timer) }
  }
  const deadline = Date.now() + startupTimeoutMs
  while (Date.now() < deadline) {
    // oxlint-disable-next-line no-control-regex -- CLI color output may terminate the URL with the ANSI escape character.
    const url = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+(?=[\r\n\s\x1b])/.exec(output)?.[0]
    if (url !== undefined) return { url, close, output: () => output }
    if (child.exitCode !== null) throw new Error('Profile stopped during startup: ' + output.slice(-6000))
    await delay(100)
  }
  await close()
  throw new Error(`Profile startup timed out after ${startupTimeoutMs} ms: ` + output.slice(-6000))
}

/** Dismiss the release notice and open the independent management page. */
export async function openAspera(page, url) {
  await page.goto(url)
  const notice = page.getByText(/^(继续|Continue)$/, { exact: true })
  await notice.waitFor({ timeout: 15000 }).catch(() => {})
  if (await notice.isVisible()) { await notice.click(); await notice.waitFor({ state: 'hidden', timeout: 15000 }) }
  const later = page.getByText(/^(稍后配置|Configure later)$/, { exact: true })
  await later.waitFor({ timeout: 5000 }).catch(() => {})
  if (await later.isVisible()) { await later.click(); await later.waitFor({ state: 'hidden', timeout: 15000 }) }
  const group = page.getByRole('button', { name: 'Aspera', exact: true })
  await group.waitFor()
  if (await group.getAttribute('aria-expanded') !== 'true') await group.click()
  await page.getByRole('button', { name: /^(实验|Experiments)$/ }).click()
  await page.getByRole('heading', { name: /^(实验|Experiments)$/, exact: true }).waitFor()
}
