/** SSH evidence and offline recovery fences retain the existing controller home and storage. */
import { z } from 'zod'
import { experimentIdSchema } from '@aspera/experiments'
import type { ExperimentId, ExperimentServerId, ControllerRepairId, ClusterSubmission } from '@aspera/experiments'
import type { DeploymentConfig } from './deploy.ts'
import { runControllerScript } from './controller-script.ts'
import type { FleetDriver } from './fleet.ts'

/** Version-1 read-only account evidence; an offline process alone does not prove task release. */
export const offlineControllerSchema = z.object({ version: z.literal(1), state: z.enum(['offline', 'active', 'occupied']),
  root: z.string(), role: z.enum(['node', 'coordinator']), home: z.string(), hostBootId: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  savedPid: z.string().nullable(), releaseBinding: z.string().nullable(),
  processes: z.array(z.object({ pid: z.number().int(), role: z.string(), start: z.string() })),
  blockers: z.array(z.object({ kind: z.string(), id: z.string().nullish(), reason: z.string() })),
  records: z.array(z.object({ kind: z.string(), id: z.string(), released: z.boolean().nullable() })),
  converged: z.array(z.object({ kind: z.string(), id: z.string(), experimentId: experimentIdSchema.optional() })),
})

/** Parsed public diagnostics bound to an assigned control role. */
export type OfflineController = z.infer<typeof offlineControllerSchema>

/** Operations resolve all paths, release identity and counterpart credentials without model input. */
export class ControllerRecovery {
  /** @param input - program-selected role, account and fixed release. @param driver - private SSH execution provider. */
  constructor(private readonly input: { target: DeploymentConfig; serverId: ExperimentServerId; role: 'node' | 'coordinator';
    release: string; password?: string; allowedExperimentIds?: ExperimentId[]; allowedServerIds?: ExperimentServerId[];
    allowedSubmissions?: { submission: ClusterSubmission; payloadHash: string }[] }, private readonly driver: Pick<FleetDriver, 'remote'>) {}

  private async run(mode: 'inspect' | 'begin' | 'complete', signal: AbortSignal,
    operation?: { id: ControllerRepairId; directory: string; runRoot: string; digest?: string }): Promise<unknown> {
    const target = this.input.target
    const request = { mode, root: target.remoteRoot, serverId: this.input.serverId, role: this.input.role, release: this.input.release,
      port: target.remotePort + (this.input.role === 'coordinator' ? 1 : 0), basePort: target.remotePort,
      timeoutSeconds: target.toolTimeoutMs / 1000,
      allowedExperimentIds: this.input.allowedExperimentIds ?? [], allowedServerIds: this.input.allowedServerIds ?? [this.input.serverId],
      allowedSubmissions: this.input.allowedSubmissions ?? [],
      ...(operation === undefined ? {} : { operationId: operation.id, directory: operation.directory, runRoot: operation.runRoot, expectedDigest: operation.digest }) }
    return runControllerScript(this.driver, target, request, signal, this.input.password)
  }

  /** @param signal - read-only inspection lifetime. @returns current process, profile and durable occupancy evidence. */
  async inspect(signal: AbortSignal): Promise<OfflineController> {
    const result = offlineControllerSchema.parse(await this.run('inspect', signal))
    if (result.root !== this.input.target.remoteRoot || result.role !== this.input.role) throw new Error('Controller evidence has another owner')
    return result
  }

  /** @param operation - durable repair ownership and previously observed digest. @param signal - fence lifetime.
   * @returns confirmation after rereading state, pausing the counterpart and settling only confirmed released resources.
   */
  async begin(operation: { id: ControllerRepairId; directory: string; runRoot: string; digest: string }, signal: AbortSignal): Promise<object> {
    return z.object({ version: z.literal(1), operationId: z.literal(operation.id), phase: z.literal('fenced'),
      directory: z.literal(operation.directory), role: z.literal(this.input.role), release: z.literal(this.input.release) }).passthrough().parse(await this.run('begin', signal, operation))
  }

  /** @param operation - original recovery ownership. @param signal - completion lifetime. @returns confirmed removal of its own admission fence. */
  async complete(operation: { id: ControllerRepairId; directory: string; runRoot: string }, signal: AbortSignal): Promise<void> {
    z.object({ completed: z.literal(true), operationId: z.literal(operation.id) }).parse(await this.run('complete', signal, operation))
  }
}
