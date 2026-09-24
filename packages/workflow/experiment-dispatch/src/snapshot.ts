/** Source snapshot and content digest, including local tracked and untracked edits. */
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { copyFileSync, createReadStream, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { run } from './transport.ts'

const execFileAsync = promisify(execFile)
const EXCLUDED = [
  /(?:^|\/)(?:node_modules(?:\.backup-[^/]*)?|lib|dist|build|data|datasets|artifacts|runs|logs)(?:\/|$)/i,
  /(?:^|\/)(?:results|checkpoints|outputs|wandb|training-runs|secrets|\.cache|\.git|\.ssh|\.aws|\.kube)(?:\/|$)/i,
  /(?:^|\/)(?:\.env(?:\..*)?|\.credentials(?:\..*)?|\.npmrc|\.pypirc|__pycache__)(?:\/|$)/i,
  /\.(?:pem|key|p12|pfx|token|safetensors|pt|pth|ckpt|parquet|arrow|h5|hdf5|npy|npz|sqlite|db)$/i,
]

/** Private temporary archive and its content-addressed deployment identity. */
export interface SourceSnapshot {
  readonly directory: string
  readonly archive: string
  readonly digest: string
  readonly archiveHash: string
  dispose(): void
}

/**
 * Snapshot only regular repository files without following link targets.
 * @param root - local checkout to package.
 * @param timeoutMs - configured maximum lifetime of enumeration and archive processes.
 * @param signal - aborts enumeration and archive creation.
 * @returns a private archive and its digest; the caller disposes it.
 */
export async function snapshotSource(root: string, timeoutMs: number, signal?: AbortSignal): Promise<SourceSnapshot> {
  if (!isAbsolute(root)) throw new Error('local repository path must be absolute')
  const repo = resolve(root)
  const { stdout } = await execFileAsync('git', [
    '-c', `safe.directory=${repo.replaceAll('\\', '/')}`, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--exclude=node_modules.backup-*',
  ], { cwd: repo, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer', timeout: timeoutMs, signal })
  const names = Buffer.from(stdout).toString('utf8').split('\0').filter(Boolean).sort()
  const files: string[] = []
  for (const name of names) {
    const posix = name.replaceAll('\\', '/')
    if (posix.includes('\n') || posix.includes('\r') || isAbsolute(name)
      || posix.split('/').includes('..') || EXCLUDED.some(pattern => pattern.test(posix))) continue
    const path = resolve(repo, name)
    if (!path.startsWith(repo + sep)) continue
    try {
      if (lstatSync(path).isFile()) files.push(posix)
    } catch (error: unknown) {
      // A tracked file deleted locally is absent from the current snapshot.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  if (!files.includes('pnpm-lock.yaml') || !files.includes('apps/cli/package.json')) {
    throw new Error('source snapshot lacks the lockfile or dsh application')
  }
  const directory = mkdtempSync(join(tmpdir(), 'dsh-experiment-snapshot-'))
  const source = join(directory, 'source')
  const archive = join(directory, `source-${randomUUID()}.tar`)
  try {
    mkdirSync(source)
    const hash = createHash('sha256')
    for (const name of files) {
      signal?.throwIfAborted()
      const staged = join(source, name)
      mkdirSync(dirname(staged), { recursive: true })
      copyFileSync(join(repo, name), staged)
      hash.update(name + '\0')
      for await (const chunk of createReadStream(staged)) hash.update(chunk as Buffer)
      hash.update('\0')
    }
    const list = join(directory, 'files.txt')
    writeFileSync(list, files.join('\n') + '\n', { mode: 0o600 })
    await run('tar', ['-cf', archive, '-C', source, '-T', list], timeoutMs, signal)
    const archiveDigest = createHash('sha256')
    for await (const chunk of createReadStream(archive)) archiveDigest.update(chunk as Buffer)
    const archiveHash = archiveDigest.digest('hex')
    return {
      directory, archive, digest: hash.digest('hex'), archiveHash,
      dispose() { rmSync(directory, { recursive: true, force: true }) },
    }
  } catch (error: unknown) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
