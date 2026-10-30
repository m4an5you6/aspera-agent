/** Private version-one planning files use atomic writes and checked ownership. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { planningOwnerSchema } from '@aspera/experiments'
import type { PlanningOwner } from '@aspera/experiments'
import { z } from 'zod'

/** @param value - JSON-serializable record. @returns stable content identity for a saved request. */
export function planningDigest(value: object | string): string { return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex') }
/** Return bounded complete Unicode text; cursors count UTF-16 code units, byte limits count UTF-8.
 * @param text - immutable original. @param offset - returned text position. @param maxBytes - maximum content bytes. @returns text and next position.
 */
export function planningTextPage(text: string, offset: number, maxBytes: number): { text: string; nextOffset: number; totalCharacters: number } {
  if (offset > text.length || offset > 0 && /[\uDC00-\uDFFF]/.test(text[offset] ?? '') && /[\uD800-\uDBFF]/.test(text[offset - 1] ?? '')) throw new Error('Text cursor splits or exceeds the saved content')
  let bytes = 0, end = offset
  for (const character of text.slice(offset)) { const size = Buffer.byteLength(character); if (bytes + size > maxBytes) break; bytes += size; end += character.length }
  return { text: text.slice(offset, end), nextOffset: end, totalCharacters: text.length }
}

/** Atomic planning files stay outside the writable Agent workspace. */
export class PlanningStore {
  readonly directory: string
  /** @param runRoot - program-owned experiment directory. @param owner - immutable worker identity. */
  constructor(private readonly runRoot: string, readonly owner: PlanningOwner, namespace = 'planning-v1') { this.directory = resolve(runRoot, namespace) }
  /** @param parts - program-generated relative names. @returns checked file path. */
  path(...parts: string[]): string {
    const path = resolve(this.directory, ...parts)
    if (path !== this.directory && !path.startsWith(this.directory + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Planning path escaped its experiment')
    for (let current = path;; current = dirname(current)) {
      if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Planning path contains a symbolic link')
      if (current === resolve(this.runRoot)) break
      if (dirname(current) === current) throw new Error('Planning path escaped its experiment')
    }
    return path
  }
  /** @returns ownership initialization; a copied or foreign record is never adopted. */
  async initialize(): Promise<void> {
    this.path(); mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    await withFileLock(this.path('owner.json'), async () => {
      const path = this.path('owner.json')
      if (existsSync(path)) {
        const saved = z.object({ version: z.literal(1), formatVersion: z.literal('0.1.0'), owner: planningOwnerSchema }).strict().parse(JSON.parse(readFileSync(path, 'utf8')))
        if (saved.owner.experimentId !== this.owner.experimentId || saved.owner.sessionId !== this.owner.sessionId
          || saved.owner.deploymentId !== this.owner.deploymentId) throw new Error('Planning record owner differs from this fixed experiment, release or Session')
      } else await writeFileAtomic(path, JSON.stringify({ version: 1, formatVersion: '0.1.0', owner: this.owner }) + '\n', { mode: 0o600 })
    })
  }
  /** @param parts - private record path. @param value - complete record. @returns durable replacement. */
  async write(parts: string[], value: object): Promise<void> {
    const path = this.path(...parts); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); this.path(...parts)
    await writeFileAtomic(path, JSON.stringify(value) + '\n', { mode: 0o600 })
  }
}
