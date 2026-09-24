import { randomUUID } from 'node:crypto'
import { unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [workspace, outside] = process.argv.slice(2)
if (!workspace || !outside) throw new Error('workspace and outside probe directories are required')
const insideFile = join(workspace, `probe-${randomUUID()}`)
writeFileSync(insideFile, 'ok')
unlinkSync(insideFile)
try {
  writeFileSync(join(outside, `probe-${randomUUID()}`), 'outside')
  throw new Error('sandbox permitted an unauthorized write')
} catch (error) {
  if (error?.code !== 'EROFS' && error?.code !== 'EACCES' && error?.code !== 'EPERM') throw error
}
process.stdout.write('sandbox write probe passed\n')
