/** One unattended Agent coordinates the selected nodes through allocation-scoped tools. */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { clusterChunkSchema, serverIdSchema } from './cluster-protocol.ts'
import type { ExperimentId } from './cluster-protocol.ts'
import { clusterCommandStatuses, clusterNodeRequest, readClusterPrivate, writeClusterReceipt } from './cluster-runtime.ts'
import type { ClusterRuntimeConfig, ClusterPrivate } from './cluster-runtime.ts'

const output = {
  schema: { type: 'object' as const, additionalProperties: true, properties: {} },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}
type ToolJson = null | boolean | string | number | ToolJson[] | { [key: string]: ToolJson }
function json(value: unknown): { [key: string]: ToolJson } {
  return JSON.parse(JSON.stringify(value)) as { [key: string]: ToolJson }
}

function installNodeTools(ctx: Context, runtime: ClusterPrivate, config: ClusterRuntimeConfig): void {
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'run_experiment_command',
    description: 'Start a confined command on one assigned node. It continues independently of this call. Reuse the same run_id and command to retry a lost reply without starting twice. Use the assigned node addresses and ranks for joint training.',
    parameters: { server_id: { type: 'string', required: true }, run_id: { type: 'string', required: true },
      command: { type: 'string', required: true } },
    output,
    execute: async args => json(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'run', {
      commandId: args.run_id, command: args.command,
    })),
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'get_experiment_commands',
    description: 'Read real exit codes and confirmed process cleanup for commands on every assigned node. Running commands must finish before the experiment Goal is complete.',
    parameters: { wait: { type: 'boolean', description: 'Wait for the configured observation interval before reading command status.' } }, output,
    execute: async (args, execution) => {
      if (args.wait === true) await delay(config.pollIntervalMs, undefined, { signal: execution.signal })
      return json({ nodes: await clusterCommandStatuses(runtime) })
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'read_experiment_log',
    description: 'Read bounded experiment output from one assigned node. Continue with the returned byte offset.',
    parameters: { server_id: { type: 'string', required: true }, offset: { type: 'number', required: true } }, output,
    execute: async (args) => {
      const chunk = clusterChunkSchema.parse(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'log',
        { offset: args.offset }))
      return json({ ...chunk, data: undefined, text: Buffer.from(chunk.data, 'base64').toString('utf8') })
    },
  })))
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'list_experiment_files', description: 'List output files inside one assigned node workspace.',
    parameters: { server_id: { type: 'string', required: true } }, output,
    execute: async args => json(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'files')),
  })))
}

/**
 * Run one unattended Agent with tools scoped to assigned nodes.
 * @param ctx - worker profile services.
 * @param config - coordinator paths.
 * @param id - allocated experiment.
 */
export async function runClusterAgent(ctx: Context, config: ClusterRuntimeConfig, id: ExperimentId): Promise<void> {
  const runtime = readClusterPrivate(config.root, id)
  const root = resolve(config.root, 'runs', id)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const generation = readFileSync(resolve(config.root, 'state', 'coordinator.generation'), 'utf8')
  if (generation !== process.env.DSH_CLUSTER_GENERATION) throw new Error('experiment coordinator restarted before Agent startup')
  ctx.effect(() => {
    const timer = setInterval(() => {
      try {
        if (readFileSync(resolve(config.root, 'state', 'coordinator.generation'),
          'utf8') !== generation) process.kill(process.pid, 'SIGTERM')
      } catch (error) { ctx.logger.error(String(error)); process.kill(process.pid, 'SIGTERM') }
    }, config.pollIntervalMs)
    return () => { clearInterval(timer) }
  }, 'experiment Agent: coordinator generation')
  const sessionId = SessionId(`cluster-${id}`)
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    try { appendFileSync(resolve(root, 'events.jsonl'), `${JSON.stringify(event)}\n`, { mode: 0o600 }) }
    catch (error) { ctx.logger.error(`experiment event log failed: ${String(error)}`); process.kill(process.pid, 'SIGTERM') }
  }, { global: true })
  const selection = { ...ctx.agentDefaultModel.currentSelection(), ...runtime.agentModel }
  const handle = await ctx.agents.create({ sessionId,
    meta: { cwd: resolve(root, 'agent-workspace') },
    agentOptions: { provider: selection.provider, model: selection.model }, setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      installNodeTools(agentCtx, runtime, config)
    },
  })
  ctx.effect(() => () => handle.dispose(), 'experiment Agent handle')
  let settling = false
  const settle = async (state: 'completed' | 'blocked' | 'failed', detail?: string): Promise<void> => {
    await handle.agent.whenIdle()
    if (!await ctx.sessions.flush(handle.agent.session)) throw new Error('experiment Session has no durable flush listener')
    if (state === 'completed') {
      const nodes = await clusterCommandStatuses(runtime)
      if (nodes.some(node => node.commands.length === 0 || node.commands.some(command => !command.released)
        || !node.commands.some(command => command.state === 'completed' && command.exitCode === 0))) {
        state = 'failed'
        detail = 'Goal completion did not include successful, settled commands on every assigned node.'
      }
    }
    writeClusterReceipt(config.root, id, { state, ...(detail === undefined ? {} : { detail }) }, 'outcome.json')
    await handle.dispose()
    process.kill(process.pid, 'SIGTERM')
  }
  const finish = (state: 'completed' | 'blocked' | 'failed', detail?: string) => {
    if (settling) return
    settling = true
    void settle(state, detail).catch((error: unknown) => {
      ctx.logger.error(`experiment settlement failed: ${String(error)}`)
      writeClusterReceipt(config.root, id, { state: 'failed', detail: String(error) }, 'outcome.json')
      process.kill(process.pid, 'SIGTERM')
    })
  }
  ctx.on('goal/changed', ({ agent, change }) => {
    if (agent !== handle.agent) return
    if (change.goal?.phase === 'complete') finish('completed')
    if (change.goal?.phase === 'blocked') finish('blocked', change.goal.blockedReason?.message)
  })
  ctx.on('agent/error', ({ agent }) => { if (agent === handle.agent) finish('failed',
    'Agent execution failed; inspect the experiment Session.') })
  const goal = ctx.goals.create(handle.agent, { objective: runtime.submission.objective })
  handle.agent.followup(createUserMessage({ source: { kind: 'plugin', plugin: 'experiment-worker' }, content: [{ type: 'text', text:
    `Run one joint experiment across every assigned node. Goal: ${runtime.submission.objective}\n`
    + `Nodes in stable rank order: ${JSON.stringify(runtime.submission.nodes.map((node, rank) => ({ serverId: node.server.id, name: node.server.name, rank,
      address: node.server.trainingAddress ?? node.server.host,
      gpus: node.devicePaths.filter(path => /^\/dev\/nvidia\d+$/.test(path)).length,
      workspace: `${node.server.remoteRoot}/runs/${id}/workspace` })))}\n`
    + `Inputs on every node: ${JSON.stringify(runtime.submission.inputs.map(input => `inputs/${input.name}`))}\n`
    + 'Prepare the environment and training program through the experiment node tools. Preserve explicit model, data, GPU and method requirements. '
    + 'For multiple nodes, configure one distributed run with shared rendezvous, unique node ranks, and compatible dependencies; verify actual collective communication before long training. '
    + 'Use stable run_id values for idempotent launches. Commands are managed by each node; never detach processes. '
    + 'Inspect real exit codes and logs, save outputs under the node workspace, and report artifacts before completing the Goal. '
    + 'Resolve unspecified choices within these assigned resources and record them in this Session. Do not request user input, approvals, or additional capabilities. Mark blocked with the concrete cause when requirements cannot be met.' }] }))
  if (!await ctx.sessions.flush(handle.agent.session)) throw new Error('experiment Session was not persisted')
  writeClusterReceipt(config.root, id, { sessionId, goalId: goal.id }, 'started.json')
}
