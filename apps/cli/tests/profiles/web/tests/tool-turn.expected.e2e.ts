/** Source-path regression after a build, with the published Web entry as a control. Requires `pnpm run build`. */

import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { PROCESS_SHUTDOWN_TIMEOUT_MS } from '../../../../src/process-shutdown.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const marker = 'WEB_TOOL_ROUND_TRIP'

interface TurnReply {
  events: SessionEvent[]
  output?: string
  error?: string
}

describe.each(['src', 'lib'] as const)('Web %s tool execution after building', (mode) => {
  it('reads a file through the CLI entry', async (test) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-tool-turn-'))
    const removeRoot = (): Promise<void> => rm(root, { recursive: true, force: true, maxRetries: 3 })
    test.onTestFinished(removeRoot)
    const filePath = join(root, 'fixture.txt')
    const patch = join(root, 'tool-turn.patch.yml')
    await writeFile(filePath, `${marker}\n`)
    await writeFile(patch, JSON.stringify([
      { id: 'llm-deepseek', disabled: true },
      { id: 'agent-instructions', disabled: true },
      { id: 'tools', config: { mode: 'native' } },
      { id: 'tool-fs', disabled: false },
      { id: 'agent-loop', config: { agents: [{ id: 'main', provider: 'web-tool-turn', model: 'read', cwd: root }] } },
      { id: 'session-persistence-jsonl', config: { root: join(root, 'sessions') } },
      { insert: [{
        id: 'web-tool-turn',
        name: new URL('./fixtures/tool-turn.mjs', import.meta.url).href,
        config: { filePath },
      }] },
    ]) + '\n')
    const launch = resolveExampleLaunch({
      srcBin: join(repoRoot, 'apps/cli/src/bin.ts'),
      mode,
      sourceImport: 'tsx/esm',
      tsconfigPath: join(repoRoot, 'tsconfig.json'),
      configArgs: ['web', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'],
      env: {
        NODE_OPTIONS: undefined,
        NODE_PATH: undefined,
        TSX_TSCONFIG_PATH: undefined,
        DSH_HOME: join(root, 'home'),
        DSH_AGENTS_HOME: join(root, '.agents'),
        DSH_TELEMETRY_DISABLED: '1',
        NODE_NO_WARNINGS: '1',
      },
    })
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !/(?:KEY|TOKEN|SECRET|PASSWORD)/iu.test(key)))
    test.signal.throwIfAborted()
    const child = spawn(launch.command, launch.args, {
      cwd: repoRoot,
      env: { ...environment, ...launch.env },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    })
    const reply = Promise.withResolvers<TurnReply>()
    const completion = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>()
    let output = ''
    let ready = false
    let exited = false
    let forced = false
    const diagnostic = (): string => output.replace(/([?&]token=)[^\s)]+/gu, '$1<redacted>')
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk
      if (ready || !output.includes('dsh web: http')) return
      ready = true
      child.send('turn', (error: Error | null) => { if (error) reply.reject(error) })
    })
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
    child.once('error', (error) => { reply.reject(error) })
    child.once('close', (code, signal) => {
      exited = true
      completion.resolve({ code, signal })
      reply.reject(new Error(`Web exited before returning its tool result:\n${diagnostic()}`))
    })
    child.once('message', (message: TurnReply) => { reply.resolve(message) })
    let closing: Promise<Awaited<typeof completion.promise>> | undefined
    const close = (): Promise<Awaited<typeof completion.promise>> => closing ??= (async () => {
      const force = (): void => {
        if (exited) return
        forced = true
        child.kill('SIGKILL')
      }
      const watchdog = setTimeout(force, PROCESS_SHUTDOWN_TIMEOUT_MS * 2)
      try {
        if (!exited && child.connected) child.send('stop', (error: Error | null) => { if (error) force() })
        return await completion.promise
      } finally { clearTimeout(watchdog) }
    })()
    const abort = (): void => {
      reply.reject(new Error('Web tool test cancelled', { cause: test.signal.reason }))
      void close()
    }
    test.signal.addEventListener('abort', abort, { once: true })
    test.onTestFinished(async () => { await close() })
    try {
      const result = await reply.promise
      expect(result.error, diagnostic()).toBeUndefined()
      const calls = result.events.filter(event => event.type === 'tool/call')
      const results = result.events.filter(event => event.type === 'tool/result')
      expect(calls.map(event => event.data.name)).toEqual(['read'])
      expect(results, JSON.stringify(result.events)).toHaveLength(1)
      expect(JSON.stringify(results[0])).toContain(marker)
      expect(results[0]?.data.error).toBeUndefined()
      expect(result.output).toContain(marker)
      expect(result.events.find(event => event.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'completed' } })
      expect(await readFile(filePath, 'utf8')).toBe(`${marker}\n`)
    } finally {
      const result = await close()
      test.signal.removeEventListener('abort', abort)
      expect(test.signal.aborted, diagnostic()).toBe(false)
      expect(forced, diagnostic()).toBe(false)
      expect(result.signal, diagnostic()).toBeNull()
      expect(result.code, diagnostic()).toBe(0)
    }
  })
})
