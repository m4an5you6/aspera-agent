/** Storage preparation shared by SSH dispatch and the installed node controller. */
import { readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { serverInventorySchema, storageCandidateSchema, storagePlacementSchema } from '@aspera/experiments'
import type { ClusterServer, ExperimentId, ServerInventory, ServerSettings, StorageCandidateId, StoragePlacement } from '@aspera/experiments'
import { remote, shellQuote } from './transport.ts'
import type { Target } from './transport.ts'

/** Read-only SSH inventory works before any Aspera installation exists.
 * @param target - pinned SSH account. @param directory - explicit storage directory. @param password - private credential.
 * @param signal - operation cancellation. @returns validated server observations.
 */
export async function inspectServerStorage(target: Target, directory: string | undefined, password?: string, signal?: AbortSignal): Promise<ServerInventory> {
  return serverInventorySchema.parse(await storageRequest(target, 'inspectStorage', { directory }, password, signal))
}

async function storageRequest(target: Target, operation: 'inspectStorage' | 'prepareStorage' | 'verifyStorage' | 'cleanupStorage', input: object,
  password?: string, signal?: AbortSignal, requiredBytes = 0): Promise<unknown> {
  const source = readFileSync(new URL('../scripts/storage.mjs', import.meta.url), 'utf8')
  const payload = Buffer.from(JSON.stringify(input)).toString('base64')
  const script = `${source}\nconsole.log(JSON.stringify(${operation}(JSON.parse(Buffer.from('${payload}', 'base64').toString()), ${requiredBytes})))`
  return JSON.parse(await remote(target, `node --input-type=module -e ${shellQuote(script)}`, signal, password))
}

/** Remove an ended experiment's owned files over its pinned SSH connection.
 * @param target - saved SSH account. @param placement - saved mount and owner. @param privateNames - registered secret basenames.
 * @param password - private credential. @param signal - abort the SSH helper without assuming remote cleanup succeeded.
 * @returns after the remote helper confirms complete cleanup.
 */
export async function cleanupServerStorage(target: Target, placement: StoragePlacement, privateNames: string[], password?: string, signal?: AbortSignal): Promise<void> {
  const result = await storageRequest(target, 'cleanupStorage', { placement: storagePlacementSchema.parse(placement), privateNames }, password, signal)
  if (typeof result !== 'object' || result === null || !('cleaned' in result) || result.cleaned !== true) throw new Error('Remote cleanup was not confirmed')
}

/** Materialize a saved assignment without reselecting a disk.
 * @param target - pinned SSH account. @param placement - durable selection. @param password - credential.
 * @param signal - cancellation. @param requiredBytes - additional transfer size. @returns actual capacity after verification.
 */
export async function prepareServerStorage(target: Target, placement: StoragePlacement, password?: string, signal?: AbortSignal, requiredBytes = 0) {
  return storageCandidateSchema.parse(await storageRequest(target, 'prepareStorage', placement, password, signal, requiredBytes))
}

/** Recheck a selected mount immediately before transferring data.
 * @param target - pinned SSH account. @param placement - durable selection. @param password - credential.
 * @param signal - cancellation. @param requiredBytes - additional transfer size. @returns actual free space.
 */
export async function verifyServerStorage(target: Target, placement: StoragePlacement, password?: string, signal?: AbortSignal, requiredBytes = 0) {
  return storageCandidateSchema.parse(await storageRequest(target, 'verifyStorage', placement, password, signal, requiredBytes))
}

/** Resolve a model-selected candidate into application-owned paths.
 * @param server - captured user settings. @param id - experiment identity. @param digest - release digest.
 * @param inventory - logged SSH observations. @param candidateId - selected observed candidate. @param reason - selection rationale.
 * @param minimumFreeBytes - deployment-configured reserve. @returns validated immutable assignment.
 */
export function resolveStoragePlacement(server: ServerSettings, id: ExperimentId, digest: string, inventory: ServerInventory,
  candidateId: StorageCandidateId, reason: string, minimumFreeBytes: number): StoragePlacement {
  const candidate = inventory.candidates.find(value => value.id === candidateId)
  if (candidate === undefined) throw new Error('Selected storage candidate does not belong to the saved inventory')
  if (!candidate.writable || candidate.persistence === 'ephemeral' || candidate.availableBytes < minimumFreeBytes) {
    throw new Error(`Storage candidate is unavailable or has insufficient space: ${candidate.directory}`)
  }
  const explicit = server.storagePreference?.mode === 'manual' ? server.storagePreference.directory
    : server.storagePreference === undefined ? server.remoteRoot : undefined
  if (explicit !== undefined && candidate.directory !== explicit) throw new Error('Storage selection must use the explicitly configured directory')
  const controlRoot = server.remoteRoot ?? posix.join(inventory.home, '.local/share/aspera', server.id)
  const legacyRoot = server.storagePreference === undefined
    || (server.storagePreference.mode === 'manual' && server.storagePreference.directory === server.remoteRoot) ? server.remoteRoot : undefined
  const namespaceRoot = legacyRoot ?? posix.join(candidate.directory, '.aspera', server.id)
  const runRoot = posix.join(namespaceRoot, 'runs', id)
  return storagePlacementSchema.parse({ version: 1, layout: legacyRoot === undefined ? 'separated' : 'legacy', serverId: server.id, experimentId: id, candidate, controlRoot,
    namespaceRoot, releaseRoot: posix.join(namespaceRoot, 'releases', digest), runRoot,
    workspaceRoot: posix.join(runRoot, 'workspace'), reason, minimumFreeBytes })
}

/** Read the directory pinned in a submission; old generations retain their original layout.
 * @param server - captured resolved server. @param id - experiment identity. @returns node-specific run directory.
 */
export function serverRunRoot(server: ClusterServer, id: ExperimentId): string {
  if (server.storagePlacement !== undefined) {
    if (server.storagePlacement.experimentId !== id) throw new Error('Storage assignment belongs to another experiment')
    return resolve(server.storagePlacement.runRoot)
  }
  return resolve(server.remoteRoot, 'runs', id)
}

/** Read a pinned release directory without consulting mutable server settings.
 * @param server - captured resolved server. @param digest - captured release. @returns immutable release directory.
 */
export function serverReleaseRoot(server: ClusterServer, digest: string): string {
  if (server.storagePlacement !== undefined) {
    if (!server.storagePlacement.releaseRoot.endsWith('/' + digest)) throw new Error('Storage assignment belongs to another release')
    return resolve(server.storagePlacement.releaseRoot)
  }
  return resolve(server.remoteRoot, 'releases', digest)
}
