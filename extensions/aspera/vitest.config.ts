/** Source tests use explicit local package entrypoints; artifact smokes use packed dependencies. */
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const source = (name: string, file: string) => fileURLToPath(new URL(`./packages/${name}/src/${file}`, import.meta.url))
export default defineConfig({
  resolve: { alias: [
    { find: '@aspera/runtime/transport', replacement: source('runtime', 'transport.ts') },
    { find: '@aspera/runtime/types', replacement: source('runtime', 'types.ts') },
    { find: '@aspera/experiments/types', replacement: source('experiments', 'types.ts') },
    { find: '@aspera/dispatch/types', replacement: source('dispatch', 'types.ts') },
    { find: '@aspera/experiments', replacement: source('experiments', 'index.ts') },
    { find: '@aspera/runtime', replacement: source('runtime', 'index.ts') },
    { find: '@aspera/dispatch', replacement: source('dispatch', 'index.ts') },
  ] },
  test: { include: ['packages/**/tests/**/*.spec.ts', 'apps/**/tests/**/*.spec.ts'], testTimeout: 30000, hookTimeout: 30000 },
})
