/** Real Git object parsing keeps fixed revisions distinct from floating mirror parameters. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { inspectExperimentMaterialsSchema } from '@aspera/experiments'
import { readGitDatasetManifest } from '../src/modelscope-metadata.ts'

const execute = promisify(execFile)
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aspera-git-manifest-test-')); directories.push(directory)
  const git = async (...args: string[]) => (await execute('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-C', directory, ...args], { windowsHide: true })).stdout.trim()
  await git('init')
  const data = '{"sample":"中文"}\n'
  await writeFile(join(directory, 'data.json'), data)
  await writeFile(join(directory, 'large.json'), 'version https://git-lfs.github.com/spec/v1\noid sha256:' + 'a'.repeat(64) + '\nsize 4096\n')
  await git('add', '.')
  await git('commit', '-m', 'fixed dataset')
  const revision = await git('rev-parse', 'HEAD')
  const request = inspectExperimentMaterialsSchema.parse({ kind: 'dataset', provider: 'modelscope', repository: 'fixture/data', revision })
  return { directory, request, readBytes: 65536, signal: new AbortController().signal, git, data }
}

it('reads exact commit, ordinary blob hashes and LFS identities without fetching payloads', async () => {
  const f = await fixture()
  const bytes = Buffer.from(f.data)
  const hash = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex')
  await expect(readGitDatasetManifest(f)).resolves.toMatchObject({ id: 'fixture/data', sha: f.request.revision,
    source: { provider: 'modelscope', method: 'git-commit-tree-v1' }, siblings: [
      { rfilename: 'data.json', size: bytes.length, blobId: hash },
      { rfilename: 'large.json', size: 4096, lfs: { sha256: 'a'.repeat(64), size: 4096 } },
    ] })
})

it('rejects malformed LFS pointers and Git symlink entries', async () => {
  const f = await fixture()
  await writeFile(join(f.directory, 'large.json'), 'version https://git-lfs.github.com/spec/v1\noid sha256:invalid\nsize 4\n')
  await f.git('add', '.'); await f.git('commit', '-m', 'invalid pointer')
  f.request.revision = await f.git('rev-parse', 'HEAD')
  await expect(readGitDatasetManifest(f)).rejects.toThrow(/pointer is invalid/)
  const blob = await f.git('hash-object', 'data.json')
  await f.git('update-index', '--add', '--cacheinfo', '120000,' + blob + ',outside')
  await f.git('commit', '-m', 'link')
  f.request.revision = await f.git('rev-parse', 'HEAD')
  await f.git('rm', 'large.json'); await f.git('commit', '-m', 'remove malformed pointer')
  f.request.revision = await f.git('rev-parse', 'HEAD')
  await expect(readGitDatasetManifest(f)).rejects.toThrow(/symlink/)
})

it('refuses unavailable commits, bounded-output overflow and cancelled reads', async () => {
  const f = await fixture()
  await expect(readGitDatasetManifest({ ...f, request: { ...f.request, revision: 'f'.repeat(40) } })).rejects.toThrow()
  await expect(readGitDatasetManifest({ ...f, readBytes: 8 })).rejects.toThrow()
  await expect(readGitDatasetManifest({ ...f, signal: AbortSignal.abort() })).rejects.toThrow()
})
