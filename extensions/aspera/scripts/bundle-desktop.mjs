/** Sandboxed Electron preloads must have a single CommonJS artifact. */
import { build } from 'tsdown'
import { resolve } from 'node:path'
const application = resolve(import.meta.dirname, '../apps/desktop')
await build({ entry: { preload: resolve(application, 'src/preload.ts') }, outDir: resolve(application, 'lib'),
  format: 'cjs', platform: 'node', external: ['electron'], clean: false, sourcemap: false })
