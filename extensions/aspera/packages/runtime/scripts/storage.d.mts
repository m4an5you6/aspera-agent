/** Typed callers validate SSH JSON before using the standalone storage helper. */
import type { ServerInventory, StorageCandidate, StorageMountIdentity, StoragePlacement } from '@aspera/experiments'
/** Parse the Linux mount table. @param text - mountinfo contents. @returns decoded mounts. */
export function parseMounts(text: string): (StorageMountIdentity & { readOnly: boolean })[]
/** Read mount and interface facts. @param input - optional explicit directory. @returns non-secret inventory. */
export function inspectStorage(input?: { directory?: string }): ServerInventory
/** Recheck recorded placement. @param placement - saved assignment. @param requiredBytes - additional bytes. @returns current space facts. */
export function verifyStorage(placement: StoragePlacement, requiredBytes?: number): StorageCandidate
/** Create private owned paths. @param placement - saved assignment. @param requiredBytes - additional bytes. @returns verified space facts. */
export function prepareStorage(placement: StoragePlacement, requiredBytes?: number): StorageCandidate
/** Remove a tree with the exact owner marker, without following links. @param directory - owned tree. @param owner - expected marker. */
export function removeOwnedTree(directory: string, owner: { version: number; serverId: string; experimentId: string }): void
/** Clean the frozen experiment location. @param input - saved mount and experiment-specific secret names. @returns cleanup confirmation. */
export function cleanupStorage(input: { placement: StoragePlacement; privateNames: string[] }): { cleaned: true }
