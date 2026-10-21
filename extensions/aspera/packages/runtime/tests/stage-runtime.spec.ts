/** Stage launch checks retain the approved parameters and original command identity. */
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { experimentIdSchema, planSchema, stageRegistrationInputSchema } from '@aspera/experiments'
import { StageRegistry } from '../src/stage-runtime.ts'
import { finalizationPolicySchema } from '../src/finalization-policy.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  mkdirSync(resolve('.artifacts'), { recursive: true })
  const root = mkdtempSync(resolve('.artifacts', 'stages-')); roots.push(root)
  const id = experimentIdSchema.parse(randomUUID())
  const request = stageRegistrationInputSchema.parse({ stageId: 'first', serverId: randomUUID(), attemptId: 'attempt1', commandId: 'train', parameters: 'args.json', trainerState: 'state.json', metrics: 'metrics.jsonl' })
  const plan = planSchema.parse({ revision: 1, createdAt: 1, summary: 'Approved two-step smoke', steps: ['Train'], frameworks: [],
    stages: [{ stageId: 'first', title: 'Smoke', planStep: 1, framework: 'transformers', startStep: 0, additionalSteps: 2, endStep: 2,
      metricScope: 'stage', loggingSteps: 1, scheduler: { mode: 'fresh', type: 'linear', learningRate: 0.0001, warmupSteps: 0, totalSteps: 2 } }] })
  const document = { source: { serverId: request.serverId, path: request.parameters, purpose: 'parameters' as const, bytes: 100, generation: 'first', sha256: 'a'.repeat(64) },
    text: JSON.stringify({ max_steps: 2, learning_rate: 0.0001, warmup_steps: 0, lr_scheduler_type: 'linear' }), truncated: false }
  const source = vi.fn(async () => document), command = vi.fn(async (): Promise<undefined> => undefined)
  const create = () => new StageRegistry(root, id, 'execution', { source, command }, finalizationPolicySchema.parse({}))
  return { root, request, plan, document, source, command, create, signal: new AbortController().signal }
}
it('restores an identical registration and refuses changing the approved attempt', async () => {
  const f = fixture(), first = await f.create().register(f.request, f.plan, f.signal)
  expect(await f.create().register(f.request, f.plan, f.signal)).toEqual(first)
  await expect(f.create().register({ ...f.request, attemptId: f.request.stageId }, f.plan, f.signal)).rejects.toThrow('changed')
  await expect(f.create().register(f.request, { ...f.plan, revision: 2 }, f.signal)).rejects.toThrow('changed')
})
it('checks actual parameter values before launch and rejects a later replacement', async () => {
  const f = fixture(), registry = f.create(); await registry.register(f.request, f.plan, f.signal)
  await registry.beforeLaunch(f.request.serverId, 'train', f.signal)
  f.document.source.generation = 'replacement'
  await expect(registry.beforeLaunch(f.request.serverId, 'train', f.signal)).rejects.toThrow('changed')
  await registry.beforeLaunch(f.request.serverId, 'diagnostic', f.signal)
})
it('refuses parameters that lower a target and a source from an unselected path', async () => {
  const f = fixture(); f.document.text = f.document.text.replace('"max_steps":2', '"max_steps":1')
  await expect(f.create().register(f.request, f.plan, f.signal)).rejects.toThrow('horizon')
  f.document.source.path = 'foreign.json'
  await expect(f.create().register(f.request, f.plan, f.signal)).rejects.toThrow('ownership')
})
