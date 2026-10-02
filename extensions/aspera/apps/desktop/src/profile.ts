/** Keep external plugin packages writable and the application runtime immutable. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync, unlinkSync, readlinkSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load, dump } from 'js-yaml'
import z from 'zod'

const markerSchema = z.object({ version: z.union([z.literal(1), z.literal(2)]), runtime: z.string() }).strict()
const manifestSchema = z.object({ dependencies: z.record(z.string(), z.string()).optional(),
  dsh: z.object({ profile: z.object({ bundles: z.array(z.string()) }).passthrough() }).passthrough(),
}).passthrough()
const patchSchema = z.array(z.object({ id: z.string().optional(), disabled: z.boolean().optional(),
  insert: z.array(z.object({ id: z.string().optional() }).passthrough()).optional(),
}).passthrough())
const bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@aspera/dispatch']

/**
 * Prepare the managed external-plugin profile; migrate only a verified legacy runtime link.
 * @param home - Independent Harness home.
 * @param runtime - Frozen application package location, including an Electron archive.
 * @param hostPlugin - Private lifecycle plugin file.
 * @returns Profile directory whose dependencies belong to the user.
 */
export function prepareDesktopProfile(home: string, runtime: string, hostPlugin: string): string {
  const profile = resolve(home, 'profiles/aspera-desktop')
  const modules = resolve(profile, 'node_modules'); const marker = resolve(profile, 'aspera-desktop-profile.json')
  const previous = existsSync(marker) ? markerSchema.parse(JSON.parse(readFileSync(marker, 'utf8'))) : undefined
  const existing = lstatSync(modules, { throwIfNoEntry: false })
  if (existing !== undefined) {
    if (previous === undefined) throw new Error('Desktop profile package directory is not owned by Aspera')
    if (previous.version === 1) {
      if (!existing.isSymbolicLink()) throw new Error('Desktop profile package directory is not owned by Aspera')
      if (resolve(profile, readlinkSync(modules)) !== resolve(previous.runtime)) throw new Error('Desktop profile package link was changed outside Aspera')
      unlinkSync(modules)
    } else if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error('Desktop plugin package directory must be a real directory')
  }
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const manifestPath = resolve(profile, 'package.json')
  const patchPath = resolve(profile, 'cordis.patch.yml')
  if (previous?.version === 1) {
    if (existsSync(patchPath)) {
      const backup = resolve(profile, 'cordis.patch.v1.yml')
      if (!existsSync(backup)) copyFileSync(patchPath, backup)
      const rows = patchSchema.parse(load(readFileSync(patchPath, 'utf8')))
      const migrated = rows.filter(row => !(['hmr', 'plugin-manager', 'tool-plugin-manager', 'directory-picker'].includes(row.id ?? '')
        && row.disabled === true && Object.keys(row).length === 2)
        && row.id !== 'aspera-desktop-lifecycle').map(row => row.insert === undefined ? row : { ...row,
          insert: row.insert.filter(entry => !['aspera-desktop-lifecycle', 'directory-picker-browse', 'ui-directory-picker-browse'].includes(entry.id ?? '')),
        }).filter(row => row.insert === undefined || row.insert.length > 0 || Object.keys(row).length > 1)
      writeFileSync(patchPath, dump(migrated), { mode: 0o600 })
    }
    const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
    for (const name of ['@aspera/dispatch', '@aspera/console', '@deepseek-ai/dsh-web-app',
      '@deepseek-ai/dsh-host-directory-picker-browse', '@deepseek-ai/dsh-client-ui-directory-picker-browse']) delete manifest.dependencies?.[name]
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  }
  if (!existsSync(manifestPath)) writeFileSync(manifestPath, JSON.stringify({ name: 'aspera-desktop-profile',
    private: true, type: 'module', dependencies: {}, dsh: { profile: { bundles } } }, null, 2) + '\n')
  else manifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')))
  if (!existsSync(patchPath)) writeFileSync(patchPath, '[]\n')
  if (!existsSync(resolve(profile, 'pnpm-workspace.yaml'))) writeFileSync(resolve(profile, 'pnpm-workspace.yaml'),
    'packages:\n  - .\nnodeLinker: hoisted\nstrictDepBuilds: true\n')
  const bin = resolve(profile, 'bin'); mkdirSync(bin, { recursive: true })
  if (process.platform === 'win32') writeFileSync(resolve(bin, 'node.cmd'), '@echo off\r\n"%ASPERA_NODE_EXECUTABLE%" %*\r\n')
  writeFileSync(resolve(profile, 'aspera-desktop-host.mjs'), `export { apply, inject } from ${JSON.stringify(pathToFileURL(hostPlugin).href)}\n`, { mode: 0o600 })
  const rows = [
    { id: 'hmr', disabled: true },
    { id: 'directory-picker', disabled: true },
    { insert: [{ id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' }] },
    { insert: [{ id: 'aspera-desktop-lifecycle', name: pathToFileURL(resolve(profile, 'aspera-desktop-host.mjs')).href }] },
  ]
  writeFileSync(resolve(profile, 'aspera-desktop.patch.yml'), JSON.stringify(rows, null, 2) + '\n')
  writeFileSync(marker, JSON.stringify({ version: 2, runtime: resolve(runtime, 'node_modules') }) + '\n', { mode: 0o600 })
  return profile
}
