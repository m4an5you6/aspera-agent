/** Read-only adapter snapshots preserve the producer while a separate Agent restores inference. */
import { constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, linkSync, renameSync, statfsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, posix } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { inferenceCheckpointCandidateSchema, inferenceCheckpointSnapshotSchema, INFERENCE_CHECKPOINT_FILES } from '@aspera/experiments'
import type { InferenceCheckpointCandidate, InferenceCheckpointSnapshot, PrepareInferenceCheckpoint, ExperimentId, ExperimentServerId, ClusterCommandResult } from '@aspera/experiments'
import { CheckpointProtection } from './checkpoint-protection.ts'

/** The node supplies the original saved directory and released process observations. */
export interface InferenceCheckpointSource {
  runRoot: string
  workspace: string
  experimentId: ExperimentId
  serverId: ExperimentServerId
  released: boolean
  commands: readonly ClusterCommandResult[]
}
type Prepared = { candidate: InferenceCheckpointCandidate; files: InferenceCheckpointSnapshot['files'] }

function owned(source: Pick<InferenceCheckpointSource, 'runRoot' | 'workspace' | 'experimentId' | 'serverId'>): void {
  for (const path of [source.runRoot, source.workspace, resolve(source.runRoot, '.aspera-owner.json')]) {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Inference checkpoint ownership contains a symbolic link')
  }
  const marker: unknown = JSON.parse(readFileSync(resolve(source.runRoot, '.aspera-owner.json'), 'utf8'))
  const parsed = z.object({ version: z.literal(1), experimentId: z.literal(source.experimentId), serverId: z.literal(source.serverId) }).strict().safeParse(marker)
  if (!parsed.success) throw new Error('Inference checkpoint directory has another owner')
}

/**
 * Discover already sealed native adapters without creating new seals or executing source code.
 * @param source - program-resolved original allocation.
 * @param readBytes - existing bounded JSON read size.
 * @returns candidates bound to original command, step and file identities.
 */
export function inspectInferenceCheckpoints(source: InferenceCheckpointSource, readBytes: number): InferenceCheckpointCandidate[] {
  owned(source)
  if (!source.released || source.commands.some(command => !command.released)) throw new Error('Source experiment process and allocation release must be confirmed')
  const protection = new CheckpointProtection(source.runRoot, source.workspace, source.experimentId, source.serverId)
  return protection.retained(source.commands).map(seal => {
    const files = INFERENCE_CHECKPOINT_FILES.map(name => {
      const identity = protection.inspect(posix.join(seal.directory.path, name), false)
      return { name, device: identity.device, inode: identity.inode, bytes: identity.size, modified: identity.modified }
    })
    if (files.find(file => file.name === 'trainer_state.json')!.bytes > readBytes) throw new Error('Native TrainerState exceeds the configured checkpoint JSON read limit')
    const state = z.object({ global_step: z.number().int().nonnegative() }).parse(JSON.parse(readFileSync(resolve(source.workspace, seal.directory.path, 'trainer_state.json'), 'utf8')))
    const value = { sourceExperimentId: source.experimentId, serverId: source.serverId, commandId: seal.commandId,
      directory: seal.directory.path, step: state.global_step, files }
    return inferenceCheckpointCandidateSchema.parse({ ...value, checkpointId: createHash('sha256').update(JSON.stringify(value)).digest('hex') })
  })
}

/**
 * Hash an observed adapter outside the node mutation lock; no paths are published here.
 * @param source - released producer. @param request - unchanged operation request.
 * @param readBytes - existing stream buffer limit. @param signal - bounded read lifetime.
 * @returns complete file proofs to recheck before publication.
 */
export async function prepareInferenceCheckpointProof(source: InferenceCheckpointSource, request: PrepareInferenceCheckpoint,
  readBytes: number, signal: AbortSignal): Promise<Prepared> {
  const candidate = inspectInferenceCheckpoints(source, readBytes).find(row => row.checkpointId === request.checkpointId)
  if (source.experimentId !== request.sourceExperimentId || candidate === undefined) throw new Error('Selected retained checkpoint identity is unavailable or changed')
  const files: Prepared['files'] = []
  for (const identity of candidate.files) {
    signal.throwIfAborted()
    const path = resolve(source.workspace, candidate.directory, identity.name), handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (String(before.dev) !== identity.device || String(before.ino) !== identity.inode || before.size !== identity.bytes || before.mtimeMs !== identity.modified) throw new Error('Checkpoint file changed before hashing')
      const hash = createHash('sha256'), buffer = Buffer.alloc(readBytes)
      for (;;) {
        signal.throwIfAborted()
        const { bytesRead } = await handle.read(buffer)
        if (bytesRead === 0) break
        hash.update(buffer.subarray(0, bytesRead))
      }
      const after = await handle.stat()
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Checkpoint file changed while hashing')
      files.push({ ...identity, sha256: hash.digest('hex') })
    } finally { await handle.close() }
  }
  return { candidate, files }
}

/** Snapshot publication uses hardlinks only; a stopped source is never installed, modified or reactivated. */
export class InferenceCheckpointSnapshots {
  private readonly directory: string
  /** @param target - current owned run. @param minimumFreeBytes - saved per-volume safety reserve. */
  constructor(private readonly target: Pick<InferenceCheckpointSource, 'runRoot' | 'workspace' | 'experimentId' | 'serverId'>,
    private readonly minimumFreeBytes: number) { this.directory = resolve(target.runRoot, 'inference-checkpoints-v1') }

  private directoryExists(): boolean {
    const stat = lstatSync(this.directory, { throwIfNoEntry: false })
    if (stat === undefined) return false
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Inference checkpoint records directory changed')
    return true
  }

  /** @param request - original operation. @returns its ready receipt, or undefined when publication needs recovery. */
  read(request: PrepareInferenceCheckpoint): InferenceCheckpointSnapshot | undefined {
    if (!this.directoryExists()) return undefined
    const path = resolve(this.directory, request.operationId + '.json')
    if (!existsSync(path)) return undefined
    if (lstatSync(path).isSymbolicLink()) throw new Error('Inference checkpoint receipt contains a symbolic link')
    const record = inferenceCheckpointSnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
    if (record.experimentId !== this.target.experimentId || record.serverId !== this.target.serverId || JSON.stringify(record.request) !== JSON.stringify(request)) throw new Error('Inference checkpoint operation belongs to different contents')
    return record
  }

  /**
   * Publish the fully checked snapshot under the caller's short node mutation lock.
   * @param source - freshly rechecked producer. @param request - original request.
   * @param prepared - hashes computed outside the lock. @param readBytes - existing JSON read limit.
   * @returns a durable ready receipt after link and ownership checks.
   */
  async publish(source: InferenceCheckpointSource, request: PrepareInferenceCheckpoint, prepared: Prepared, readBytes: number): Promise<InferenceCheckpointSnapshot> {
    owned(this.target)
    this.mounts(request.operationId)
    const current = inspectInferenceCheckpoints(source, readBytes).find(row => row.checkpointId === request.checkpointId)
    if (current === undefined || JSON.stringify(current) !== JSON.stringify(prepared.candidate)) throw new Error('Original checkpoint changed before publication')
    const previous = this.read(request)
    if (previous?.state === 'ready') { this.mounts(); return previous }
    const space = statfsSync(this.target.workspace)
    if (space.bavail * space.bsize < this.minimumFreeBytes) throw new Error('Inference checkpoint snapshot cannot consume the saved disk safety reserve')
    const protection = new CheckpointProtection(this.target.runRoot, this.target.workspace, this.target.experimentId, this.target.serverId)
    const parent = resolve(this.target.workspace, 'inference-checkpoints')
    if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 })
    protection.inspect('inference-checkpoints', true)
    if (!this.directoryExists()) mkdirSync(this.directory, { mode: 0o700 })
    const destination = posix.join('inference-checkpoints', current.checkpointId), final = resolve(this.target.workspace, destination)
    const staging = resolve(this.directory, request.operationId + '.files')
    const startedAt = previous?.startedAt ?? Date.now()
    const record = inferenceCheckpointSnapshotSchema.parse({ version: 1, experimentId: this.target.experimentId, serverId: this.target.serverId,
      request, source: current, destination, mode: 'hardlink', additionalFileBytes: 0, files: prepared.files, state: 'publishing', startedAt, updatedAt: Date.now() })
    const path = resolve(this.directory, request.operationId + '.json')
    await writeFileAtomic(path, JSON.stringify(record) + '\n', { mode: 0o600 })
    if (!existsSync(final)) {
      if (!existsSync(staging)) mkdirSync(staging, { mode: 0o700 })
      if (lstatSync(staging).isSymbolicLink()) throw new Error('Snapshot staging directory contains a symbolic link')
      for (const file of prepared.files) {
        const target = resolve(staging, file.name)
        if (!existsSync(target)) linkSync(resolve(source.workspace, current.directory, file.name), target)
        const stat = lstatSync(target)
        if (stat.isSymbolicLink() || String(stat.dev) !== file.device || String(stat.ino) !== file.inode || stat.size !== file.bytes || stat.mtimeMs !== file.modified) throw new Error('Snapshot hardlink differs from the verified source; resume the original operation')
      }
      renameSync(staging, final)
    }
    this.verifyFiles(record)
    const ready = { ...record, state: 'ready' as const, updatedAt: Date.now() }
    await writeFileAtomic(path, JSON.stringify(ready) + '\n', { mode: 0o600 })
    return ready
  }

  private verifyFiles(record: InferenceCheckpointSnapshot): void {
    if (record.destination !== posix.join('inference-checkpoints', record.request.checkpointId)) throw new Error('Inference snapshot destination identity differs')
    const protection = new CheckpointProtection(this.target.runRoot, this.target.workspace, this.target.experimentId, this.target.serverId)
    protection.inspect(record.destination, true)
    for (const file of record.files) {
      const actual = protection.inspect(posix.join(record.destination, file.name), false)
      if (actual.device !== file.device || actual.inode !== file.inode || actual.size !== file.bytes || actual.modified !== file.modified) throw new Error('Protected inference checkpoint changed')
    }
  }

  /** @param recovering - only this publishing operation may recover under the node lock. @returns read-only directories; other incomplete publications block commands and services. */
  mounts(recovering?: PrepareInferenceCheckpoint['operationId']): string[] {
    if (!this.directoryExists()) return []
    owned(this.target)
    const paths: string[] = []
    for (const name of readdirSync(this.directory).filter(name => name.endsWith('.json')).sort()) {
      const path = resolve(this.directory, name)
      if (lstatSync(path).isSymbolicLink()) throw new Error('Inference checkpoint receipt contains a symbolic link')
      const record = inferenceCheckpointSnapshotSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      if (name !== record.request.operationId + '.json' || record.experimentId !== this.target.experimentId || record.serverId !== this.target.serverId) throw new Error('Inference snapshot belongs to another operation or allocation')
      if (record.state !== 'ready') {
        if (record.request.operationId === recovering) continue
        throw new Error('Inference checkpoint publication is incomplete; repeat prepare_inference_checkpoint with original operationId ' + record.request.operationId)
      }
      this.verifyFiles(record)
      paths.push(resolve(this.target.workspace, record.destination))
    }
    return [...new Set(paths)]
  }
}
