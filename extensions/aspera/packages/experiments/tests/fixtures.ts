import { experimentModelSnapshotsSchema } from '../src/models.ts'
/** CPU inventory for source tests; it never claims a real disk or GPU was probed. */
import { createHash } from 'node:crypto'
import { serverInventorySchema, storagePlacementSchema } from '../src/storage-protocol.ts'
import type { ExperimentId, ExperimentServerId } from '../src/cluster-protocol.ts'

/** @param directory - observed path. @returns deterministic CPU inventory. */
export function inventory(directory = '/data') {
  const mount = { mountPoint: directory, root: '/', source: '/dev/fixture', filesystem: 'ext4', device: '8:1' }
  return serverInventorySchema.parse({ observedAt: 1, home: '/home/trainer', candidates: [{
    id: createHash('sha256').update(JSON.stringify({ directory, mount })).digest('hex'), directory, mount,
    availableBytes: 20_000_000_000, totalBytes: 40_000_000_000, writable: true, systemVolume: false, persistence: 'unknown',
  }], addresses: [{ interface: 'eth0', address: '10.0.0.1', family: 'IPv4', private: true }], routes: [] })
}

/** @param serverId - owner. @param experimentId - experiment. @param root - legacy fixture root. @param digest - release. @returns recorded fixture placement. */
export function placement(serverId: ExperimentServerId, experimentId: ExperimentId, root: string, digest = 'a'.repeat(64)) {
  return storagePlacementSchema.parse({ version: 1, layout: 'legacy', serverId, experimentId, candidate: inventory(root).candidates[0],
    controlRoot: root, namespaceRoot: root, releaseRoot: `${root}/releases/${digest}`, runRoot: `${root}/runs/${experimentId}`,
    workspaceRoot: `${root}/runs/${experimentId}/workspace`, reason: 'Explicit fixture storage', minimumFreeBytes: 1024 })
}

/** Explicit selections shared by local test records. */
export const modelSelections = {
  preparation: { provider: 'test', model: 'test-model' },
  planning: { provider: 'test', model: 'test-model' },
  execution: { provider: 'test', model: 'test-model' },
}
/** @returns public snapshot fields; runtime tests install their own private credential values. */
export function modelSnapshots() {
  return experimentModelSnapshotsSchema.parse(Object.fromEntries(Object.entries(modelSelections).map(([phase, selection]) => [phase, {
    ...selection, adapter: 'pi-ai', adapterVersion: '0.2.0-rc.2', api: 'openai-completions',
    baseURL: 'http://127.0.0.1:9/v1', configurationRef: `ASPERA_MODEL_TEST_${phase.toUpperCase()}`, configurationHash: 'a'.repeat(64),
  }])))
}
