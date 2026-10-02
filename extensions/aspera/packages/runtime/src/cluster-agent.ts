/** Version-pinned planning and execution Agents with only experiment-owned tools. */
import type {} from './messages.ts'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { clusterChunkSchema, serverIdSchema, serviceIdSchema, planSchema, executionEntrySchema, progressSchema, serviceSchema } from '@aspera/experiments'
import { clusterPath, readClusterChunk } from '@aspera/experiments'
import type { ExperimentId, InferenceService } from '@aspera/experiments'
import { clusterCommandStatuses, clusterNodeRequest, readClusterPrivate, writeClusterReceipt } from './cluster-runtime.ts'
import type { ClusterRuntimeConfig, ClusterPrivate } from './cluster-runtime.ts'
import { installGoalContinuation } from './continuation.ts'
import { installExperimentQuestions } from './questions.ts'
import { serverRunRoot } from './storage.ts'

const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera node operation', kind: 'other' as const, rawInput: args })

function installKnowledge(ctx: Context, runtime: ClusterPrivate, config: ClusterRuntimeConfig): void {
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_framework_guidance', description: 'Read shipped guidance for generic version-pinned Megatron, MS-SWIFT or Unsloth preparation. Framework parameters are chosen from documentation and verified with short runs.',
    parameters: { framework: { type: 'string', enum: ['megatron', 'swift', 'unsloth'], required: true } }, output, presentCall,
    execute: async args => readFileSync(new URL(`../skills/${args.framework}/SKILL.md`, import.meta.url), 'utf8') })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_framework_documentation', description: 'Read the selected framework version documentation over HTTPS. Record the exact version and URL in the plan.',
    parameters: { url: { type: 'string', required: true } }, output, presentCall,
    execute: async (args, execution) => {
      const url = new URL(args.url)
      if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || !config.documentationHosts.includes(url.hostname)) throw new Error('documentation host is outside the configured public documentation list')
      const response = await fetch(url, { signal: AbortSignal.any([execution.signal, AbortSignal.timeout(runtime.toolTimeoutMs)]), redirect: 'error' })
      if (!response.ok) throw new Error(`documentation returned HTTP ${response.status}`)
      const chunks: Buffer[] = []; let bytes = 0
      if (response.body !== null) for await (const chunk of response.body) {
        bytes += chunk.length
        if (bytes > config.documentationBytes) throw new Error('documentation exceeds the configured byte limit; request a smaller page')
        chunks.push(Buffer.from(chunk))
      }
      return Buffer.concat(chunks).toString('utf8')
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_experiment_requirements', description: 'Read immutable objective, node inventory, execution mode, versions and input digests. It returns no credentials.', parameters: {}, output, presentCall,
    execute: async () => JSON.stringify(runtime.submission) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_experiment_input', description: 'Inspect a submitted input without allocating training nodes. Read bounded raw base64 bytes using the returned cursor. Only declared input basenames are available.',
    parameters: { name: { type: 'string', required: true }, offset: { type: 'number', required: true }, generation: { type: 'string' } }, output, presentCall,
    execute: async args => {
      if (!runtime.submission.inputs.some(input => input.name === args.name)) throw new Error('input is outside this experiment')
      const folder = resolve(serverRunRoot(runtime.submission.coordinator, runtime.submission.experimentId), 'inputs')
      return JSON.stringify(readClusterChunk(clusterPath(folder, args.name), args.offset, args.generation, config.chunkBytes, folder))
    } })))
}

function installNodeTools(ctx: Context, runtime: ClusterPrivate, config: ClusterRuntimeConfig): void {
  let launches: Promise<void> = Promise.resolve()
  const admission = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = launches.then(operation); launches = result.then(() => {}, () => {}); return result
  }
  const run = async (serverId: string, commandId: string, operation: string, body: Record<string, unknown>) => admission(async () => {
    const nodes = await clusterCommandStatuses(runtime)
    const exists = nodes.some(node => node.serverId === serverId && node.commands.some(command => command.commandId === commandId))
    if (runtime.submission.protocol === 1 && !exists && nodes.reduce((total, node) => total + node.commands.length, 0) >= runtime.submission.strategy.budget.maxCommands) throw new Error('experiment command budget exhausted')
    return clusterNodeRequest(runtime, serverIdSchema.parse(serverId), operation, body)
  })
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'run_experiment_command', description: 'Start a confined command on an assigned node. Reuse run_id and command on a lost response. All writes and GPU access are confined by the node. Build the framework environment inside this workspace. Do not detach processes.',
    parameters: { server_id: { type: 'string', required: true }, run_id: { type: 'string', required: true }, command: { type: 'string', required: true } }, output, presentCall,
    execute: async args => JSON.stringify(await run(args.server_id, args.run_id, 'run', { commandId: args.run_id, command: args.command })) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_experiment_commands', description: 'Read actual command exits and process cleanup on all assigned nodes.', parameters: { wait: { type: 'boolean' } }, output, presentCall,
    execute: async (args, execution) => { if (args.wait === true) await delay(config.pollIntervalMs, undefined, { signal: execution.signal }); return JSON.stringify(await clusterCommandStatuses(runtime)) } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_experiment_file', description: 'Read a bounded relative file or log on an assigned node. Continue with the returned offset and generation; reset means rotation or missing data.',
    parameters: { server_id: { type: 'string', required: true }, path: { type: 'string' }, offset: { type: 'number', required: true }, generation: { type: 'string' } }, output, presentCall,
    execute: async args => { const chunk = clusterChunkSchema.parse(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), args.path === undefined ? 'log' : 'file', { offset: args.offset, path: args.path, generation: args.generation })); return JSON.stringify({ ...chunk, data: undefined, text: Buffer.from(chunk.data, 'base64').toString('utf8') }) } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'list_experiment_files', description: 'List output metadata under an assigned node workspace.', parameters: { server_id: { type: 'string', required: true } }, output, presentCall,
    execute: async args => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'files')) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'record_experiment_execution', description: 'Persist the actual framework version, script path, isolated environment, parameters, artifacts and evaluation metrics for this step. JSON fields: serverId, framework, version, script, environment, parameters (string values), artifacts, evaluation (numeric values).',
    parameters: { json: { type: 'string', required: true } }, output, presentCall,
    execute: async args => { const entry = executionEntrySchema.parse(JSON.parse(args.json)); if (!runtime.submission.nodes.some(node => node.server.id === entry.serverId)) throw new Error('execution node is outside this experiment'); appendFileSync(resolve(serverRunRoot(runtime.submission.coordinator, runtime.submission.experimentId), 'executions.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600 }); return JSON.stringify(entry) } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'report_experiment_progress', description: 'Persist measured numeric metrics and the current phase. Do not invent measurements.', parameters: { phase: { type: 'string', required: true }, metrics_json: { type: 'string', required: true } }, output, presentCall,
    execute: async args => { const progress = progressSchema.parse({ phase: args.phase, metrics: JSON.parse(args.metrics_json), updatedAt: Date.now() }); writeClusterReceipt(config.root, runtime.submission.experimentId, progress, 'progress.json'); return JSON.stringify(progress) } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'start_inference_service', description: 'Register a managed inference process on an assigned node. Reuse service_id on retries. Bind the model command to 127.0.0.1 on an unused port, supply its real HTTP health path and model artifact. Set publish=true only when public inference is requested and the node has a saved inferenceMapping. The node opens that mapping port on 0.0.0.0 with separate Bearer authentication and forwards to the private model port; never bind the model to the mapping port. model_name is the model API identifier. No credentials are returned. Check both local health and external reachability. Services survive Goal completion; no automatic restart.',
    parameters: { server_id: { type: 'string', required: true }, service_id: { type: 'string', required: true }, command: { type: 'string', required: true }, model_path: { type: 'string', required: true }, port: { type: 'number', required: true }, health_path: { type: 'string', required: true }, publish: { type: 'boolean' }, model_name: { type: 'string' } }, output, presentCall,
    execute: async args => { const id = serviceIdSchema.parse(args.service_id); return JSON.stringify(await run(args.server_id, `service-${id}`, 'register-service', { id, command: args.command, modelPath: args.model_path, port: args.port, healthPath: args.health_path, publish: args.publish, modelName: args.model_name })) } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_inference_services', description: 'Read live process and HTTP health facts for registered inference services on every node.', parameters: {}, output, presentCall,
    execute: async () => JSON.stringify((await Promise.all(runtime.submission.nodes.map(node => clusterNodeRequest(runtime, node.server.id, 'services')))).flat()) })))
}

/** Run a planning or execution Session with persistent output and confined node capabilities.
 * @param ctx - worker profile services. @param config - operation bounds. @param id - immutable experiment. @param planning - read-only planning role.
 */
export async function runClusterAgent(ctx: Context, config: ClusterRuntimeConfig, id: ExperimentId, planning = false): Promise<void> {
  const runtime = readClusterPrivate(config.root, id)
  const root = serverRunRoot(runtime.submission.coordinator, id)
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const generation = readFileSync(resolve(config.root, 'state', 'coordinator.generation'), 'utf8')
  if (generation !== process.env.DSH_CLUSTER_GENERATION) throw new Error('coordinator generation changed before Agent startup')
  ctx.effect(() => {
    const timer = setInterval(() => { try { if (readFileSync(resolve(config.root, 'state', 'coordinator.generation'), 'utf8') !== generation) process.kill(process.pid, 'SIGTERM') } catch (error) { ctx.logger.error(String(error)); process.kill(process.pid, 'SIGTERM') } }, config.pollIntervalMs)
    return () => { clearInterval(timer) }
  }, 'Aspera Agent: coordinator lifetime')
  const sessionId = SessionId(`aspera-${planning ? 'plan' : 'execution'}-${id}`)
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    appendFileSync(resolve(root, 'events.jsonl'), JSON.stringify({ sessionId, source: planning ? 'plan' : 'execution', event }) + '\n', { mode: 0o600 })
  }, { global: true })
  let handle: AgentHandle
  let settling = false
  let planSaved = false
  const finish = (state: 'completed' | 'blocked' | 'failed', detail?: string) => {
    if (settling) return
    settling = true
    void settle(state, detail).catch((error: unknown) => {
      ctx.logger.error(String(error)); writeClusterReceipt(config.root, id, { state: 'failed', detail: String(error) }, planning ? 'planning-outcome.json' : 'outcome.json'); process.kill(process.pid, 'SIGTERM')
    })
  }
  const selection = runtime.agentModel
  handle = await ctx.agents.create({ sessionId, meta: { cwd: resolve(root, 'agent-workspace'), agentPreset: 'aspera-single' },
    agentOptions: { provider: selection.provider, model: selection.model }, setup: async (agentCtx, agent) => {
      await ctx.agentPresets.mount(agentCtx, 'aspera-single')
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      agentCtx.tools.restrict({ allow: [] })
      installKnowledge(agentCtx, runtime, config)
      if (!planning) installNodeTools(agentCtx, runtime, config)
      installExperimentQuestions(agentCtx, ctx, agent, runtime, config, planning, error => { finish('failed', `Operator question could not be delivered: ${String(error)}`) })
      agentCtx.effect(() => agentCtx.tools.register(defineTool({ name: planning ? 'save_experiment_plan' : 'finish_experiment',
        description: planning ? 'Save a version-specific plan, without running commands. JSON: summary, steps (strings), frameworks ([{name, version, documentation: HTTPS URL}]). The objective and servers stay fixed. Completion returns the plan for user confirmation in semi mode.' : 'Finish the execution Goal only after verifying real results. Use blocked for an unmet requirement. Registered healthy inference services survive completion; ordinary commands must be settled.',
        parameters: { status: { type: 'string', enum: ['completed', 'blocked'], required: true }, detail: { type: 'string' }, plan_json: { type: 'string' } }, output, presentCall,
        execute: async args => {
          if (planning && args.status === 'completed') {
            const plan = planSchema.parse({ ...z.object({ summary: z.string(), steps: z.array(z.string()), frameworks: planSchema.shape.frameworks }).strict().parse(JSON.parse(args.plan_json ?? '{}')), revision: 1, createdAt: Date.now() })
            writeClusterReceipt(config.root, id, { plan, sessionId }, 'plan.json'); planSaved = true
          }
          const goal = ctx.goals.get(handle.agent)
          if (goal === undefined) throw new Error('experiment Goal is missing')
          if (args.status === 'blocked') ctx.goals.block(handle.agent, { id: goal.id, revision: goal.revision }, { code: 'aspera-requirement', message: args.detail ?? 'Requirements cannot be met within the assigned resources.' })
          else ctx.goals.complete(handle.agent, { id: goal.id, revision: goal.revision })
          return JSON.stringify({ state: args.status, detail: args.detail })
        } })))
    } })
  ctx.effect(() => () => handle.dispose(), 'Aspera Agent handle')
  async function settle(state: 'completed' | 'blocked' | 'failed', detail?: string): Promise<void> {
    await handle.agent.whenIdle(); await ctx.sessionPersistence.flush()
    let services: InferenceService[] = []
    if (state === 'completed' && planning && !planSaved) { state = 'failed'; detail = 'Planning completed without a durable plan.' }
    if (state === 'completed' && !planning) {
      const evidence = resolve(root, 'executions.jsonl')
      const entries = existsSync(evidence) ? readFileSync(evidence, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => executionEntrySchema.parse(JSON.parse(line))) : []
      if (runtime.submission.nodes.some(node => !entries.some(entry => entry.serverId === node.server.id))) {
        state = 'failed'; detail = 'Completion lacks recorded framework, script, environment and parameter evidence on every selected node.'
      }
      services = (await Promise.all(runtime.submission.nodes.map(async node => z.array(serviceSchema).parse(await clusterNodeRequest(runtime, node.server.id, 'services'))))).flat()
      const nodes = await clusterCommandStatuses(runtime)
      const runningServices = new Set(services.filter(service => service.state === 'healthy' && !service.released).map(service => `${service.serverId}/${service.commandId}`))
      if (nodes.some(node => node.commands.length === 0 || node.commands.some(command => !command.released && !runningServices.has(`${node.serverId}/${command.commandId}`))
        || !node.commands.some(command => (command.state === 'completed' && command.exitCode === 0) || runningServices.has(`${node.serverId}/${command.commandId}`)))) { state = 'failed'; detail = 'Completion lacks verified settled commands or a healthy registered service on every selected node.' }
    }
    writeClusterReceipt(config.root, id, { state: state === 'completed' && services.some(service => !service.released) ? 'serving' : state, detail }, planning ? 'planning-outcome.json' : 'outcome.json')
    await handle.dispose(); process.kill(process.pid, 'SIGTERM')
  }
  ctx.on('goal/changed', ({ agent, change }) => { if (agent !== handle.agent) return; if (change.goal?.phase === 'complete') finish('completed'); if (change.goal?.phase === 'blocked') finish('blocked', change.goal.blockedReason?.message) })
  const retryLifetime = new AbortController()
  ctx.effect(() => () => { retryLifetime.abort(new Error('Experiment stopped')) }, 'Aspera: transient retry')
  ctx.on('agent/error', ({ agent, error }) => {
    if (agent !== handle.agent || settling) return
    if (!(error instanceof HarnessError) || !['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'].includes(error.code)) {
      finish('failed', `Agent failed: ${String(error)}; inspect this experiment Session.`); return
    }
    void (async () => {
      await agent.whenIdle()
      await delay(config.pollIntervalMs, undefined, { signal: retryLifetime.signal })
      const current = ctx.goals.get(agent)
      if (settling || current?.phase !== 'active' || retryLifetime.signal.aborted) return
      ctx.goals.resume(agent, { id: current.id, revision: current.revision })
      await ctx.sessionPersistence.flush()
    })().catch((failure: unknown) => { if (!retryLifetime.signal.aborted) finish('failed', String(failure)) })
  })
  if (runtime.submission.protocol !== 3) throw new Error('Legacy experiments must retain their original release')
  installGoalContinuation(ctx, handle.agent, config.goalContinuationWindow)
  const goal = ctx.goals.create(handle.agent, { objective: runtime.submission.objective, maxGoalRounds: config.goalContinuationWindow })
  let approved = ''
  if (!planning) approved = readFileSync(resolve(root, 'approved-plan.json'), 'utf8')
  handle.agent.followup(createUserMessage({ source: { kind: 'aspera', experimentId: id }, content: [{ type: 'text', text:
    `${planning ? 'Prepare a plan only. You cannot launch commands in this role.' : 'Execute the approved plan on every selected node as one joint experiment.'}\n`
    + `Requirements: ${JSON.stringify(runtime.submission)}\nApproved plan: ${approved}\n`
    + 'Read shipped framework guidance and the exact version documentation. Choose parameters, prepare an isolated environment inside each experiment workspace, write scripts and verify a short run before long training. Record actual versions, scripts, dependencies, parameters, artifacts and evaluation with the execution tool. '
    + 'For multiple nodes, preserve stable ranks, shared rendezvous and verify a real collective communication test. Never reduce the node group or change explicit training requirements. '
    + (runtime.submission.strategy.mode === 'semi' ? 'When independent investigation cannot resolve a choice, use ask_user_question to pause for a desktop reply. A reply cannot change explicit requirements or grant permissions. ' : 'Human waiting is disabled. Decide unspecified parameters within the constraints, retry recoverable errors and use short measured runs to adjust. ')
    + 'There is no total task runtime, command or round budget. Do not install Harness plugins, change the control service environment, or detach unmanaged processes. Preserve specified models, data, training methods and servers. Mark blocked with a concrete reason and evidence when constraints cannot be satisfied; use a new experiment for changed requirements. '
    + 'An inference model must bind to 127.0.0.1 and pass its HTTP health check before completion. If external access is requested, use the saved node inferenceMapping with publish=true and verify external.state=reachable before reporting it usable. Never infer a platform URL from a private IP or SSH port. The node gateway manages authentication; do not print or request credentials. Ordinary commands must settle. Use the finish tool to persist the final outcome.' }] }))
  await ctx.sessionPersistence.flush()
  writeClusterReceipt(config.root, id, { sessionId, goalId: goal.id }, planning ? 'planning-started.json' : 'started.json')
}
