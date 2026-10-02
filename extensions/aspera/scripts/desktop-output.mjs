/** Resolve a named verification build or the latest complete build of the same version. */
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'

export function desktopOutput(root) {
  const version = JSON.parse(readFileSync(resolve(root, 'apps/desktop/package.json'), 'utf8')).version
  const directory = resolve(root, '.artifacts', `desktop-${version}`)
  const buildId = process.env.ASPERA_DESKTOP_BUILD_ID
    ?? JSON.parse(readFileSync(resolve(directory, 'latest.json'), 'utf8')).buildId
  if (typeof buildId !== 'string' || !/^[a-zA-Z0-9.-]+$/.test(buildId)) throw new Error('Invalid desktop build identifier')
  const output = resolve(directory, buildId)
  if (!output.startsWith(directory + sep)) throw new Error('Desktop build is outside the artifact directory')
  return output
}
