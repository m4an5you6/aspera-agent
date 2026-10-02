/** Page typography stays independent of the browser's unstyled body and native form defaults. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/ExperimentsPage.module.css', import.meta.url), 'utf8')

it('assigns the shared text and heading fonts when the containing document has no body font', () => {
  const root = /^\.page\s*\{([^}]*)\}/m.exec(css)?.[1] ?? ''
  const heading = /^\.header h1\s*\{([^}]*)\}/m.exec(css)?.[1] ?? ''
  expect(root).toContain('font: var(--dsw-font-xs-13)')
  expect(heading).toContain('font: var(--dsw-font-l-20)')
  expect(css).not.toMatch(/font-family:\s*monospace\b/)
})

it('keeps form placement rules off the shared checkbox label', () => {
  expect(css).not.toMatch(/\.form\s+label\s*[,\{]/)
  expect(css).toMatch(/\.form\s*>\s*label/)
  expect(css).toMatch(/\.fields\s*>\s*label/)
})

it('keeps flat neutral borders at the shared hairline width', () => {
  const widths = [...css.matchAll(/border(?:-(?:top|right|bottom|left))?:\s*([\d.]+)px solid var\(--dsw-alias-border-/g)]
  expect(widths.length).toBeGreaterThan(0)
  for (const match of widths) expect(Number(match[1])).toBe(0.5)
})
