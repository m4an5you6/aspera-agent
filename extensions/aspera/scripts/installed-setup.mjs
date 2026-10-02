/** Installs profiles over an already installed immutable release. It does not launch an app. */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setupWorkerProfile } from '@aspera/runtime'
const root = resolve(import.meta.dirname)
const home = process.env.DSH_HOME || resolve(root, '.dsh-home')
if (process.argv.includes('--worker')) await setupWorkerProfile(home, root)
else {
  const profile = resolve(home, 'profiles', 'aspera')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  if (!existsSync(resolve(profile, 'node_modules'))) symlinkSync(resolve(root, 'node_modules'), resolve(profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ name: 'aspera-web-profile', private: true,
    dependencies: { '@aspera/dispatch': '0.2.0', '@aspera/console': '0.2.0', '@deepseek-ai/dsh-web-app': '0.2.0-rc.2' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@aspera/dispatch'] } } }, null, 2) + '\n')
  if (!existsSync(resolve(profile, 'cordis.patch.yml'))) writeFileSync(resolve(profile, 'cordis.patch.yml'), '[]\n')
}
