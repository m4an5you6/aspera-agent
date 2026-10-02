/** Window policy and profile ownership reject destinations and files outside their owners. */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, lstatSync, readdirSync, rmdirSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { prepareDesktopProfile } from '../src/profile.ts'
import { hostEventSchema, isOwnedNavigation, isExternalLink } from '../src/protocol.ts'

function clean(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (lstatSync(path).isSymbolicLink() || entry.isFile()) unlinkSync(path)
    else if (entry.isDirectory()) clean(path)
  }
  rmdirSync(directory)
}

describe('desktop window and private channel', () => {
  it('rejects Host URLs outside the authenticated loopback app', () => {
    const ready = (url: string) => hostEventSchema.safeParse({ type: 'aspera-desktop-ready', url }).success
    expect(ready('http://127.0.0.1:32123/?token=private')).toBe(true)
    for (const url of ['https://example.test/?token=private', 'http://user@127.0.0.1:32123/?token=private', 'http://127.0.0.1:32123/', 'file:///tmp/app']) expect(ready(url)).toBe(false)
  })
  it('keeps main-frame navigation on the owned origin and sanitizes external links', () => {
    expect(isOwnedNavigation('http://127.0.0.1:32123/?view=aspera', 'http://127.0.0.1:32123')).toBe(true)
    expect(isOwnedNavigation('http://127.0.0.1:32124/', 'http://127.0.0.1:32123')).toBe(false)
    expect(isOwnedNavigation('http://user@127.0.0.1:32123/', 'http://127.0.0.1:32123')).toBe(false)
    expect(isExternalLink('https://docs.example.test/train')).toBe(true)
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.test/', 'http://example.test/']) expect(isExternalLink(url)).toBe(false)
  })
})

describe('desktop profile installation', () => {
  it('retains user patches and installed packages after a portable app moves', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'aspera-profile-'))
    try {
      const old = resolve(root, 'old'); const next = resolve(root, 'next'); const home = resolve(root, 'home')
      mkdirSync(resolve(old, 'node_modules'), { recursive: true }); mkdirSync(resolve(next, 'node_modules'), { recursive: true })
      const profile = prepareDesktopProfile(home, old, resolve(old, 'host.js'))
      expect(existsSync(resolve(profile, 'node_modules'))).toBe(false)
      mkdirSync(resolve(profile, 'node_modules/test-plugin'), { recursive: true })
      const manifest = { dependencies: { 'test-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@aspera/dispatch', 'test-plugin'] } } }
      writeFileSync(resolve(profile, 'package.json'), JSON.stringify(manifest))
      const patch = readFileSync(resolve(profile, 'cordis.patch.yml'), 'utf8') + '\n# user configuration\n'
      writeFileSync(resolve(profile, 'cordis.patch.yml'), patch)
      clean(old)
      prepareDesktopProfile(home, next, resolve(next, 'host.js'))
      expect(readFileSync(resolve(profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
      expect(readFileSync(resolve(profile, 'aspera-desktop-host.mjs'), 'utf8')).toContain('next/host.js')
      expect(JSON.parse(readFileSync(resolve(profile, 'package.json'), 'utf8'))).toEqual(manifest)
      expect(existsSync(resolve(profile, 'node_modules/test-plugin'))).toBe(true)
      expect(readFileSync(resolve(profile, 'aspera-desktop.patch.yml'), 'utf8')).not.toContain('plugin-manager')
    } finally { clean(root) }
  })
  it('refuses an unowned package directory and a link modified outside Aspera', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'aspera-profile-'))
    try {
      const runtime = resolve(root, 'runtime'); const home = resolve(root, 'home')
      mkdirSync(resolve(runtime, 'node_modules'), { recursive: true })
      const profile = resolve(home, 'profiles/aspera-desktop'); const link = resolve(profile, 'node_modules')
      mkdirSync(link, { recursive: true })
      expect(() => prepareDesktopProfile(home, runtime, resolve(runtime, 'host.js'))).toThrow(/not owned/)
      rmdirSync(link); mkdirSync(resolve(root, 'foreign'))
      writeFileSync(resolve(profile, 'aspera-desktop-profile.json'), JSON.stringify({ version: 1, runtime: resolve(runtime, 'node_modules') }))
      symlinkSync(resolve(root, 'foreign'), link, process.platform === 'win32' ? 'junction' : 'dir')
      expect(() => prepareDesktopProfile(home, runtime, resolve(runtime, 'host.js'))).toThrow(/changed outside/)
    } finally { clean(root) }
  })
  it('migrates a verified legacy link and retains the original settings backup', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'aspera-profile-'))
    try {
      const home = resolve(root, 'home'); const profile = resolve(home, 'profiles/aspera-desktop'); const runtime = resolve(root, 'legacy/node_modules')
      mkdirSync(profile, { recursive: true }); mkdirSync(runtime, { recursive: true })
      symlinkSync(runtime, resolve(profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
      writeFileSync(resolve(profile, 'aspera-desktop-profile.json'), JSON.stringify({ version: 1, runtime }))
      writeFileSync(resolve(profile, 'package.json'), JSON.stringify({ dependencies: { '@aspera/dispatch': '0.1.0' }, dsh: { profile: { bundles: ['@aspera/dispatch'] } } }))
      const old = '- id: plugin-manager\n  disabled: true\n- id: user-plugin\n  config:\n    value: retained\n'
      writeFileSync(resolve(profile, 'cordis.patch.yml'), old)
      prepareDesktopProfile(home, resolve(root, 'runtime.asar'), resolve(root, 'host.js'))
      expect(existsSync(resolve(profile, 'node_modules'))).toBe(false)
      expect(readFileSync(resolve(profile, 'cordis.patch.v1.yml'), 'utf8')).toBe(old)
      const migrated = readFileSync(resolve(profile, 'cordis.patch.yml'), 'utf8')
      expect(migrated).not.toContain('plugin-manager')
      expect(migrated).toContain('retained')
      prepareDesktopProfile(home, resolve(root, 'runtime.asar'), resolve(root, 'host.js'))
      expect(readFileSync(resolve(profile, 'cordis.patch.v1.yml'), 'utf8')).toBe(old)
    } finally { clean(root) }
  })
})
