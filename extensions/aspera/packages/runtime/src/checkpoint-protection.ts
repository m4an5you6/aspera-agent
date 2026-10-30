/** Approved recovery checkpoints are sealed before subsequent writable commands or services. */
import { existsSync, lstatSync, readFileSync, readdirSync, mkdirSync, openSync, closeSync, constants } from 'node:fs'
import { resolve, relative, sep, dirname, basename } from 'node:path'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { stageRegistrationSchema, experimentIdSchema, serverIdSchema, stageEvidencePathSchema } from '@aspera/experiments'
import type { StageRegistration, ExperimentId, ExperimentServerId, ClusterCommandResult } from '@aspera/experiments'

const identity = z.object({ path: stageEvidencePathSchema, device: z.string(), inode: z.string(), size: z.number(), modified: z.number() }).strict()
const sealSchema = z.object({ version: z.literal(1), experimentId: experimentIdSchema, serverId: serverIdSchema, commandId: z.string(),
  directory: identity, files: z.array(identity), checkedAt: z.number() }).strict()
const registrationSchema = z.object({ version: z.literal(1), registration: stageRegistrationSchema }).strict()
/** Existing sealed checkpoint identity, independent of a later inference snapshot. */
export type RetainedCheckpoint = z.infer<typeof sealSchema>

function checkpointGroups(stage: StageRegistration): Map<string, string[]> {
  const groups = new Map<string, string[]>()
  for (const path of stage.requirement.requiredFiles) {
    const directory = dirname(path), rows = groups.get(directory) ?? []
    rows.push(path); groups.set(directory, rows)
  }
  for (const [directory, files] of groups) if (stage.resumeState !== undefined && files.includes(stage.resumeState)
    || !files.some(path => basename(path) === 'trainer_state.json')
    || !files.some(path => ['adapter_model.safetensors', 'model.safetensors', 'pytorch_model.bin'].includes(basename(path)))) groups.delete(directory)
  return groups
}

/** Persisted checkpoint retention belongs to one original node allocation. */
export class CheckpointProtection {
  private readonly directory: string
  /** @param root - private run directory. @param workspace - writable experiment workspace. @param experimentId - original experiment. @param serverId - owning node. */
  constructor(root: string, private readonly workspace: string, private readonly experimentId: ExperimentId,
    private readonly serverId: ExperimentServerId) { this.directory = resolve(root, 'checkpoint-protection-v1') }

  /** @param stage - program-bound approved stage. @returns after saving its immutable recovery requirements before launch. */
  async register(stage: StageRegistration): Promise<void> {
    if (stage.experimentId !== this.experimentId || stage.serverId !== this.serverId || stage.historical) throw new Error('Checkpoint registration belongs to another allocation')
    const path = resolve(this.directory, 'registrations', stage.commandId + '.json')
    if (existsSync(path)) {
      const saved = registrationSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      if (JSON.stringify(saved.registration) !== JSON.stringify(stage)) throw new Error('Checkpoint registration changed')
      return
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    await writeFileAtomic(path, JSON.stringify({ version: 1, registration: stage }) + '\n', { mode: 0o600 })
  }

  /** @param path - workspace-relative file or directory. @param directory - expected directory kind. @returns checked mount and file identity without changing contents. */
  inspect(path: string, directory: boolean): z.infer<typeof identity> {
    const root = resolve(this.workspace), absolute = resolve(root, path), suffix = relative(root, absolute)
    if (!suffix || suffix.startsWith('..' + sep) || suffix === '..' || resolve(root, suffix) !== absolute) throw new Error('Checkpoint path escaped its workspace')
    let current = root, mount: string | undefined
    for (const part of ['', ...suffix.split(sep)]) {
      if (part) current = resolve(current, part)
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error('Checkpoint contains a symbolic link')
      if (current !== absolute && !stat.isDirectory()) throw new Error('Checkpoint parent identity changed')
      if (process.platform === 'linux') {
        const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW | (stat.isDirectory() ? constants.O_DIRECTORY : 0))
        try {
          const observed = /^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))?.[1]
          if (observed === undefined) throw new Error('Checkpoint mount identity is unavailable')
          if (mount !== undefined && mount !== observed) throw new Error('Checkpoint crosses a nested mount')
          mount = observed
        } finally { closeSync(fd) }
      }
    }
    const stat = lstatSync(absolute)
    if (directory ? !stat.isDirectory() : !stat.isFile() || stat.size === 0) throw new Error('Checkpoint has missing or empty evidence: ' + path)
    return { path, device: String(stat.dev), inode: String(stat.ino), size: stat.size, modified: stat.mtimeMs }
  }

  /** @param commands - original producer exit records. @returns already sealed checkpoints after identity and release checks, without sealing new outputs. */
  retained(commands: readonly ClusterCommandResult[]): RetainedCheckpoint[] {
    const folder = resolve(this.directory, 'sealed')
    return (existsSync(folder) ? readdirSync(folder).sort() : []).map(name => {
      const seal = sealSchema.parse(JSON.parse(readFileSync(resolve(folder, name), 'utf8')))
      if (seal.experimentId !== this.experimentId || seal.serverId !== this.serverId) throw new Error('Checkpoint seal belongs to another allocation')
      const command = commands.find(row => row.commandId === seal.commandId)
      if (command?.state !== 'completed' || command.exitCode !== 0 || !command.released) throw new Error('Protected checkpoint command outcome is unconfirmed')
      if (JSON.stringify(this.inspect(seal.directory.path, true)) !== JSON.stringify(seal.directory)) throw new Error('Protected checkpoint directory identity changed: ' + seal.directory.path)
      for (const file of seal.files) if (JSON.stringify(this.inspect(file.path, false)) !== JSON.stringify(file)) throw new Error('Protected checkpoint file identity changed: ' + file.path)
      return seal
    })
  }

  /**
   * Seal completed training outputs and return read-only mounts for the next process.
   * @param commandId - next command or service identity. @param commands - original allocation's process observations.
   * @param diagnostic - an already read-only diagnostic never mutates or repairs retention records.
   * @returns immutable checkpoint directories; uncertain exits and active stage writers prevent concurrent mutation.
   */
  async mounts(commandId: string, commands: readonly ClusterCommandResult[], diagnostic = false): Promise<string[]> {
    if (diagnostic) return []
    const folder = resolve(this.directory, 'registrations')
    const stages = existsSync(folder) ? readdirSync(folder).map(name => registrationSchema.parse(JSON.parse(readFileSync(resolve(folder, name), 'utf8'))).registration) : []
    for (const stage of stages) if (stage.experimentId !== this.experimentId || stage.serverId !== this.serverId) throw new Error('Checkpoint record belongs to another allocation')
    const producers = stages.filter(stage => checkpointGroups(stage).size > 0)
    for (const stage of producers) {
      const command = commands.find(row => row.commandId === stage.commandId)
      if (stage.commandId !== commandId && command !== undefined && !command.released) throw new Error('A registered training stage must exit before another writable command')
    }
    if (producers.some(stage => stage.commandId === commandId) && commands.some(row => row.commandId !== commandId && !row.released && row.purpose !== 'diagnostic')) {
      throw new Error('Registered checkpoint training requires exclusive writable access')
    }
    const sealed = new Map(this.retained(commands).map(seal => [seal.directory.path, seal]))
    for (const stage of producers) {
      const command = commands.find(row => row.commandId === stage.commandId)
      if (command?.state !== 'completed' || command.exitCode !== 0 || !command.released) continue
      for (const [path, files] of checkpointGroups(stage)) {
        const filename = resolve(this.directory, 'sealed', createHash('sha256').update(path).digest('hex') + '.json')
        let seal: z.infer<typeof sealSchema>
        if (sealed.has(path)) {
          seal = sealed.get(path)!
        } else {
          const directory = this.inspect(path, true), observed = files.map(file => this.inspect(file, false))
          const statePath = files.find(file => basename(file) === 'trainer_state.json')!
          const state = z.object({ global_step: z.number().int().nonnegative() }).parse(JSON.parse(readFileSync(resolve(this.workspace, statePath), 'utf8')))
          if (state.global_step < stage.requirement.startStep || state.global_step > stage.requirement.endStep) throw new Error('Retained checkpoint step differs from the approved stage')
          seal = { version: 1, experimentId: this.experimentId, serverId: this.serverId, commandId: stage.commandId,
            directory, files: observed, checkedAt: Date.now() }
          mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
          await writeFileAtomic(filename, JSON.stringify(seal) + '\n', { mode: 0o600 })
        }
        sealed.set(path, seal)
      }
    }
    if (producers.some(stage => stage.commandId === commandId && [...checkpointGroups(stage).keys()].some(path => sealed.has(path)))) {
      throw new Error('Preserve the successful checkpoint; correct existing evidence and rerun verification instead of training again')
    }
    return [...sealed.keys()].sort().map(path => resolve(this.workspace, path))
  }
}
