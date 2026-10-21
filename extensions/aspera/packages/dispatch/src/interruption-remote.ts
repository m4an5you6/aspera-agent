/** SSH interruption operations validate the original submission and account-owned ledger. */
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { clusterRecordSchema, clusterStateSchema, experimentInterruptionSchema, serverIdSchema } from '@aspera/experiments'
import type { ClusterRecord, ExperimentId, ExperimentInterruptionStatus, ExperimentServerId } from '@aspera/experiments'
import type { DeploymentConfig } from './deploy.ts'
import type { InterruptionTask } from './interruption.ts'
import type { FleetDriver } from './fleet.ts'
import { shellQuote } from './transport.ts'

/** Public release evidence; command-ready means exit was checked, before ledger settlement. */
export const interruptionFactsSchema = z.object({ serverId: serverIdSchema, agentsExited: z.boolean(), commandsReleased: z.boolean(),
  servicesReleased: z.boolean(), commandsReady: z.boolean(), servicesReady: z.boolean(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  blockers: z.array(z.string()), hostBootId: z.string(), agents: z.array(z.object({ pid: z.number().int(), start: z.string(), role: z.string(), parent: z.number().int().optional() })),
  commands: z.array(z.object({ pid: z.number().int(), start: z.string(), role: z.string() })), released: z.boolean().optional(),
  state: clusterStateSchema.optional(),
  coordinatorExited: z.boolean().optional(),
  receipt: experimentInterruptionSchema.optional(),
})
/** Verified account observations for one original node. */
export type InterruptionFacts = z.infer<typeof interruptionFactsSchema>
/** Fixed operations are selected by the program, never by the preparation model. */
export type InterruptionMode = 'inspect' | 'fence' | 'stop' | 'settle' | 'complete' | 'publish' | 'unfence'
const program = readFileSync(new URL('../scripts/controller-recovery.py', import.meta.url), 'utf8')

/** Program-resolved requests cannot change the original release, server, process ids or directory assignment. */
export class RemoteInterruption {
  /** @param driver - authenticated SSH provider. @param cleanupMs - configured TERM/KILL grace. */
  constructor(private readonly driver: Pick<FleetDriver, 'remote'>, private readonly cleanupMs: number) {}

  /** @param input - selected account, owned control directory and locally known task ids. @param signal - read lifetime.
   * @returns original records whose coordinator and node allocation agree; no process or ledger is modified.
   */
  async discover(input: { target: DeploymentConfig; serverId: ExperimentServerId; experimentIds: ExperimentId[]; password?: string },
    signal: AbortSignal): Promise<ClusterRecord[]> {
    const request = { mode: 'discover', root: input.target.remoteRoot, serverId: input.serverId, role: 'coordinator', experimentIds: input.experimentIds }
    const raw = JSON.parse(await this.driver.remote(input.target, `python3 -c ${shellQuote(program)} ${shellQuote(JSON.stringify(request))}`, signal, input.password))
    const records = z.object({ records: z.array(clusterRecordSchema) }).parse(raw).records
    for (const record of records) {
      if (!input.experimentIds.includes(record.submission.experimentId) || record.submission.protocol !== 4
        || record.submission.coordinator.id !== input.serverId || record.submission.coordinator.remoteRoot !== input.target.remoteRoot) {
        throw new Error('Discovered task belongs to another server or experiment')
      }
    }
    return records
  }

  private async run(record: InterruptionTask, serverId: ExperimentServerId, target: DeploymentConfig, password: string | undefined,
    status: ExperimentInterruptionStatus, mode: InterruptionMode, signal: AbortSignal, facts?: InterruptionFacts): Promise<unknown> {
    const submission = record.submission
    const server = submission?.nodes.find(node => node.server.id === serverId)?.server
    if (submission === undefined || server === undefined || server.remoteRoot !== target.remoteRoot) throw new Error('Interruption has no original assigned node')
    if (status.experimentId !== submission.experimentId) throw new Error('Interruption belongs to another experiment')
    const request = { mode: `interrupt-${mode}`, root: target.remoteRoot, serverId, role: 'coordinator', server, submission, status,
      basePort: target.remotePort, port: target.remotePort + 1, timeoutSeconds: target.toolTimeoutMs / 1000, cleanupSeconds: this.cleanupMs / 1000,
      ...(facts === undefined ? {} : { expectedDigest: facts.digest }) }
    return JSON.parse(await this.driver.remote(target, `python3 -c ${shellQuote(program)} ${shellQuote(JSON.stringify(request))}`, signal, password))
  }
  /** @param input - program-owned original record, target, credentials and journal. @param mode - bounded operation.
   * @param signal - attempt lifetime. @param facts - preceding inspection for writes. @returns validated release facts or the confirmed terminal result.
   */
  async execute(input: { record: InterruptionTask; serverId: ExperimentServerId; target: DeploymentConfig; password?: string;
    status: ExperimentInterruptionStatus }, mode: InterruptionMode, signal: AbortSignal, facts?: InterruptionFacts): Promise<{
      facts?: InterruptionFacts; record?: ClusterRecord; status?: ExperimentInterruptionStatus }> {
    const raw = await this.run(input.record, input.serverId, input.target, input.password, input.status, mode, signal, facts)
    if (mode === 'inspect' || mode === 'fence' || mode === 'settle') {
      const checked = interruptionFactsSchema.parse(raw)
      if (checked.serverId !== input.serverId) throw new Error('Interruption facts belong to another node')
      return { facts: checked }
    }
    if (mode === 'complete') {
      const result = z.object({ record: clusterRecordSchema, status: experimentInterruptionSchema }).parse(raw)
      if (JSON.stringify(result.record.submission) !== JSON.stringify(input.record.submission)
        || result.status.operationId !== input.status.operationId || result.status.submissionHash !== input.status.submissionHash
        || !result.record.resourcesReleased || result.record.services.some(service => !service.released)) throw new Error('Interruption completion has no confirmed original result')
      return result
    }
    if (mode === 'stop') z.object({ stopped: z.literal(true), operationId: z.literal(input.status.operationId) }).parse(raw)
    else z.object({ released: z.literal(true) }).parse(raw)
    return {}
  }
}
