/** Verify the fixed published UI adapters before installing or transferring a release. */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** @param root - installed release or extension workspace. @returns normally only when every read-only renderer patch is installed. */
export function assertPublishedUiCompatibility(root: string): void {
  const owner = createRequire(resolve(root, 'package.json'))
  const dsh = createRequire(owner.resolve('@deepseek-ai/dsh/package.json'))
  for (const [name, marker] of [
    ['dsh-client-ui-conversation', 'bindReadonly(feed)'],
    ['dsh-client-ui-trajectory', 'trajectory.readonly'],
    ['dsh-client-ui-attachment', 'attachments.readonlyImages'],
  ] as const) {
    const entry = dsh.resolve(`@deepseek-ai/${name}/client`)
    const manifest = JSON.parse(readFileSync(resolve(entry, '../../package.json'), 'utf8'))
    if (manifest.version !== '0.2.0-rc.2' || !readFileSync(entry, 'utf8').includes(marker)) {
      throw new Error(`Aspera requires the patched @deepseek-ai/${name}@0.2.0-rc.2 read-only renderer`)
    }
  }
}
