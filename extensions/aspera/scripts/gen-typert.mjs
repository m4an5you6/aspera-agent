/**
 * Runs the pinned Typert generator against this workspace's Host
 * aggregate (tsconfig.host.json) and writes each contributor's artifacts to its
 * lib/ directory, mirroring what upstream's tsdown plugin does in-tree.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(import.meta.dirname, '..')
const generator = new WorkspaceTypertGenerator(root, { checkDiagnostics: true })
const artifacts = generator.generate(undefined, ['host'])
if (artifacts.length === 0) throw new Error('typert: no contributor packages were discovered')

for (const artifact of artifacts) {
  const output = join(root, artifact.packageRoot, 'lib')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, `typert.${artifact.face}.js`), artifact.js)
  writeFileSync(join(output, `typert.${artifact.face}.d.ts`), artifact.dts)
  const written = [`typert.${artifact.face}.js`, `typert.${artifact.face}.d.ts`]
  if (artifact.remote !== undefined) {
    writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js)
    writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
    writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
    written.push('typert.remote-client.js', 'typert.remote-client.d.ts')
  }
  console.log(`typert: ${artifact.package} (${artifact.face}) -> ${written.join(', ')}`)
}
