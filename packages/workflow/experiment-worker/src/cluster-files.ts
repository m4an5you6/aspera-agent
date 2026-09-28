/** Confined, bounded artifact and log reads for independently running experiments. */
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { ClusterChunk, ClusterFile, ExperimentServerId } from './cluster-protocol.ts'

/**
 * Resolve a relative artifact path and reject linked components.
 * @param root - experiment directory.
 * @param path - relative file name.
 * @returns canonical confined path; links are refused.
 */
export function clusterPath(root: string, path: string): string {
  if (path === '' || path.includes('\\') || path.startsWith('/') || path.split('/').some(part => part === '' || part === '..' || part === '.')) {
    throw new Error('file path must stay inside the experiment directory')
  }
  const base = realpathSync(root)
  const result = resolve(base, path)
  if (!result.startsWith(base + sep)) throw new Error('file path escapes the experiment directory')
  let cursor = base
  for (const part of path.split('/')) {
    cursor = resolve(cursor, part)
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('experiment files cannot traverse links')
  }
  return result
}

/**
 * Read bounded file bytes and identify rotation or missing history.
 * @param path - trusted confined file.
 * @param offset - prior byte cursor.
 * @param generation - prior file identity.
 * @param limit - configured maximum bytes.
 * @param root - owned artifact root, checked against the opened file on Linux.
 * @returns bounded raw bytes and a resumable cursor.
 */
export function readClusterChunk(path: string, offset: number, generation: string | undefined, limit: number, root?: string): ClusterChunk {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid byte cursor')
  if (!existsSync(path)) return { generation: '', offset: 0, nextOffset: 0, data: '',
    reset: generation !== undefined && generation !== '', eof: true }
  const fd = openConfinedFile(path, root)
  try {
    const metadata = fstatSync(fd)
    const identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`
    const reset = (generation !== undefined && generation !== identity) || offset > metadata.size
    const start = reset ? 0 : offset
    const buffer = Buffer.alloc(Math.min(limit, metadata.size - start))
    const count = readSync(fd, buffer, 0, buffer.length, start)
    return { generation: identity, offset: start, nextOffset: start + count, data: buffer.subarray(0,
      count).toString('base64'), reset, eof: start + count >= metadata.size }
  } finally { closeSync(fd) }
}

function openConfinedFile(path: string, root?: string): number {
  const fd = openSync(path, constants.O_RDONLY | (process.platform === 'linux' ? constants.O_NOFOLLOW | constants.O_NONBLOCK : 0))
  try {
    if (!fstatSync(fd).isFile()) throw new Error('artifact is not a regular file')
    if (root !== undefined) {
      // Linux workers check the opened inode, including parent-directory replacement during open.
      const actual = realpathSync(process.platform === 'linux' ? `/proc/self/fd/${fd}` : path)
      if (!actual.startsWith(realpathSync(root) + sep)) throw new Error('opened artifact escapes the experiment directory')
    }
    return fd
  } catch (error) { closeSync(fd); throw error }
}

/**
 * List confined regular files with bounded metadata output.
 * @param root - experiment outputs.
 * @param serverId - owning node.
 * @param limit - maximum returned files.
 * @returns deterministic file metadata and truncation evidence.
 */
export function clusterFiles(root: string, serverId: ExperimentServerId, limit: number): { files: ClusterFile[]; truncated: boolean } {
  const files: ClusterFile[] = []
  if (!existsSync(root)) return { files, truncated: false }
  const pending = ['']
  for (let prefix = pending.shift(); prefix !== undefined; prefix = pending.shift()) {
    const directory = prefix === '' ? realpathSync(root) : clusterPath(root, prefix)
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) { pending.push(path); continue }
      if (!entry.isFile()) continue
      if (files.length === limit) return { files, truncated: true }
      try {
        const fd = openConfinedFile(clusterPath(root, path), root)
        try {
          const metadata = fstatSync(fd)
          files.push({ serverId, path, size: metadata.size, modifiedAt: metadata.mtimeMs })
        } finally { closeSync(fd) }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  return { files, truncated: false }
}
