/** Immutable ModelScope dataset manifests read from official Git objects without checkout or LFS downloads. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { readdirSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { inspectExperimentMaterialsSchema } from '@aspera/experiments'

type Request = z.infer<typeof inspectExperimentMaterialsSchema>
const execute = promisify(execFile)

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|ASKPASS|^GIT_/i.test(name)))
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_LFS_SKIP_SMUDGE: '1' }
}

async function git(directory: string, args: string[], readBytes: number, signal: AbortSignal): Promise<Buffer> {
  const value = await execute('git', ['-c', 'credential.helper=', '-c', 'core.askPass=', '-c', 'core.hooksPath=',
    '-c', 'protocol.file.allow=never', '-c', 'protocol.ext.allow=never', '-c', 'fetch.fsckObjects=true', '-C', directory, ...args],
  { encoding: 'buffer', maxBuffer: readBytes, signal, env: gitEnvironment(), windowsHide: true })
  return value.stdout
}

/**
 * Decode a fetched Git commit and its blob or LFS identities without running repository code.
 * @param options - private repository, requested immutable commit, output limit and cancellation.
 * @returns canonical file identities for the node's independent content verification.
 */
export async function readGitDatasetManifest(options: { directory: string; request: Request; readBytes: number; signal: AbortSignal }): Promise<unknown> {
  const { directory, request, readBytes, signal } = options
  const actual = (await git(directory, ['rev-parse', '--verify', request.revision + '^{commit}'], readBytes, signal)).toString('utf8').trim()
  if (actual !== request.revision) throw new Error('Official Git commit differs from the requested fixed revision')
  const tree = await git(directory, ['ls-tree', '-r', '-l', '-z', '--full-tree', actual], readBytes, signal)
  const siblings: { rfilename: string; size: number; blobId: string; lfs?: { sha256: string; size: number } }[] = []
  for (const line of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\s+(\d+)\t([\s\S]+)$/.exec(line)
    if (match === null) throw new Error('Dataset Git tree contains a symlink, submodule or unsupported entry')
    const [, , blobId, sizeText, name] = match
    if (blobId === undefined || name === undefined || sizeText === undefined) throw new Error('Dataset Git entry is incomplete')
    if (name.startsWith('/') || name.includes('\\') || name.split('/').some(part => part === '' || part === '.' || part === '..')) throw new Error('Dataset Git path escapes its repository')
    const size = Number(sizeText)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Dataset Git blob size is invalid')
    const row: (typeof siblings)[number] = { rfilename: name, size, blobId }
    // Git LFS only interprets pointer blobs smaller than 1024 bytes.
    if (size < 1024) {
      const blob = await git(directory, ['cat-file', 'blob', blobId], readBytes, signal)
      if (blob.length !== size) throw new Error('Dataset Git blob length changed')
      const text = blob.toString('utf8')
      if (text.startsWith('version https://git-lfs.github.com/spec/v1\n')) {
        const pointer = /^version https:\/\/git-lfs.github.com\/spec\/v1\n(?:ext-[^\n]+\n)*oid sha256:([a-f0-9]{64})\nsize (\d+)\n?$/.exec(text)
        if (pointer?.[1] === undefined || pointer[2] === undefined || !Number.isSafeInteger(Number(pointer[2]))) throw new Error('Dataset Git LFS pointer is invalid')
        row.lfs = { sha256: pointer[1], size: Number(pointer[2]) }
        row.size = row.lfs.size
      }
    }
    siblings.push(row)
  }
  const result = { id: request.repository, sha: actual, siblings, source: { provider: 'modelscope', method: 'git-commit-tree-v1' } }
  if (siblings.length === 0 || Buffer.byteLength(JSON.stringify(result)) > readBytes) throw new Error('Dataset Git manifest is empty or exceeds configured read bytes')
  return result
}

function repositoryBytes(directory: string): number {
  let bytes = 0
  const pending = [directory]
  while (pending.length) {
    for (const entry of readdirSync(pending.pop()!, { withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else bytes += lstatSync(path).size
    }
  }
  return bytes
}

/**
 * Fetch one official dataset commit into a private, size-monitored metadata repository.
 * @param options - fixed provider identity, metadata limits, polling and the original cancellation.
 * @returns Git-attested metadata; mirror revision parameters are never accepted as evidence.
 */
export async function fetchModelScopeDatasetMetadata(options: { request: Request; readBytes: number; readTimeoutMs: number; pollIntervalMs: number; signal: AbortSignal }): Promise<unknown> {
  const { request, readBytes, readTimeoutMs, pollIntervalMs } = options
  if (request.provider !== 'modelscope' || request.kind !== 'dataset') throw new Error('ModelScope Git metadata supports dataset repositories only')
  const directory = await mkdtemp(join(tmpdir(), 'aspera-dataset-metadata-'))
  const storage = new AbortController()
  const signal = AbortSignal.any([options.signal, storage.signal, AbortSignal.timeout(readTimeoutMs)])
  const timer = setInterval(() => {
    try { if (repositoryBytes(directory) > readBytes) storage.abort(new Error('Dataset Git metadata exceeds configured read bytes')) }
    catch (error) { storage.abort(error) }
  }, pollIntervalMs)
  try {
    await git(directory, ['init', '--bare', '.'], readBytes, signal)
    await git(directory, ['config', 'remote.origin.url', 'https://www.modelscope.cn/datasets/' + request.repository + '.git'], readBytes, signal)
    await git(directory, ['config', 'remote.origin.promisor', 'true'], readBytes, signal)
    await git(directory, ['config', 'remote.origin.partialclonefilter', 'blob:none'], readBytes, signal)
    await git(directory, ['fetch', '--depth=1', '--filter=blob:none', '--no-tags', '--no-recurse-submodules', 'origin', request.revision], readBytes, signal)
    const result = await readGitDatasetManifest({ directory, request, readBytes, signal })
    signal.throwIfAborted()
    if (repositoryBytes(directory) > readBytes) throw new Error('Dataset Git metadata exceeds configured read bytes')
    return result
  } finally {
    clearInterval(timer)
    await rm(directory, { recursive: true, force: true })
  }
}
