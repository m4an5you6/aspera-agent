import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import { experimentHealthSchema } from '../src/protocol.ts'
import type { ExperimentRecord, ExperimentSubmission } from '../src/protocol.ts'

it('authenticates the loopback receiver and returns one durable receipt for duplicate HTTP submissions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-experiment-http-'))
  const tokenFile = join(root, 'receiver.token')
  const token = 'test-' + 'a'.repeat(64)
  writeFileSync(tokenFile, token)
  const records = new Map<string, ExperimentRecord>()
  const create = vi.fn(async () => ({
    agent: {
      session: { id: 'session' }, followup: vi.fn(), cancel: vi.fn(), whenIdle: async () => {},
    },
    dispose: async () => {},
  }))
  const ctx = new Context()
  try {
    ctx.provide('agents', { create } as never)
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'test', model: 'test' }) } as never)
    ctx.provide('goals', { create: () => ({ id: 'goal-1' }), get: () => ({ phase: 'active' }) } as never)
    ctx.provide('sessions', { flush: async () => true } as never)
    ctx.provide('storageDomain', {
      open: async () => ({
        table: () => ({
          get: (id: string) => records.get(id),
          put: async (id: string, record: ExperimentRecord) => { records.set(id, record) },
          entries: () => records.entries(),
        }),
        close: async () => {},
      }),
    } as never)
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    const deploymentId = 'b'.repeat(64)
    await apply(ctx, {
      workspaceRoot: root, tokenFile, logFile: join(root, 'worker.log'), deploymentId,
      devicePaths: ['/dev/nvidia1'],
    })
    const url = `http://127.0.0.1:${ctx.webServer.port}/experiment/v1`
    expect((await fetch(`${url}/health`)).status).toBe(401)
    const health = () => fetch(`${url}/health`, { headers: { authorization: `Bearer ${token}` } })
    expect(experimentHealthSchema.parse(await (await health()).json())).toEqual({ deploymentId, ready: true, busy: false })
    const submission: ExperimentSubmission = {
      submissionId: 'a'.repeat(64), deploymentId,
      spec: { objective: 'train', datasetRefs: [], constraints: [], outputPath: 'artifacts/run' },
    }
    const send = () => fetch(`${url}/submit`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(submission),
    })
    const [first, repeated] = await Promise.all([send(), send()])
    expect(first.status).toBe(200)
    expect(repeated.status).toBe(200)
    expect(await repeated.json()).toEqual(await first.json())
    expect(create).toHaveBeenCalledOnce()
    expect(experimentHealthSchema.parse(await (await health()).json())).toEqual({ deploymentId, ready: true, busy: true })
    mkdirSync(join(root, 'artifacts', 'run'), { recursive: true })
    writeFileSync(join(root, 'artifacts', 'run', 'model.bin'), 'trained')
    writeFileSync(join(root, 'worker.log'), 'running')
    const status = await fetch(`${url}/status/${submission.submissionId}`, { headers: { authorization: `Bearer ${token}` } })
    expect(status.status).toBe(200)
    expect(await status.json()).toMatchObject({
      state: 'accepted', goalId: 'goal-1', workerLogAvailable: true,
      artifactFiles: [{ path: 'model.bin', sizeBytes: 7 }], artifactListTruncated: false,
    })
    const accepted = records.get(submission.submissionId)
    if (accepted === undefined) throw new Error('accepted receipt missing')
    records.set(submission.submissionId, { ...accepted, state: 'complete' })
    const afterCompletion = await send()
    expect(afterCompletion.status).toBe(200)
    expect(await afterCompletion.json()).toMatchObject({ state: 'complete', goalId: 'goal-1' })
    expect(create).toHaveBeenCalledOnce()
  } finally {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
