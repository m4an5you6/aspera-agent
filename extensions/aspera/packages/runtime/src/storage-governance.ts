/** Validated bounds and durable read-only mounts for server-owned storage records. */
import { existsSync, readFileSync, readdirSync, lstatSync, statSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, dirname, relative, isAbsolute, sep } from 'node:path'
import { z } from 'zod'
import s from '@deepseek-ai/schemastery'
import { borrowedEnvironmentSchema, experimentMaterialBindingSchema, experimentMaterialSchema, storageArrangementSchema } from '@aspera/experiments'
import type { BorrowedEnvironment, ExperimentMaterial } from '@aspera/experiments'
import { inspectStorage } from '../scripts/storage.mjs'

/** @param runRoot - original run. @param workspace - original data workspace. @param controlRoot - trusted node control root.
 * @returns a separately registered training workspace after owner and filesystem verification, or the original workspace.
 */
export function managedTrainingWorkspace(runRoot: string, workspace: string, controlRoot?: string): string {
  const path = resolve(runRoot, 'storage-arrangement.v1.json')
  if (!existsSync(path)) return workspace
  const value = storageArrangementSchema.parse(readOwned(path))
  if (controlRoot === undefined || resolve(value.controlRoot) !== resolve(controlRoot) || resolve(value.dataWorkspace) !== resolve(workspace)
    || resolve(value.environmentNamespace) !== resolve(controlRoot, 'training-storage-v1')
    || resolve(value.environmentWorkspace) !== resolve(value.environmentNamespace, 'runs', value.experimentId, 'workspace')) throw new Error('Training placement escaped its registered root')
  const owner = z.object({ version: z.literal(1), experimentId: z.string(), serverId: z.string() }).strict().parse(readOwned(resolve(runRoot, '.aspera-owner.json')))
  const target = z.object({ version: z.literal(1), experimentId: z.string(), serverId: z.string() }).strict().parse(readOwned(resolve(value.environmentWorkspace, '..', '.aspera-owner.json')))
  const namespace = z.object({ version: z.literal(1), serverId: z.string(), kind: z.literal('storage') }).strict().parse(readOwned(resolve(value.environmentNamespace, '.aspera-owner.json')))
  if (value.experimentId !== owner.experimentId || value.serverId !== owner.serverId || target.experimentId !== owner.experimentId || target.serverId !== owner.serverId || namespace.serverId !== owner.serverId) throw new Error('Training placement belongs to another experiment')
  checkAncestors(value.environmentWorkspace)
  const mount = inspectStorage({ directory: value.environmentWorkspace }).candidates.find(row => row.directory === value.environmentWorkspace)?.mount
  if (mount?.source !== value.volume.source || mount.filesystem !== value.volume.filesystem || mount.mountPoint !== value.volume.directory
    || String(statSync(value.environmentWorkspace).dev) !== value.volume.device) throw new Error('Training placement filesystem changed')
  return value.environmentWorkspace
}

/** Storage scanning and acquisition settings are supplied through the profile. */
export const storageGovernancePolicySchema = z.object({
  systemReserveBytes: z.number().int().nonnegative().default(5 * 1024 ** 3),
  systemReserveRatio: z.number().min(0).max(1).default(0.10),
  dataReserveBytes: z.number().int().nonnegative().default(2 * 1024 ** 3),
  dataReserveRatio: z.number().min(0).max(1).default(0.05),
  peakSafetyFactor: z.number().min(1).max(10).default(1.20),
  capacityRecheckMs: z.number().int().min(100).max(60000).default(5000),
  scanEntryLimit: z.number().int().min(1).max(1000000).default(100000),
  scanTimeoutMs: z.number().int().min(100).max(120000).default(10000),
  snapshotFileLimit: z.number().int().min(1).max(1000000).default(200000),
  verificationTimeoutMs: z.number().int().min(1000).max(1800000).default(300000),
  materialTimeoutMs: z.number().int().min(1000).max(2147483647).default(7200000),
  metadataWaitTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
  networkReadTimeoutMs: z.number().int().min(1000).max(120000).default(30000),
  transferChunkBytes: z.number().int().min(65536).max(16777216).default(1048576),
  metadataBytes: z.number().int().min(65536).max(32000000).default(8388608),
  materialFileLimit: z.number().int().min(1).max(100000).default(10000),
  maxConcurrentTransfers: z.number().int().min(1).max(8).default(1),
  materialLockShards: z.number().int().min(1).max(256).default(64),
  inventoryMountPrefixes: z.array(z.string().regex(/^\//)).min(1).default(['/', '/root', '/mnt', '/data', '/workspace', '/home']),
  materialHosts: z.array(z.string().min(1)).min(1).default(['huggingface.co', 'hf-mirror.com', 'modelscope.cn']),
}).strict()
/** Resolved deployment settings for catalog, snapshot and download operations. */
export type StorageGovernancePolicy = z.infer<typeof storageGovernancePolicySchema>
/** Cordis projection of the independently validated storage settings. */
export const StorageGovernancePolicyConfig: s<StorageGovernancePolicy> = s.object({
  systemReserveBytes: s.number().step(1).min(0).default(5 * 1024 ** 3),
  systemReserveRatio: s.number().min(0).max(1).default(0.10),
  dataReserveBytes: s.number().step(1).min(0).default(2 * 1024 ** 3),
  dataReserveRatio: s.number().min(0).max(1).default(0.05),
  peakSafetyFactor: s.number().min(1).max(10).default(1.20),
  capacityRecheckMs: s.number().step(1).min(100).max(60000).default(5000),
  scanEntryLimit: s.number().step(1).min(1).max(1000000).default(100000),
  scanTimeoutMs: s.number().step(1).min(100).max(120000).default(10000),
  snapshotFileLimit: s.number().step(1).min(1).max(1000000).default(200000),
  verificationTimeoutMs: s.number().step(1).min(1000).max(1800000).default(300000),
  materialTimeoutMs: s.number().step(1).min(1000).max(2147483647).default(7200000),
  metadataWaitTimeoutMs: s.number().step(1).min(1000).max(600000).default(120000),
  networkReadTimeoutMs: s.number().step(1).min(1000).max(120000).default(30000),
  transferChunkBytes: s.number().step(1).min(65536).max(16777216).default(1048576),
  metadataBytes: s.number().step(1).min(65536).max(32000000).default(8388608),
  materialFileLimit: s.number().step(1).min(1).max(100000).default(10000),
  maxConcurrentTransfers: s.number().step(1).min(1).max(8).default(1),
  materialLockShards: s.number().step(1).min(1).max(256).default(64),
  inventoryMountPrefixes: s.array(s.string()).default(['/', '/root', '/mnt', '/data', '/workspace', '/home']),
  materialHosts: s.array(s.string()).default(['huggingface.co', 'hf-mirror.com', 'modelscope.cn']),
})

function readOwned(path: string): unknown {
  checkAncestors(path)
  return JSON.parse(readFileSync(path, 'utf8'))
}

function checkAncestors(path: string, checked = new Set<string>()): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (current !== resolve(path) && checked.has(current)) break
    if (lstatSync(current).isSymbolicLink()) throw new Error('Storage content contains a symbolic link: ' + path)
    if (current !== resolve(path)) checked.add(current)
    if (dirname(current) === current) break
  }
}

function materialFileCurrent(controlRoot: string, serverId: string, file: ExperimentMaterial['files'][number], path: string): boolean {
  const observed = statSync(path, { bigint: true })
  if (!observed.isFile() || observed.size !== BigInt(file.bytes) || observed.mtimeNs.toString() !== file.mtimeNs) return false
  if (observed.ctimeNs.toString() === file.ctimeNs) return true
  const key = createHash('sha256').update(JSON.stringify([file.algorithm, file.hash, file.bytes])).digest('hex')
  const record = resolve(controlRoot, 'state/storage-governance-v1/file-objects', key + '.json')
  if (!existsSync(record)) return false
  const proof = z.object({ version: z.literal(1), serverId: z.string(), materialId: z.string(), path: z.string(), relativePath: z.string(),
    algorithm: z.string(), hash: z.string(), bytes: z.number().int().nonnegative(), mtimeNs: z.string(), ctimeNs: z.string() }).strict().parse(readOwned(record))
  if (proof.serverId !== serverId || proof.hash !== file.hash || proof.algorithm !== file.algorithm || proof.bytes !== file.bytes) return false
  checkAncestors(proof.path)
  const linked = statSync(proof.path, { bigint: true })
  return linked.dev === observed.dev && linked.ino === observed.ino && linked.size === observed.size && observed.mtimeNs.toString() === proof.mtimeNs
    && observed.ctimeNs.toString() === proof.ctimeNs && linked.ctimeNs === observed.ctimeNs
}

/**
 * Enforce a persistent source lease for commands, mutations and original-experiment deletion.
 * @param controlRoot - node-owned controller root. @param experimentId - source experiment being changed.
 * @returns after confirming no retained borrower exists.
 */
export function assertStorageSourceAvailable(controlRoot: string, experimentId: string): void {
  const root = resolve(controlRoot, 'state/storage-governance-v1/environment-leases')
  for (const name of existsSync(root) ? readdirSync(root).filter(name => name.endsWith('.json')) : []) {
    const lease = borrowedEnvironmentSchema.parse(readOwned(resolve(root, name)))
    if (lease.sourceExperimentId === experimentId) throw new Error(`Environment is borrowed read-only by experiment ${lease.experimentId}; release its remote binding before modifying the source`)
  }
  const materials = resolve(controlRoot, 'state/storage-governance-v1/material-source-leases')
  if (existsSync(materials)) for (const name of readdirSync(materials).filter(name => name.endsWith('.json'))) {
    const value = z.object({ version: z.literal(1), serverId: z.string(), sourceExperimentId: z.string(), materialId: z.string(), runRoot: z.string(), directory: z.string() }).strict().parse(readOwned(resolve(materials, name)))
    if (value.sourceExperimentId === experimentId) throw new Error('Historical model/data files are retained by immutable material ' + value.materialId + '; their source cannot be modified or removed')
  }
}

/**
 * Resolve explicit historical grants without weakening current-workspace checks.
 * @param runRoot - destination run with its original owner marker. @param controlRoot - trusted node root for separately placed source environments. @returns verified read-only loans.
 */
export function readBorrowedEnvironments(runRoot: string, controlRoot?: string): BorrowedEnvironment[] {
  const root = resolve(runRoot, 'environment-borrowings-v1')
  if (!existsSync(root)) return []
  const owner = z.object({ version: z.literal(1), experimentId: z.string(), serverId: z.string() }).strict().parse(readOwned(resolve(runRoot, '.aspera-owner.json')))
  return readdirSync(root).filter(name => name.endsWith('.json')).map(name => {
    const value = borrowedEnvironmentSchema.parse(readOwned(resolve(root, name)))
    if (value.experimentId !== owner.experimentId || value.serverId !== owner.serverId || value.environmentId + '.json' !== name) throw new Error('Historical environment grant belongs to another experiment')
    const source = z.object({ version: z.literal(1), experimentId: z.string(), serverId: z.string() }).strict().parse(readOwned(resolve(value.sourceRunRoot, '.aspera-owner.json')))
    if (source.experimentId !== value.sourceExperimentId || source.serverId !== value.serverId) throw new Error('Historical environment source owner changed')
    const sourceWorkspace = managedTrainingWorkspace(value.sourceRunRoot, resolve(value.sourceRunRoot, 'workspace'), controlRoot)
    const rel = relative(sourceWorkspace, value.directory)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Historical environment escaped its source workspace')
    const lease = borrowedEnvironmentSchema.parse(readOwned(value.lease))
    if (JSON.stringify(lease) !== JSON.stringify(value)) throw new Error('Historical environment lease differs from its binding')
    const mounted = inspectStorage({ directory: value.directory }).candidates.find(row => row.directory === value.directory)?.mount
    if (mounted?.source !== value.volume.source || mounted.filesystem !== value.volume.filesystem || mounted.mountPoint !== value.volume.directory) throw new Error('Historical environment storage volume changed')
    if (realpathSync(value.python) !== value.interpreter.path) throw new Error('Historical interpreter link changed')
    const expectedMounts = [value.directory, ...(relative(value.directory, value.interpreter.path).startsWith('..') || isAbsolute(relative(value.directory, value.interpreter.path)) ? [value.interpreter.path] : [])]
    if (JSON.stringify([...new Set(value.readonlyPaths)].sort()) !== JSON.stringify(expectedMounts.sort())) throw new Error('Historical environment grants unrelated read-only paths')
    const interpreter = statSync(value.interpreter.path, { bigint: true })
    if (interpreter.size !== BigInt(value.interpreter.size) || interpreter.mtimeNs.toString() !== value.interpreter.mtimeNs || interpreter.ctimeNs.toString() !== value.interpreter.ctimeNs) throw new Error('Historical interpreter changed')
    for (const link of value.links) {
      const path = resolve(value.directory, link.path), entry = relative(value.directory, path)
      if (!entry || entry === '..' || entry.startsWith('..' + sep) || isAbsolute(entry) || realpathSync(path) !== link.target) throw new Error('Historical environment link changed or escaped its source')
    }
    const checked = new Set<string>()
    for (const file of value.files) {
      const path = resolve(value.directory, file.path)
      const entry = relative(value.directory, path)
      if (!entry || entry === '..' || entry.startsWith('..' + sep) || isAbsolute(entry)) throw new Error('Historical package file escaped its source environment')
      checkAncestors(path, checked)
      const observed = statSync(path, { bigint: true })
      if (!observed.isFile() || observed.size !== BigInt(file.size) || observed.mtimeNs.toString() !== file.mtimeNs || observed.ctimeNs.toString() !== file.ctimeNs) throw new Error('Historical environment changed; reverify before execution: ' + path)
    }
    return value
  })
}

/**
 * Read model and data bindings published only after canonical file verification.
 * @param runRoot - destination run. @param controlRoot - authenticated node root.
 * @returns immutable source paths for the command and service sandbox.
 */
export function materialReadonlyPaths(runRoot: string, controlRoot: string): string[] {
  const root = resolve(runRoot, 'material-bindings-v1')
  if (!existsSync(root)) return []
  const owner = z.object({ version: z.literal(1), experimentId: z.string(), serverId: z.string() }).strict().parse(readOwned(resolve(runRoot, '.aspera-owner.json')))
  return readdirSync(root).filter(name => name.endsWith('.json')).map(name => {
    const binding = experimentMaterialBindingSchema.parse(readOwned(resolve(root, name)))
    if (binding.experimentId !== owner.experimentId || binding.serverId !== owner.serverId || name !== binding.materialId + '.json') throw new Error('Material binding belongs to another experiment')
    const catalog = experimentMaterialSchema.parse(readOwned(resolve(controlRoot, 'state/storage-governance-v1/materials', name)))
    if (catalog.id !== binding.materialId || catalog.serverId !== owner.serverId || catalog.directory !== binding.directory) throw new Error('Material catalog identity differs from its binding')
    const publication = resolve(controlRoot, 'state/storage-governance-v1/material-publications', name)
    const manifest = experimentMaterialSchema.parse(readOwned(publication))
    if (createHash('sha256').update(readFileSync(publication)).digest('hex') !== binding.manifestHash) throw new Error('Material publication differs from its retained reference')
    if (manifest.id !== binding.materialId || manifest.serverId !== owner.serverId || manifest.state !== 'ready' || manifest.directory !== binding.directory) throw new Error('Material is not a published server-owned snapshot')
    const mounted = inspectStorage({ directory: manifest.directory }).candidates.find(value => value.directory === manifest.directory)?.mount
    if (mounted?.source !== manifest.volume.source || mounted.filesystem !== manifest.volume.filesystem || mounted.mountPoint !== manifest.volume.directory) throw new Error('Material data-volume identity changed')
    if (manifest.historicalSource !== undefined) {
      const source = manifest.historicalSource
      const lease = z.object({ version: z.literal(1), serverId: z.string(), materialId: z.string(), sourceExperimentId: z.string(), runRoot: z.string(), directory: z.string() }).strict()
        .parse(readOwned(resolve(controlRoot, 'state/storage-governance-v1/material-source-leases', name)))
      if (lease.serverId !== owner.serverId || lease.materialId !== manifest.id || lease.sourceExperimentId !== source.sourceExperimentId
        || lease.runRoot !== source.runRoot || lease.directory !== manifest.directory) throw new Error('Historical material lease differs from its publication')
    }
    const checked = new Set<string>()
    for (const file of manifest.files) {
      const path = resolve(manifest.directory, file.path)
      checkAncestors(path, checked)
      const rel = relative(manifest.directory, path)
      if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel) || !materialFileCurrent(controlRoot, owner.serverId, file, path)) throw new Error('Published material identity changed: ' + file.path)
    }
    return binding.directory
  })
}
