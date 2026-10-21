/** Historical grants preserve source ownership while capacity and material inputs stay explicit. */
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, linkSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { borrowedEnvironmentSchema, assessExperimentStorageSchema, inspectExperimentMaterialsSchema, experimentStoragePlanSchema } from '@aspera/experiments'
import { assertStorageSourceAvailable, readBorrowedEnvironments, materialReadonlyPaths, storageGovernancePolicySchema } from '../src/storage-governance.ts'
import { managedEnvironmentMounts, managedEnvironmentPolicySchema, managedEnvironmentPolicyForRelease } from '../src/managed-environment.ts'
import { experimentSandboxArgv } from '../src/experiment-sandbox.ts'
import { inspectStorage } from '../scripts/storage.mjs'

vi.mock('../scripts/storage.mjs', () => ({ inspectStorage: ({ directory }: { directory: string }) => ({ candidates: [{ directory,
  mount: { source: 'fixture-volume', filesystem: 'ext4', mountPoint: 'fixture-mount' } }] }) }))

const base = resolve('.artifacts'); mkdirSync(base, { recursive: true })
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (dirname(root) !== base) throw new Error('Storage fixture cleanup escaped its workspace')
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(resolve(base, 'storage-governance-')); roots.push(root)
  const serverId = randomUUID(), experimentId = randomUUID(), sourceExperimentId = randomUUID()
  const source = resolve(root, 'runs', sourceExperimentId), run = resolve(root, 'runs', experimentId)
  const directory = resolve(source, 'workspace/pyenv'), workspace = resolve(run, 'workspace')
  const lease = resolve(root, 'state/storage-governance-v1/environment-leases', experimentId + '-training.json')
  for (const path of [directory, workspace, dirname(lease), resolve(run, 'environment-borrowings-v1')]) mkdirSync(path, { recursive: true })
  for (const [path, id] of [[source, sourceExperimentId], [run, experimentId]]) writeFileSync(resolve(path!, '.aspera-owner.json'), JSON.stringify({ version: 1, experimentId: id, serverId }))
  const file = resolve(directory, 'package.py'); writeFileSync(file, 'value=1\n')
  const observed = statSync(file, { bigint: true })
  const python = resolve(directory, 'bin/python'); mkdirSync(dirname(python), { recursive: true }); writeFileSync(python, 'fixture interpreter')
  const pythonStat = statSync(python, { bigint: true })
  const mount = inspectStorage({ directory }).candidates.find(row => row.directory === directory)!.mount
  const value = borrowedEnvironmentSchema.parse({ version: 1, experimentId, serverId, deploymentId: 'a'.repeat(64), environmentId: 'training',
    operationId: randomUUID(), candidateId: 'b'.repeat(64), mode: 'borrowed-readonly', sourceExperimentId, sourceRunRoot: source,
    directory, python: resolve(directory, 'bin/python'), pythonVersion: '3.10', pythonAbi: 'cpython-310', sourceHash: 'c'.repeat(64),
    links: [], interpreter: { path: python, hash: createHash('sha256').update(readFileSync(python)).digest('hex'), size: Number(pythonStat.size),
      mtimeNs: pythonStat.mtimeNs.toString(), ctimeNs: pythonStat.ctimeNs.toString() },
    volume: { source: mount.source, filesystem: mount.filesystem, directory: mount.mountPoint },
    files: [{ path: 'package.py', hash: createHash('sha256').update(readFileSync(file)).digest('hex'), size: Number(observed.size),
      mtimeNs: observed.mtimeNs.toString(), ctimeNs: observed.ctimeNs.toString() }], requirements: ['torch==2.14.1'], modules: ['torch'],
    cuda: true, verified: true, checkedAt: 1, lease, readonlyPaths: [directory] })
  const path = resolve(run, 'environment-borrowings-v1/training.json')
  writeFileSync(lease, JSON.stringify(value)); writeFileSync(path, JSON.stringify(value))
  return { root, run, source, workspace, directory, file, value, path, lease }
}

it('mounts a released historical grant without exposing the source workspace or changing its bytes', () => {
  const f = fixture(); const before = readFileSync(f.file)
  const mounts = managedEnvironmentMounts(f.run, f.workspace)
  expect(mounts.python).toBe(f.value.python)
  expect(mounts.readonlyPaths).toEqual([f.directory]); expect(mounts.writablePaths).toEqual([])
  const argv = experimentSandboxArgv({ backendPath: '/usr/bin/bwrap', workspaceRoot: f.workspace, devicePaths: [], hiddenPaths: [f.root], environment: mounts }, ['true'])
  expect(argv.slice(argv.indexOf('--ro-bind', 4) + 1)).toContain(f.directory)
  expect(mounts.readonlyPaths).not.toContain(resolve(f.source, 'workspace'))
  expect(readFileSync(f.file)).toEqual(before)
})
it('blocks commands, mutation and deletion of a retained source even after the consumer finishes', () => {
  const f = fixture()
  expect(() => assertStorageSourceAvailable(f.root, f.value.sourceExperimentId)).toThrow(/borrowed read-only/)
  expect(() => assertStorageSourceAvailable(f.root, f.value.experimentId)).not.toThrow()
})
it('rejects a missing lease, changed source owner, escaped file and modified installed payload', () => {
  for (const change of ['lease', 'owner', 'escape', 'bytes']) {
    const f = fixture()
    if (change === 'lease') rmSync(f.lease)
    if (change === 'owner') writeFileSync(resolve(f.source, '.aspera-owner.json'), JSON.stringify({ version: 1, serverId: randomUUID(), experimentId: f.value.sourceExperimentId }))
    if (change === 'bytes') writeFileSync(f.file, 'value=2\n')
    if (change === 'escape') {
      const value = { ...f.value, files: [{ ...f.value.files[0], path: '../outside' }] }
      writeFileSync(f.path, JSON.stringify(value)); writeFileSync(f.lease, JSON.stringify(value))
    }
    expect(() => readBorrowedEnvironments(f.run), change).toThrow()
  }
})
it('keeps unknown capacity pending and requires explicit immutable revisions and output budgets', () => {
  const request = assessExperimentStorageSchema.parse({ operationId: randomUUID(), outputBytes: 0, checkpointBytes: 0 })
  expect(request.environmentId).toBe('training')
  expect(assessExperimentStorageSchema.safeParse({ operationId: randomUUID() }).success).toBe(false)
  expect(inspectExperimentMaterialsSchema.safeParse({ kind: 'model', provider: 'huggingface', repository: 'Qwen/Qwen3.5-9B', revision: 'main' }).success).toBe(false)
  const plan = experimentStoragePlanSchema.parse({ version: 1, experimentId: randomUUID(), serverId: randomUUID(), operationId: randomUUID(), requestHash: 'a'.repeat(64), checkedAt: 1,
    state: 'requirements-pending', environmentId: 'training', requirements: ['torch'], materialIds: [], detail: 'Dependency peak is not known',
    volumes: [{ directory: '/', availableBytes: 1667948544, reservedBytes: 0, requiredBytes: null, missingBytes: 19329394438,
      environmentBytes: null, outputBytes: 0, checkpointBytes: 0, safetyBytes: 1073741824 }] })
  expect(plan.volumes[0]!.requiredBytes).toBeNull()
})
it('does not project storage settings into an original installer release', () => {
  const policy = managedEnvironmentPolicySchema.parse({ governance: storageGovernancePolicySchema.parse({}) })
  expect(managedEnvironmentPolicyForRelease(policy, true).governance).toBeUndefined()
  expect(managedEnvironmentPolicyForRelease(policy, true, true).governance).not.toHaveProperty('systemReserveBytes')
  expect(managedEnvironmentPolicyForRelease(policy, true, true, true).governance).toEqual(policy.governance)
})

it('accepts a program-recorded hard-link stamp without rewriting a prior material publication and rejects later content changes', () => {
  const f = fixture(), id = 'e'.repeat(64), directory = resolve(f.root, 'assets-v1/models', id)
  mkdirSync(directory, { recursive: true })
  const file = resolve(directory, 'weights'); writeFileSync(file, 'verified tiny weights')
  const stat = statSync(file, { bigint: true }), hash = createHash('sha256').update(readFileSync(file)).digest('hex')
  const row = { path: 'weights', bytes: Number(stat.size), algorithm: 'sha256', hash, url: 'https://huggingface.co/fixture', mtimeNs: stat.mtimeNs.toString(), ctimeNs: '0' }
  const material = { version: 1, id, serverId: f.value.serverId, kind: 'model', provider: 'huggingface', repository: 'fixture/model', revision: 'a'.repeat(40),
    files: [row], directory, totalBytes: row.bytes, missingBytes: 0, verifiedBytes: row.bytes, checkedAt: 1, state: 'ready',
    volume: { source: 'fixture-volume', filesystem: 'ext4', directory: 'fixture-mount' } }
  const publication = resolve(f.root, 'state/storage-governance-v1/material-publications', id + '.json')
  for (const folder of [dirname(publication), resolve(f.root, 'state/storage-governance-v1/materials'), resolve(f.run, 'material-bindings-v1')]) mkdirSync(folder, { recursive: true })
  writeFileSync(publication, JSON.stringify(material))
  writeFileSync(resolve(f.root, 'state/storage-governance-v1/materials', id + '.json'), JSON.stringify(material))
  writeFileSync(resolve(f.run, 'material-bindings-v1', id + '.json'), JSON.stringify({ version: 1, experimentId: f.value.experimentId, serverId: f.value.serverId, materialId: id,
    directory, manifestHash: createHash('sha256').update(readFileSync(publication)).digest('hex'), readonly: true, checkedAt: 1 }))
  const before = readFileSync(publication)
  expect(() => materialReadonlyPaths(f.run, f.root)).toThrow(/identity changed/)
  const alias = resolve(directory, 'linked-weights'); linkSync(file, alias)
  const linked = statSync(alias, { bigint: true })
  const key = createHash('sha256').update(JSON.stringify([row.algorithm, hash, row.bytes])).digest('hex')
  const proof = resolve(f.root, 'state/storage-governance-v1/file-objects', key + '.json'); mkdirSync(dirname(proof), { recursive: true })
  writeFileSync(proof, JSON.stringify({ version: 1, serverId: f.value.serverId, materialId: id, path: alias, relativePath: 'linked-weights', algorithm: row.algorithm,
    hash, bytes: row.bytes, mtimeNs: linked.mtimeNs.toString(), ctimeNs: linked.ctimeNs.toString() }))
  expect(materialReadonlyPaths(f.run, f.root)).toEqual([directory]); expect(readFileSync(publication)).toEqual(before)
  writeFileSync(file, 'changed unverified weights')
  expect(() => materialReadonlyPaths(f.run, f.root)).toThrow(/identity changed/)
})
