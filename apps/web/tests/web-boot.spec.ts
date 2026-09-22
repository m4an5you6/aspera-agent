// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'

const boot = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@deepseek-ai/dsh-client-web', () => ({
  AppWebEntry: class { run = boot.run },
}))

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  document.body.replaceChildren()
})

it('starts the Web entry on #root', async () => {
  document.body.innerHTML = '<div id="root"></div>'
  await import('../src/main.ts')
  expect(boot.run).toHaveBeenCalledOnce()
})

it('rejects a document without #root', async () => {
  await expect(import('../src/main.ts')).rejects.toThrow('web app: missing #root')
})
