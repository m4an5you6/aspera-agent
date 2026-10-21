/** Actual profile publication invokes a fixed setup entry and preserves the stable home. */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const program = readFileSync(new URL('../scripts/controller-profile.mjs', import.meta.url), 'utf8')
function fixture() {
  mkdirSync('.artifacts', { recursive: true })
  const root = mkdtempSync(resolve('.artifacts', 'controller-profile-')); roots.push(root)
  const home = resolve(root, 'state/node-home')
  const profile = resolve(home, 'profiles/aspera-worker')
  mkdirSync(profile, { recursive: true }); mkdirSync(resolve(home, 'storages')); mkdirSync(resolve(home, 'sessions'))
  const original = JSON.stringify({ version: 1, release: '/old-fixed-release' }) + '\n'
  writeFileSync(resolve(profile, 'aspera-release.json'), original)
  writeFileSync(resolve(home, 'storages/task.json'), '{"state":"blocked"}\n')
  writeFileSync(resolve(home, 'sessions/original.jsonl'), '{"original":true}\n')
  const release = resolve(root, 'releases', 'a'.repeat(64))
  mkdirSync(resolve(release, 'node_modules'), { recursive: true })
  writeFileSync(resolve(release, '.ready'), 'ready\n')
  writeFileSync(resolve(release, 'aspera-release.json'), JSON.stringify({ deploymentId: 'a'.repeat(64) }))
  writeFileSync(resolve(release, 'setup.mjs'), `import {mkdirSync,writeFileSync,symlinkSync} from 'node:fs';import{resolve}from'node:path';
const profile=resolve(process.env.DSH_HOME,'profiles/aspera-worker');mkdirSync(profile,{recursive:true});
writeFileSync(resolve(profile,'aspera-release.json'),JSON.stringify({version:1,release:${JSON.stringify(release)}}));
writeFileSync(resolve(profile,'package.json'),JSON.stringify({dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@aspera/runtime']}}}));
writeFileSync(resolve(profile,'cordis.patch.yml'),'[]');symlinkSync(${JSON.stringify(resolve(release, 'node_modules'))},resolve(profile,'node_modules'),process.platform==='win32'?'junction':'dir');\n`)
  const request = { root, role: 'node', release, deploymentId: 'a'.repeat(64), timeoutMs: 10000 }
  const publish = () => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program, JSON.stringify(request)], { encoding: 'utf8', timeout: 15000, stdio: 'pipe' }))
  return { root, home, profile, original, request, publish }
}

it('publishes a new fixed-release profile without changing the old profile, tasks or Sessions', () => {
  const f = fixture(); const first = f.publish(); const second = f.publish()
  expect(second).toEqual(first)
  expect(first).toMatchObject({ home: f.home, profileName: 'aspera-worker-' + 'a'.repeat(64) })
  expect(readFileSync(resolve(f.profile, 'aspera-release.json'), 'utf8')).toBe(f.original)
  expect(readFileSync(resolve(f.home, 'storages/task.json'), 'utf8')).toBe('{"state":"blocked"}\n')
  expect(readFileSync(resolve(f.home, 'sessions/original.jsonl'), 'utf8')).toBe('{"original":true}\n')
})
it('refuses a foreign admission fence and an altered published profile', () => {
  const f = fixture(); f.publish()
  writeFileSync(resolve(f.root, 'state/controller-recovery.json'), JSON.stringify({ operationId: 'another-operation' }))
  expect(f.publish).toThrow()
  rmSync(resolve(f.root, 'state/controller-recovery.json'))
  writeFileSync(resolve(f.home, 'profiles/aspera-worker-' + 'a'.repeat(64), 'aspera-release.json'), '{"release":"/other-release"}')
  expect(f.publish).toThrow()
})
