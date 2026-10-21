/** Durable task identities retain recovery ownership without retaining the experiment presentation. */
import { randomUUID, createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import { clusterServerSchema, experimentIdSchema } from '@aspera/experiments'
import type { FleetExperiment, PinnedDeployment } from '../src/types.ts'
import { remoteTaskFromExperiment, remoteTaskAsInterruption, remoteTaskRecordSchema, settleRemoteTaskRequestSchema } from '../src/remote-task.ts'

function fixture() {
  const id = experimentIdSchema.parse(randomUUID())
  const server = clusterServerSchema.parse({ id: randomUUID(), name: 'Original node', host: 'cpu.fixture', username: 'trainer',
    remoteRoot: '/owned/control', sshPort: 22, remotePort: 43019, authMode: 'password' })
  const target: PinnedDeployment = { ...server, localRepo: '/local/source', dataRoots: [], tokenRef: 'PRIVATE_TOKEN_REF', agentCredentialRefs: [],
    preparationOutputChars: 65536, toolTimeoutMs: 30000, controlPollIntervalMs: 1000 }
  const experiment = fromAny<FleetExperiment, object>({ request: { experimentId: id, name: 'Retained task', objective: 'Full private objective' },
    coordinator: server, servers: [server], coordinatorTarget: target, targets: [target], createdAt: 1,
    submission: { protocol: 4, experimentId: id, objective: 'Full private objective' } })
  return { id, server, experiment, identity: remoteTaskFromExperiment(experiment)! }
}

it('retains the original digest and node connections while omitting the complete Goal and model settings', () => {
  const f = fixture()
  const saved = remoteTaskRecordSchema.parse(f.identity)
  expect(saved.work.submissionHash).toBe(createHash('sha256').update(JSON.stringify(f.experiment.submission)).digest('hex'))
  expect(saved.work.nodes[0]?.server.id).toBe(f.server.id)
  expect(JSON.stringify(saved)).not.toContain('Full private objective')
  expect(saved).not.toHaveProperty('models'); expect(saved).not.toHaveProperty('submission')
  expect(remoteTaskAsInterruption(saved)).toMatchObject({ request: { experimentId: f.id, name: 'Retained task' }, submissionHash: saved.work.submissionHash })
})

it.each(['duplicate-node', 'missing-coordinator', 'changed-directory', 'missing-digest'] as const)('refuses a durable identity with %s', change => {
  const f = fixture(); const saved = structuredClone(f.identity)
  if (change === 'duplicate-node') saved.work.nodes.push(saved.work.nodes[0]!)
  else if (change === 'missing-coordinator') saved.work.nodes = []
  else if (change === 'changed-directory') saved.work.nodes[0]!.target.remoteRoot = '/other/control'
  else delete saved.work.submissionHash
  expect(remoteTaskRecordSchema.safeParse(saved).success).toBe(false)
})

it('limits the settlement request to one task and an explicit supported intent', () => {
  const f = fixture()
  expect(settleRemoteTaskRequestSchema.parse({ taskId: f.id, mode: 'reconcile' })).toEqual({ taskId: f.id, mode: 'reconcile' })
  for (const input of [{ taskId: f.id, mode: 'force-release' }, { taskId: f.id, mode: 'interrupt', serverId: f.server.id },
    { taskId: f.id, mode: 'interrupt', pid: 1234 }, { taskId: '../another', mode: 'reconcile' }]) {
    expect(settleRemoteTaskRequestSchema.safeParse(input).success).toBe(false)
  }
})
