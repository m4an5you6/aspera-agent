/** Initializes an independent development profile over built extension packages. */
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const home = process.env.ASPERA_HOME || resolve(root, '.dsh-home')
const profile = resolve(home, 'profiles/aspera')
mkdirSync(profile, { recursive: true, mode: 0o700 })
if (!existsSync(resolve(profile, 'node_modules'))) symlinkSync(resolve(root, 'node_modules'), resolve(profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ name: 'aspera-development-profile', private: true,
  dependencies: { '@aspera/dispatch': '0.2.0', '@aspera/console': '0.2.0', '@deepseek-ai/dsh-web-app': '0.2.0-rc.2' },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@aspera/dispatch'] } } }, null, 2) + '\n')
if (!existsSync(resolve(profile, 'cordis.patch.yml'))) writeFileSync(resolve(profile, 'cordis.patch.yml'), '[]\n')
console.log('Aspera profile: ' + profile)
