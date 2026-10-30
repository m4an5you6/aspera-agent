/** Verify immutable submitted input identities before skipping or publishing SSH uploads. */
import { z } from 'zod'
import type { ClusterSubmission, StoragePlacement } from '@aspera/experiments'
import { shellQuote } from './transport.ts'
import type { copy, remote, Target } from './transport.ts'

const inspect = `import sys,json,os,stat,hashlib
r=json.load(sys.stdin)
assert r['name'] not in ('.','..') and '/' not in r['name'] and chr(92) not in r['name'], 'Input name escaped its directory'
root=r['runRoot']
with open(root+'/.aspera-owner.json') as f: owner=json.load(f)
assert owner=={'version':1,'serverId':r['serverId'],'experimentId':r['experimentId']}, 'Input owner differs'
directory=os.open(root+'/inputs',os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 try: fd=os.open(r['name'],os.O_RDONLY|os.O_NOFOLLOW,dir_fd=directory)
 except FileNotFoundError: print(json.dumps({'complete':False}));sys.exit(0)
 try:
  before=os.fstat(fd)
  assert stat.S_ISREG(before.st_mode) and before.st_nlink==1, 'Input is not an independent regular file'
  value=hashlib.sha256()
  if before.st_size==r['size']:
   while True:
    block=os.read(fd,1024*1024)
    if not block:break
    value.update(block)
  after=os.fstat(fd)
  assert (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns), 'Input changed while verifying'
  entry=os.stat(r['name'],dir_fd=directory,follow_symlinks=False)
  assert (entry.st_dev,entry.st_ino)==(after.st_dev,after.st_ino), 'Input path changed while verifying'
  print(json.dumps({'complete':before.st_size==r['size'] and value.hexdigest()==r['sha256']}))
 finally: os.close(fd)
finally: os.close(directory)
`

/**
 * Skip a complete matching input; incomplete files remain unpublished until full digest verification.
 * @param driver - authenticated SSH transport.
 * @param target - selected coordinator with the resolved transfer deadline.
 * @param placement - program-owned run and server identity.
 * @param localPath - immutable submitted local input.
 * @param file - submitted name, size and digest.
 * @param signal - shared transfer-batch cancellation and deadline.
 * @param password - operation-only account credential.
 * @returns after the remote file matches its complete submitted digest.
 */
export async function transferExperimentInput(driver: { remote: typeof remote; copy: typeof copy }, target: Target,
  placement: StoragePlacement, localPath: string, file: ClusterSubmission['inputs'][number] & { size: number }, signal: AbortSignal, password?: string): Promise<void> {
  const input = JSON.stringify({ runRoot: placement.runRoot, serverId: placement.serverId, experimentId: placement.experimentId,
    name: file.name, size: file.size, sha256: file.sha256 })
  const command = `python3 -c ${shellQuote(inspect)}`
  const verified = async () => z.object({ complete: z.boolean() }).strict().parse(JSON.parse(await driver.remote(target, command, signal, password, input))).complete
  if (await verified()) return
  await driver.copy(target, localPath, `${placement.runRoot}/inputs/${file.name}`, signal, password)
  if (!await verified()) throw new Error(`Transferred input does not match its submitted digest: ${file.name}`)
}
