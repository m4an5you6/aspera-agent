/** Ordinary commands and coordinated groups remain exclusive until their original exits are observed. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import { clusterCommandSchema, commandWaitSchema, serverIdSchema, serviceSchema, writeExperimentEvidenceSchema, experimentEvidenceReceiptSchema } from '@aspera/experiments'
import type { CommandWait, ExperimentServerId } from '@aspera/experiments'
import { clusterCommandStatuses, clusterNodeRequest } from './cluster-runtime.ts'
import { CommandAdmissionRejected } from './command-admission.ts'
import type { ClusterPrivate, ClusterRuntimeConfig } from './cluster-runtime.ts'
import { serverRunRoot } from './storage.ts'
import { finalizationPolicySchema } from './finalization-policy.ts'
import { waitExperimentCommand } from './command-wait.ts'

const memberSchema = clusterCommandSchema.extend({ serverId: serverIdSchema }).strict()
const groupSchema = z.object({ operationId: z.uuid(), commands: z.array(memberSchema).min(1).max(64) }).strict()
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** @param ctx - exclusive Agent scope. @param runtime - original allocation. @param config - deployment limits. @param beforeLaunch - approved stage parameter check.
 * @returns a waiter used by finalization; it never starts replacement commands.
 */
export function installExecutionCommands(ctx: Context, runtime: ClusterPrivate, config: ClusterRuntimeConfig,
  beforeLaunch?: (serverId: ExperimentServerId, commandId: string, signal: AbortSignal) => Promise<void>): (signal: AbortSignal) => Promise<CommandWait[]> {
  const root = serverRunRoot(runtime.submission.coordinator, runtime.submission.experimentId), policy = finalizationPolicySchema.parse(config.finalization ?? {})
  const directory = resolve(root, 'command-waits-v1')
  const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
  const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera command', kind: 'execute' as const, rawInput: args })
  const allowed = (serverId: ExperimentServerId) => { if (!runtime.submission.nodes.some(node => node.server.id === serverId)) throw new Error('Command node is outside the original allocation') }
  const logs = (serverId: ExperimentServerId, commandId: string) => Object.fromEntries((['stdout', 'stderr'] as const).map(stream => [stream,
    { tool: 'read_experiment_file', server_id: serverId, command_id: commandId, stream, offset: 0 }]))
  const wait = async (serverId: ExperimentServerId, commandId: string, signal: AbortSignal, command?: string, operation: 'run' | 'diagnostic' = 'run', submit = true) => {
    allowed(serverId)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const path = resolve(directory, serverId + '_' + commandId + '.json')
    const prior = existsSync(path) ? commandWaitSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined
    if (prior !== undefined && (prior.experimentId !== runtime.submission.experimentId || prior.serverId !== serverId || prior.commandId !== commandId)) throw new Error('Command wait journal ownership changed')
    return waitExperimentCommand({ experimentId: runtime.submission.experimentId, serverId, commandId, startedAt: prior?.startedAt ?? Date.now(), signal, policy,
      prior, ...(command === undefined ? {} : { requestHash: digest(command), purpose: operation }),
      ...(command === undefined || !submit ? {} : { submit: (lifetime: AbortSignal) => clusterNodeRequest(runtime, serverId, operation, { commandId, command }, lifetime) }),
      read: lifetime => clusterNodeRequest(runtime, serverId, 'command-status', { commandId }, lifetime),
      save: row => writeFileAtomic(path, JSON.stringify(row) + '\n', { mode: 0o600 }) })
  }
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'run_experiment_diagnostic',
    description: 'Run an Agent-chosen diagnostic without reserving training capacity. Workspace, registered environments and verified materials are read-only; credentials/control paths and GPU devices are hidden. Only bounded private temporary storage is writable. Program enforces configured time and log limits and waits for the actual exit. Read stdout/stderr using the returned logs references through read_experiment_file; workspace logs/<run_id>.log is not created. Reuse run_id and identical content after a lost reply. This cannot install, download persistent materials, train or release the experiment. Use write_experiment_evidence for small reports.',
    parameters: { server_id: { type: 'string', required: true }, run_id: { type: 'string', required: true }, command: { type: 'string', required: true } }, output, presentCall,
    execute: async (args, execution) => {
      const input = clusterCommandSchema.parse({ commandId: args.run_id, command: args.command })
      if (/^(?:service|environment|material)-/.test(input.commandId)) throw new Error('Diagnostics cannot use reserved managed-operation names')
      const serverId = serverIdSchema.parse(args.server_id)
      const result = await wait(serverId, input.commandId, execution.signal, input.command, 'diagnostic')
      return JSON.stringify({ ...result, ...(result.state === 'rejected' ? {} : { logs: logs(serverId, input.commandId) }) })
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'write_experiment_evidence',
    description: 'Write bounded UTF-8 evidence without running a shell or requiring a training storage budget. json: operationId UUID, path under configs/, reports/ or artifacts/diagnostics/, content string, format text|json. Existing different content cannot be overwritten. Retry the identical operation after disconnect; the program returns byte count and SHA-256. This does not assert that Agent statements are program-verified.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output, presentCall,
    execute: async (args, execution) => {
      const serverId = serverIdSchema.parse(args.server_id); allowed(serverId)
      return JSON.stringify(experimentEvidenceReceiptSchema.parse(await clusterNodeRequest(runtime, serverId, 'write-evidence',
        writeExperimentEvidenceSchema.parse(JSON.parse(args.json)), execution.signal)))
    } })))
  const waitAll = async (signal: AbortSignal) => {
    const statuses = await clusterCommandStatuses(runtime, signal), results: CommandWait[] = []
    const services = (await Promise.all(runtime.submission.nodes.map(node => clusterNodeRequest(runtime, node.server.id, 'services', {}, signal))))
      .flatMap(value => z.array(serviceSchema).parse(value))
    for (const node of statuses) for (const command of node.commands) {
      if (!command.released && !services.some(service => service.serverId === node.serverId && service.commandId === command.commandId)) results.push(await wait(node.serverId, command.commandId, signal))
    }
    return results
  }
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'run_experiment_command',
    description: 'Run one confined command and WAIT for its actual terminal state and process cleanup. Run training in the FOREGROUND using its registered stage commandId as run_id; background descendants are stopped when the command exits. The exclusive tool remains pending while the node works; no shell sleep or model log polling is needed. Reuse run_id and identical command after a lost response; settled failed IDs return their original result. A confirmed failed released training attempt can use register_experiment_stage with previousAttemptId before a new command ID. Connection failure returns unknown and retains the original command; never launch a replacement. Use run_experiment_command_group for concurrent rendezvous participants, and dedicated inference tools for resident services.',
    parameters: { server_id: { type: 'string', required: true }, run_id: { type: 'string', required: true }, command: { type: 'string', required: true } }, output, presentCall,
    execute: async (args, execution) => {
      const input = clusterCommandSchema.parse({ commandId: args.run_id, command: args.command })
      if (/^(?:service|environment|material)-/.test(input.commandId)) throw new Error('Ordinary commands cannot use reserved managed-operation names')
      const serverId = serverIdSchema.parse(args.server_id); allowed(serverId)
      await beforeLaunch?.(serverId, input.commandId, execution.signal)
      const result = await wait(serverId, input.commandId, execution.signal, input.command)
      return JSON.stringify(result.state === 'settled' ? { ...result.result, wait: result, logs: logs(serverId, input.commandId) }
        : { state: result.state, detail: result.detail, wait: result, ...(result.state === 'rejected' ? {} : { logs: logs(serverId, input.commandId) }) })
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_experiment_commands',
    description: 'Read actual command exits. wait=true waits for the existing ordinary commands to settle through the same exclusive waiter; it does not merely sleep once. It never launches commands.',
    parameters: { wait: { type: 'boolean' } }, output, presentCall,
    execute: async (args, execution) => {
      if (args.wait !== true) return JSON.stringify(await clusterCommandStatuses(runtime, execution.signal))
      const waits = await waitAll(execution.signal)
      return JSON.stringify({ nodes: await clusterCommandStatuses(runtime, execution.signal), waits })
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'run_experiment_command_group',
    description: 'Start every member of a coordinated command group BEFORE waiting for exits, so distributed rendezvous cannot block participant startup. json: operationId UUID, commands [{serverId,commandId,command}]. All nodes must belong to this experiment. Reuse identical operationId and contents after disconnects. A confirmed partial startup failure stops only matching group commands and checks their exits; unknown outcomes remain protected. This does not register persistent inference services.',
    parameters: { json: { type: 'string', required: true } }, output, presentCall,
    execute: async (args, execution) => {
      const group = groupSchema.parse(JSON.parse(args.json)), signal = execution.signal
      const keys = group.commands.map(member => member.serverId + '/' + member.commandId)
      if (new Set(keys).size !== keys.length) throw new Error('Command group contains duplicate members')
      for (const member of group.commands) { allowed(member.serverId); if (/^(?:service|environment|material)-/.test(member.commandId)) throw new Error('Command group cannot use reserved managed-operation names') }
      for (const member of group.commands) await beforeLaunch?.(member.serverId, member.commandId, signal)
      const folder = resolve(root, 'command-groups-v1'); mkdirSync(folder, { recursive: true, mode: 0o700 })
      const path = resolve(folder, group.operationId + '.json')
      if (existsSync(path) && JSON.stringify(JSON.parse(readFileSync(path, 'utf8'))) !== JSON.stringify(group)) throw new Error('Command group operation ID is bound to different contents')
      await writeFileAtomic(path, JSON.stringify(group) + '\n', { mode: 0o600 })
      const starts = await Promise.allSettled(group.commands.map(member => clusterNodeRequest(runtime, member.serverId, 'run', { commandId: member.commandId, command: member.command }, signal)))
      if (starts.some(value => value.status === 'rejected')) {
        const refusals = starts.map((value, index) => {
          const member = group.commands[index]!
          return value.status === 'rejected' && value.reason instanceof CommandAdmissionRejected
            && value.reason.receipt.experimentId === runtime.submission.experimentId && value.reason.receipt.serverId === member.serverId
            && value.reason.receipt.commandId === member.commandId && value.reason.receipt.requestHash === digest(member.command) ? value.reason : undefined
        })
        if (!refusals.some(value => value !== undefined)) {
          return JSON.stringify({ state: 'unknown', detail: 'A launch response was lost; observe the original group without resubmitting or stopping it solely because of a transport failure',
            waits: await Promise.all(group.commands.map(member => wait(member.serverId, member.commandId, signal, member.command, 'run', false))) })
        }
        const stops = await Promise.allSettled(group.commands.map((member, index) => refusals[index] !== undefined ? refusals[index]!.receipt : clusterNodeRequest(runtime, member.serverId, 'stop-command',
          { commandId: member.commandId, commandHash: digest(member.command) }, signal)))
        return JSON.stringify({ state: 'startup-failed', starts: starts.map(value => value.status === 'rejected' ? String(value.reason) : value.value),
          stops: stops.map(value => value.status === 'rejected' ? { state: 'unknown', detail: String(value.reason) } : value.value),
          waits: await Promise.all(group.commands.map((member, index) => refusals[index] !== undefined ? refusals[index]!.receipt : wait(member.serverId, member.commandId, signal, member.command, 'run', false))) })
      }
      return JSON.stringify({ operationId: group.operationId, waits: await Promise.all(group.commands.map(member => wait(member.serverId, member.commandId, signal, member.command, 'run', false))) })
    } })))
  return waitAll
}
