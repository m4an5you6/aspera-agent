/** Browser factory framing and CSS compatibility for the pinned DSH module loader. */
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig } from 'tsdown'

const ID = '@aspera/console'

/** Copied from PLATFORM_MODULES in packages/client/web/src/platform.ts at dsh-v0.2.0-rc.2. */
const PLATFORM_MODULES = new Set<string>([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

export default defineConfig({
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  tsconfig: 'tsconfig.client.json',
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  plugins: [{ name: 'aspera-css', resolveId(source, importer) {
    if (source.endsWith('.module.css') && importer !== undefined) return '\0aspera-css:' + resolve(dirname(importer), source) + '.mjs'
  }, load(id) {
    if (!id.startsWith('\0aspera-css:')) return
    const path = id.slice('\0aspera-css:'.length, -4)
    this.addWatchFile(path)
    const result = transform({ filename: path, code: readFileSync(path), cssModules: true, minify: true })
    const classes = Object.fromEntries(Object.entries(result.exports ?? {}).map(([key, value]) => [key, value.name]))
    return `export const cssText = ${JSON.stringify(result.code.toString())}; export default ${JSON.stringify(classes)};`
  } }],
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => PLATFORM_MODULES.has(specifier),
    alwaysBundle: (specifier: string) => !PLATFORM_MODULES.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    chunkFileNames: 'client.[name].js',
    banner: chunk => `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, ${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
