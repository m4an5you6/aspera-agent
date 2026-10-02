/** Launch the named application profile through the published dsh runner. */
import { resolve, delimiter } from 'node:path'
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'

const runtime = process.env.ASPERA_EXTENSION_ROOT
const home = process.env.DSH_HOME
const pnpm = process.env.npm_execpath
if (runtime === undefined || home === undefined || pnpm === undefined) throw new Error('Desktop profile requires its application runtime, home and package manager')
const directory = resolve(home, 'profiles/aspera-desktop')
const installAnchor = resolve(runtime, 'package.json')
const profile = loadProfileDirectory('dsh', directory, installAnchor)
reportSkippedBundles('dsh', profile)
await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'aspera-desktop',
  resolvedProfile: { profile, installAnchor }, patchFiles: [resolve(directory, 'aspera-desktop.patch.yml')],
  args: ['--no-open', '--port', '0'], packageManager: { command: process.execPath, args: [pnpm],
    env: { ELECTRON_RUN_AS_NODE: '1', ASPERA_NODE_EXECUTABLE: process.execPath,
      PATH: `${resolve(directory, 'bin')}${delimiter}${process.env.PATH ?? ''}` } },
})
