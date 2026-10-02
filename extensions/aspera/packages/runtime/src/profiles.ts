/** Creates isolated immutable-release worker profiles before the supported dsh launch. */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** @param home - private Harness home. @param release - installed fixed release. @returns completion of profile initialization; existing profiles must retain the same release. */
export async function setupWorkerProfile(home: string, release: string): Promise<void> {
  const profile = resolve(home, 'profiles', 'aspera-worker')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const identity = resolve(profile, 'aspera-release.json')
  if (existsSync(identity) && JSON.parse(readFileSync(identity, 'utf8')).release !== release) throw new Error('worker profile is bound to a different release')
  writeFileSync(identity, JSON.stringify({ version: 1, release }) + '\n', { mode: 0o600 })
  const modules = resolve(profile, 'node_modules')
  if (!existsSync(modules)) symlinkSync(resolve(release, 'node_modules'), modules, process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ name: 'aspera-worker-profile', private: true,
    dependencies: { '@aspera/runtime': '0.2.0', '@deepseek-ai/dsh-base': '0.2.0-rc.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@aspera/runtime'] } } }, null, 2) + '\n', { mode: 0o600 })
  if (!existsSync(resolve(profile, 'cordis.patch.yml'))) writeFileSync(resolve(profile, 'cordis.patch.yml'), '[]\n', { mode: 0o600 })
}
