/** Package the compiled carrier and an existing frozen management runtime. */
import assert from 'node:assert/strict'
import { cpSync, existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { createRequire } from 'node:module'

/**
 * Include every archive-marked native file and the complete bundled package manager.
 * @param options - compiled application, sealed runtime and owned output directories.
 * @returns after the unpacked Windows application has been written.
 */
export async function buildWindowsDesktop({ application, sealed, output, buildInfo }) {
  const require = createRequire(resolve(application, 'package.json'))
  const { build, Platform, Arch } = require('electron-builder')
  assert.ok(existsSync(sealed), 'The frozen runtime archive is missing')
  const unpacked = sealed + '.unpacked'
  assert.ok(existsSync(resolve(unpacked, 'node_modules/pnpm/bin/pnpm.cjs')), 'The frozen package manager is missing')
  await build({ projectDir: application, targets: Platform.WINDOWS.createTarget(['dir'], Arch.x64), publish: 'never',
    config: { appId: 'org.aspera.desktop', productName: 'Aspera', electronVersion: '44.0.0', asar: false, npmRebuild: false,
      directories: { output }, artifactName: 'Aspera-${version}-win.${ext}', files: ['lib/**/*.js', 'lib/preload.cjs', 'resources/icon.png', 'resources/badges/*.png', 'package.json', 'LICENSE'],
      extraResources: [{ from: sealed, to: 'runtime.asar' }, { from: buildInfo, to: 'build-info.json' }],
      afterPack(context) {
        const directory = resolve(context.appOutDir)
        assert.ok(directory.startsWith(resolve(output) + sep), 'Desktop output is outside its owned directory')
        // electron-builder's resource filters omit node_modules, including archive-unpacked pnpm and native libraries.
        cpSync(unpacked, resolve(directory, 'resources/runtime.asar.unpacked'), { recursive: true })
        assert.ok(existsSync(resolve(directory, 'resources/runtime.asar.unpacked/node_modules/pnpm/bin/pnpm.cjs')))
      },
      win: { icon: resolve(application, 'resources/icon.png'), signExecutable: false, target: ['dir'] },
    },
  })
}
