/** Runs the pinned published CLI with Aspera\'s isolated profile home. */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifestPath = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const binEntry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
if (typeof binEntry !== 'string') throw new Error(`@deepseek-ai/dsh declares no dsh bin in ${manifestPath}`)

const child = spawn(process.execPath, [join(dirname(manifestPath), binEntry), ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, DSH_HOME: process.env.ASPERA_HOME || join(root, '.dsh-home'), ASPERA_EXTENSION_ROOT: root, DSH_TELEMETRY_DISABLED: '1' },
})
process.once('SIGINT', () => { child.kill('SIGINT') })
process.once('SIGTERM', () => { child.kill('SIGTERM') })
child.on('exit', (code, signal) => { process.exit(code ?? (signal === null ? 0 : 1)) })
