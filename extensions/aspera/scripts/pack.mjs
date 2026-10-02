/** Builds a release archive from already built package artifacts. */
import { mkdirSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { snapshotSource } from '../packages/dispatch/lib/snapshot.js'
const root = resolve(import.meta.dirname, '..')
const snapshot = await snapshotSource(root, 120000)
try {
  const output = resolve(root, '.artifacts')
  mkdirSync(output, { recursive: true })
  copyFileSync(snapshot.archive, resolve(output, `aspera-${snapshot.digest}.tar`))
  console.log(`Release ${snapshot.digest} written to .artifacts/`)
} finally { snapshot.dispose() }
