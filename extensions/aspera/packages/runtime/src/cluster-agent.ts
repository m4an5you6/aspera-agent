/** Version-pinned planning and execution Agents with only experiment-owned tools. */
import type {} from './messages.ts'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { resolve, posix } from 'node:path'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { clusterChunkSchema, serverIdSchema, serviceIdSchema, planSchema, executionEntrySchema, progressSchema, serviceSchema } from '@aspera/experiments'
import { clusterPath, readClusterChunk } from '@aspera/experiments'
import { observationPolicySchema } from '@aspera/experiments'
import { saveMetricSample } from './metrics.ts'
import type { ExperimentId, InferenceService } from '@aspera/experiments'
import { clusterCommandStatuses, clusterNodeRequest, readClusterPrivate, writeClusterReceipt } from './cluster-runtime.ts'
import type { ClusterRuntimeConfig, ClusterPrivate } from './cluster-runtime.ts'
import { installGoalContinuation } from './continuation.ts'
import { installExperimentQuestions } from './questions.ts'
import { serverRunRoot } from './storage.ts'
import { openPhaseModelContext } from './phase-model.ts'
import { installExecutionSteps } from './execution-steps.ts'
import type { ExecutionProgressRead } from '@aspera/experiments'
import { prepareExperimentEnvironmentSchema, environmentOperationIdSchema, deploymentIdSchema } from '@aspera/experiments'
import { managedEnvironmentPolicySchema } from './managed-environment.ts'
import { prepareEnvironmentAndWait } from './environment-operation.ts'
import { prepareMaterialAndWait } from './material-operation.ts'
import { storageGovernancePolicySchema } from './storage-governance.ts'
import { assessExperimentStorageSchema, inspectExperimentMaterialsSchema, prepareExperimentMaterialsSchema } from '@aspera/experiments'
import { checkExperimentCompletion } from './completion-check.ts'
import { completionSourceInputSchema, completionSourceSchema, executionSourcesSchema, executionRecordPendingSchema } from '@aspera/experiments'
import { clusterFileSchema } from '@aspera/experiments'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { stageRegistrationInputSchema, finishReasonSchema, finishDecisionSchema, experimentStageIdSchema } from '@aspera/experiments'
import { installExecutionCommands } from './execution-commands.ts'
import { StageRegistry } from './stage-runtime.ts'
import { finalizationPolicySchema } from './finalization-policy.ts'
import { decideExperimentFinish, reportedFinishReason } from './finish-decision.ts'
import type { BudgetObservation } from './finish-decision.ts'
import type { CommandWait } from '@aspera/experiments'

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

function installNodeTools(ctx: Context, runtime: ClusterPrivate, config: ClusterRuntimeConfig, executionRecorded: (committed: boolean) => void): void {
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_experiment_environment',
    description: 'Read registered Python environments, historical read-only borrowing candidates, reuse plans, immutable installation materials and account-side disk usage on an assigned node. A directory hidden by the command sandbox is not absent on the server. Optional operation_id reads only that original operation, deadline, process exit and admission status without scanning packages. This is read-only. An unresolved outcome requires recovery of the original operation before another mutation.',
    parameters: { server_id: { type: 'string', required: true }, operation_id: { type: 'string' } }, output,
    presentCall: args => ({ card: 'generic', title: 'Inspect training environment', kind: 'other', rawInput: args }),
    execute: async (args, execution) => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id),
      args.operation_id === undefined ? 'environment-inspect' : 'environment-status',
      args.operation_id === undefined ? {} : { operationId: environmentOperationIdSchema.parse(args.operation_id) }, execution.signal)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_experiment_storage',
    description: 'Read the login-account storage catalog on an assigned node. Other experiment directories may be hidden only inside the command sandbox. refresh starts a bounded scan; cursor continues it. Missing or unscanned content is never reported as zero.',
    parameters: { server_id: { type: 'string', required: true }, refresh: { type: 'boolean' }, cursor: { type: 'string' } }, output,
    presentCall: args => ({ card: 'generic', title: 'Inspect server storage', kind: 'other', rawInput: args }),
    execute: async (args, execution) => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'storage-inspect',
      { ...(args.refresh === undefined ? {} : { refresh: args.refresh }), ...(args.cursor === undefined ? {} : { cursor: args.cursor }) }, execution.signal)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'assess_experiment_storage',
    description: 'Program-check capacity per actual filesystem before installation or download. json: operationId UUID, environmentId training, requirements, materialIds, outputBytes, checkpointBytes. Supply environmentEstimate {peakBytes,basis} only with a reasoned additional-peak estimate; unknown space remains pending. allowEnvironmentFallback:true first verifies historical reuse, then may register an unused training environment on the system filesystem if data storage is insufficient and all volumes fit their reserves. Models, data, outputs and existing directories retain their locations. Reuse the operationId when rechecking the same request.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Assess storage capacity', kind: 'other', rawInput: args }),
    execute: async (args, execution) => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'storage-assess',
      assessExperimentStorageSchema.parse(JSON.parse(args.json)), execution.signal)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_experiment_materials',
    description: 'Inspect fixed model or dataset content without downloading large files. json: kind model/dataset, provider huggingface, repository owner/name, immutable 40-character revision, optional files and configured HTTPS mirror. The Host can obtain canonical metadata when the node cannot reach it. ModelScope may transfer digest-checked files; accepting its Revision parameter does not attest a Hugging Face commit. No unverified provider revision is accepted.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Inspect fixed model and data', kind: 'other', rawInput: args }),
    execute: async (args, execution) => {
      const serverId = serverIdSchema.parse(args.server_id)
      const request = inspectExperimentMaterialsSchema.parse(JSON.parse(args.json))
      const policy = managedEnvironmentPolicySchema.parse(config.managedEnvironments ?? {})
      const deadline = Date.now() + storageGovernancePolicySchema.parse(policy.governance ?? {}).metadataWaitTimeoutMs
      for (;;) {
        const result = await clusterNodeRequest(runtime, serverId, 'material-inspect', request, execution.signal)
        const pending = z.object({ state: z.literal('metadata-pending') }).safeParse(result)
        if (!pending.success || Date.now() >= deadline) return JSON.stringify(result)
        await delay(policy.operationPollIntervalMs, undefined, { signal: execution.signal })
      }
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'prepare_experiment_materials',
    description: 'Acquire, verify or recover program-owned model/data material and wait for final process exit. json: operationId UUID, materialId from inspection, budgetId from ready capacity assessment, action acquire/verify/recover. Preserve the original operation after disconnects. Existing verified files are reused; all file sizes and canonical digests are checked before read-only publication. Use the returned local path; do not download another copy with shell commands.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Prepare fixed model and data', kind: 'other', rawInput: args }),
    execute: async (args, execution) => {
      const serverId = serverIdSchema.parse(args.server_id)
      const request = prepareExperimentMaterialsSchema.parse(JSON.parse(args.json))
      return JSON.stringify(await prepareMaterialAndWait({ experimentId: runtime.submission.experimentId, serverId, operationId: request.operationId,
        materialId: request.materialId,
        policy: managedEnvironmentPolicySchema.parse(config.managedEnvironments ?? {}), signal: execution.signal,
        submit: signal => clusterNodeRequest(runtime, serverId, 'material-prepare', request, signal),
        read: signal => clusterNodeRequest(runtime, serverId, 'material-status', { operationId: request.operationId }, signal) }))
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'prepare_experiment_environment',
    description: 'Prepare an isolated Python environment and wait for its final receipt, process exit and admission release. json: environmentId (normally training), operationId (UUID; identical content on retry), action create/install/verify/make-writable, requirements, modules, requireCuda, optional purpose/directory, files for make-writable. create installs requirements and merges existing direct constraints; install explicitly replaces the dependency requirements. Empty requirements verify only the base interpreter. The program owns uv commands, uses a separate fixed-pip installer and checks reuse and space. Training receives only requested dependencies. Unchanged deterministic package conflicts return the original operation and required repair before training creation or payload installation; changing operation ID or create/install cannot bypass this check. The tool waits internally; no model polling or shell wait is needed. Use the returned absolute python path only after completed. For failed or unknown results inspect/recover the original operation, then reverify under the same environment identity. Do not create a second environment or copy wheels. All commands/services must exit before mutation. Environment verification does not replace training acceptance.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Prepare training environment', kind: 'other', rawInput: args }),
    execute: async (args, execution) => {
      const serverId = serverIdSchema.parse(args.server_id)
      if (!runtime.submission.nodes.some(node => node.server.id === serverId)) throw new Error('server is outside this experiment allocation')
      const request = prepareExperimentEnvironmentSchema.parse(JSON.parse(args.json))
      return JSON.stringify(await prepareEnvironmentAndWait({ experimentId: runtime.submission.experimentId, serverId, operationId: request.operationId,
        policy: managedEnvironmentPolicySchema.parse(config.managedEnvironments ?? {}), signal: execution.signal,
        transport: { submit: signal => clusterNodeRequest(runtime, serverId, 'environment-prepare', request, signal),
          read: signal => clusterNodeRequest(runtime, serverId, 'environment-status', { operationId: request.operationId }, signal) } }))
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'recover_experiment_environment',
    description: 'Reconcile an original environment operation after a failed launch, disconnect, timeout or confirmed installer exit, including an already exitConfirmed failed receipt. The node checks the original process group, publication, generation and private residue; it preserves the original receipt. Recovery requires prepare_experiment_environment verification with a new operation ID under the original environment identity; install only missing dependencies if verification fails. Verified environments may have ordinary temporary cleanup pending; safety failures remain blocked. No PID or filesystem path is accepted.',
    parameters: { server_id: { type: 'string', required: true }, operation_id: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Recover training environment', kind: 'other', rawInput: args }),
    execute: async args => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'environment-recover',
      { operationId: environmentOperationIdSchema.parse(args.operation_id) })) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'preview_experiment_cache_cleanup',
    description: 'Read an owned cleanup preview for an assigned node. Candidates include confirmed exited installation residue, unreferenced shared package objects and duplicate verified wheels with an independently retained copy. Unique verified wheels, environments, models, datasets, results, logs and releases are preserved. Historical candidates require an explicit candidate_ids selection. Pass the returned fingerprint to cleanup_experiment_cache; unknown process outcomes require recovery first.',
    parameters: { server_id: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Preview environment cache cleanup', kind: 'other', rawInput: args }),
    execute: async args => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'environment-preview')) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'cleanup_experiment_cache',
    description: 'Clean only the assigned node candidates from preview_experiment_cache_cleanup after checking references and process exit again. Use operation_id (UUID) and the exact preview fingerprint; repeat identical inputs to read the original result after a lost reply. Low space does not bypass ownership or process checks. No arbitrary deletion path is accepted.',
    parameters: { server_id: { type: 'string', required: true }, operation_id: { type: 'string', required: true }, fingerprint: { type: 'string', required: true }, candidate_ids: { type: 'string' } }, output,
    presentCall: args => ({ card: 'generic', title: 'Clean environment cache', kind: 'other', rawInput: args }),
    execute: async args => {
      const serverId = serverIdSchema.parse(args.server_id)
      return JSON.stringify(await clusterNodeRequest(runtime, serverId, 'environment-cleanup', { experimentId: runtime.submission.experimentId,
        operationId: environmentOperationIdSchema.parse(args.operation_id), nodes: [{ serverId, fingerprint: deploymentIdSchema.parse(args.fingerprint),
          ...(args.candidate_ids === undefined ? {} : { candidateIds: z.array(z.string()).min(1).parse(JSON.parse(args.candidate_ids)) }) }] }))
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_experiment_file', description: 'Read a bounded relative file or log on an assigned node. Continue with the returned offset and generation; reset means rotation or missing data.',
    parameters: { server_id: { type: 'string', required: true }, path: { type: 'string' }, offset: { type: 'number', required: true }, generation: { type: 'string' } }, output, presentCall,
    execute: async args => { const chunk = clusterChunkSchema.parse(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), args.path === undefined ? 'log' : 'file', { offset: args.offset, path: args.path, generation: args.generation })); return JSON.stringify({ ...chunk, data: undefined, text: Buffer.from(chunk.data, 'base64').toString('utf8') }) } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'list_experiment_files', description: 'List output metadata under an assigned node workspace.', parameters: { server_id: { type: 'string', required: true } }, output, presentCall,
    execute: async args => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'files')) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'record_experiment_execution', description: 'Persist the actual framework version, script path, isolated environment, parameters, artifacts and evaluation metrics for this step. JSON fields: serverId, framework, version, script, environment, parameters (string values), artifacts, evaluation (numeric values).',
    parameters: { json: { type: 'string', required: true }, sources_json: { type: 'string', description: 'Optional JSON list of {serverId, path, purpose} referring to existing experiment-relative evidence files. Program-owned hashes are saved separately.' } }, output, presentCall,
    execute: async (args, execution) => {
      const entry = executionEntrySchema.parse(JSON.parse(args.json))
      if (!runtime.submission.nodes.some(node => node.server.id === entry.serverId)) throw new Error('execution node is outside this experiment')
      const inputs = z.array(completionSourceInputSchema).parse(JSON.parse(args.sources_json ?? '[]'))
      const sources = []
      for (const input of inputs) {
        if (input.serverId !== entry.serverId) throw new Error('Execution evidence source belongs to another node')
        const observed = z.object({ sha256: z.string(), generation: z.string(), bytes: z.number() }).parse(await clusterNodeRequest(runtime, input.serverId, 'completion-source', { path: input.path }, execution.signal))
        sources.push(completionSourceSchema.parse({ ...input, ...observed }))
      }
      const root = serverRunRoot(runtime.submission.coordinator, runtime.submission.experimentId)
      const pending = resolve(root, 'execution-record-pending.v1.json')
      executionRecorded(false)
      writeFileSync(pending, JSON.stringify(executionRecordPendingSchema.parse({ version: 1, experimentId: runtime.submission.experimentId, callId: execution.callId, entry })) + '\n', { mode: 0o600, flush: true })
      appendFileSync(resolve(root, 'execution-sources.v1.jsonl'), JSON.stringify(executionSourcesSchema.parse({ version: 1,
        experimentId: runtime.submission.experimentId, submissionHash: createHash('sha256').update(JSON.stringify(runtime.submission)).digest('hex'),
        sessionId: `aspera-execution-${runtime.submission.experimentId}`, entry, sources, recordedAt: Date.now(), callId: execution.callId })) + '\n', { mode: 0o600, flush: true })
      appendFileSync(resolve(root, 'executions.jsonl'), JSON.stringify(entry) + '\n', { mode: 0o600, flush: true })
      unlinkSync(pending)
      executionRecorded(true)
      return JSON.stringify(entry)
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'report_experiment_progress', description: 'Persist measured numeric metrics and the current phase. Do not invent measurements.', parameters: { phase: { type: 'string', required: true }, metrics_json: { type: 'string', required: true } }, output, presentCall,
    execute: async args => { const progress = progressSchema.parse({ phase: args.phase, metrics: JSON.parse(args.metrics_json), updatedAt: Date.now() }); writeClusterReceipt(config.root, runtime.submission.experimentId, progress, 'progress.json');
      saveMetricSample(serverRunRoot(runtime.submission.coordinator, runtime.submission.experimentId), { experimentId: runtime.submission.experimentId,
        serverId: runtime.submission.coordinator.id, time: progress.updatedAt, gpus: [], training: progress.metrics }, observationPolicySchema.parse(config.observations), 'training')
      return JSON.stringify(progress) } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'start_inference_service', description: 'Register a managed inference process on an assigned node. Reuse service_id on retries. Bind the model command to 127.0.0.1 on an unused port, supply its real HTTP health path and model artifact. Set publish=true only when public inference is requested and the node has a saved inferenceMapping. The node opens that mapping port on 0.0.0.0 with separate Bearer authentication and forwards to the private model port; never bind the model to the mapping port. model_name is the model API identifier. No credentials are returned. Check both local health and external reachability. Services survive Goal completion; no automatic restart.',
    parameters: { server_id: { type: 'string', required: true }, service_id: { type: 'string', required: true }, command: { type: 'string', required: true }, model_path: { type: 'string', required: true }, port: { type: 'number', required: true }, health_path: { type: 'string', required: true }, publish: { type: 'boolean' }, model_name: { type: 'string' } }, output, presentCall,
    execute: async (args, execution) => { const id = serviceIdSchema.parse(args.service_id); return JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'register-service', { id, command: args.command, modelPath: args.model_path, port: args.port, healthPath: args.health_path, publish: args.publish, modelName: args.model_name }, execution.signal)) } })))
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
  const policy = finalizationPolicySchema.parse(config.finalization ?? {})
  const budgetObservations: BudgetObservation[] = []
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId) return
    appendFileSync(resolve(root, 'events.jsonl'), JSON.stringify({ sessionId, source: planning ? 'plan' : 'execution', event }) + '\n', { mode: 0o600 })
    if (event.type === 'assistant/message') budgetObservations.length = 0
    if (event.type === 'turn/end' && event.data.reason.kind === 'max-tokens') budgetObservations.push({ seq: event.seq, reason: 'output-token-limit', detail: 'Program observed the single-output token limit; input context exhaustion is not established' })
    if (event.type === 'turn/end' && event.data.reason.kind === 'error' && event.data.reason.error.code === 'CONTEXT_WINDOW_EXCEEDED') budgetObservations.push({ seq: event.seq, reason: 'input-context-limit', detail: event.data.reason.error.message })
    if (event.type === 'compaction/end' && event.data.error !== undefined) budgetObservations.push({ seq: event.seq, reason: 'compaction-failure', detail: String(event.data.error) })
  }, { global: true })
  let handle: AgentHandle
  let settling = false
  let planSaved = false
  let executionRecordCommitted = true
  let executionProgress: ((signal: AbortSignal) => Promise<ExecutionProgressRead>) | undefined
  let waitCommands: ((signal: AbortSignal) => Promise<CommandWait[]>) | undefined
  const finishCorrections = new Map<string, number>()
  const approvedPlan = () => planSchema.parse(JSON.parse(readFileSync(resolve(root, 'approved-plan.json'), 'utf8')))
  const stages = new StageRegistry(root, id, sessionId, {
    source: async (serverId, path, purpose, signal) => {
      const value = z.object({ sha256: z.string(), generation: z.string(), bytes: z.number(), text: z.string(), truncated: z.boolean() })
        .parse(await clusterNodeRequest(runtime, serverId, 'stage-source', { path, metadataOnly: purpose === 'artifact' }, signal))
      return { source: completionSourceSchema.parse({ serverId, path, purpose, sha256: value.sha256, generation: value.generation, bytes: value.bytes }), text: value.text, truncated: value.truncated }
    },
    command: async (serverId, commandId, signal) => (await clusterCommandStatuses(runtime, signal)).find(node => node.serverId === serverId)?.commands.find(command => command.commandId === commandId),
  }, policy)
  const executionEntries = () => {
    const path = resolve(root, 'executions.jsonl')
    const history = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => executionEntrySchema.parse(JSON.parse(line))) : []
    return [...new Map(history.map(entry => [entry.serverId, entry])).values()]
  }
  const environmentChecks = async (signal: AbortSignal) => {
    const entries = executionEntries()
    return Promise.all(runtime.submission.nodes.map(async node => ({ serverId: node.server.id, ...z.object({ verified: z.boolean(), detail: z.string().optional() })
      .parse(await clusterNodeRequest(runtime, node.server.id, 'environment-acceptance',
        { environments: entries.filter(entry => entry.serverId === node.server.id).map(entry => entry.environment) }, signal)) })))
  }
  const inspectCompletion = async (signal: AbortSignal) => {
    const submission = runtime.submission
    if (submission.protocol !== 4) throw new Error('Completion verification requires the original protocol-4 submission')
    const plan = planSchema.parse(JSON.parse(readFileSync(resolve(root, 'approved-plan.json'), 'utf8')))
    const progress = await executionProgress?.(signal)
    const services = (await Promise.all(runtime.submission.nodes.map(async node => z.array(serviceSchema).parse(await clusterNodeRequest(runtime, node.server.id, 'services', {}, signal))))).flat()
    const issues: import('@aspera/experiments').CompletionIssue[] = []
    const stageChecks = []
    for (const requirement of plan.stages ?? []) for (const node of submission.nodes) {
      const registration = stages.list().find(value => value.serverId === node.server.id && value.stageId === requirement.stageId && value.planRevision === plan.revision)
      if (registration === undefined) issues.push({ code: 'stages', serverId: node.server.id, detail: 'Approved training stage has no registration: ' + requirement.stageId,
        remedy: 'Register the actual stage before launch; historical work requires independent supplementary verification, never a new training run.' })
      else {
        const checked = await stages.verify(registration, signal); stageChecks.push(checked)
        for (const failure of checked.checks.filter(value => !value.passed)) issues.push({ code: 'stages', serverId: node.server.id, detail: requirement.stageId + ': ' + failure.detail,
          remedy: 'Read the exact source and approved stage requirements. Correct evidence or verification semantics without lowering requirements or repeating completed training.' })
      }
    }
    if (!executionRecordCommitted || existsSync(resolve(root, 'execution-record-pending.v1.json'))) issues.push({ code: 'execution', detail: 'An execution record write has not committed.',
      remedy: 'Read the tool error and repeat record_experiment_execution using the same existing evidence; never rerun training.' })
    for (const entry of executionEntries()) {
      const node = submission.nodes.find(node => node.server.id === entry.serverId)
      if (node === undefined) continue
      const workspace = node.server.storagePlacement?.workspaceRoot ?? posix.join(node.server.remoteRoot!, 'runs', id, 'workspace')
      const path = posix.isAbsolute(entry.script) ? posix.relative(workspace, entry.script) : entry.script
      try { await clusterNodeRequest(runtime, entry.serverId, 'completion-source', { path }, signal) }
      catch (error) { issues.push({ serverId: entry.serverId, code: 'results', detail: 'Recorded script cannot be independently read: ' + String(error), remedy: 'Record the existing script path from this workspace; do not recreate or rerun training.' }) }
      if (entry.artifacts.length > 0) {
        const result = z.object({ files: z.array(clusterFileSchema), truncated: z.boolean() }).parse(await clusterNodeRequest(runtime, entry.serverId, 'files', {}, signal))
        for (const artifact of entry.artifacts) {
          const relative = posix.isAbsolute(artifact) ? posix.relative(workspace, artifact) : artifact
          if (relative.split('/').includes('..') || !result.files.some(file => file.size > 0 && (file.path === relative || file.path.startsWith(relative.replace(/\/$/, '') + '/')))) {
            issues.push({ serverId: entry.serverId, code: 'results', detail: `Recorded artifact cannot be confirmed${result.truncated ? ' within the file discovery limit' : ''}: ${artifact}`,
              remedy: 'Read the existing saved artifact and record its exact path; missing output cannot be replaced with a completion claim.' })
          }
        }
      }
    }
    const sourceFile = resolve(root, 'execution-sources.v1.jsonl')
    const sourceHistory = existsSync(sourceFile) ? readFileSync(sourceFile, 'utf8').split('\n').filter(Boolean).map(line => executionSourcesSchema.parse(JSON.parse(line))) : []
    for (const saved of new Map(sourceHistory.map(source => [source.entry.serverId, source])).values()) {
      if (saved.experimentId !== id || saved.sessionId !== sessionId
        || saved.submissionHash !== createHash('sha256').update(JSON.stringify(runtime.submission)).digest('hex')) throw new Error('Execution source identity differs from the original submission or Session')
      if (!executionEntries().some(entry => JSON.stringify(entry) === JSON.stringify(saved.entry))) issues.push({ code: 'execution', serverId: saved.entry.serverId,
        detail: 'Execution entry and source journal do not refer to the same committed record.', remedy: 'Record the actual existing execution evidence again; do not repeat settled work.' })
      for (const source of saved.sources) {
        const current = z.object({ sha256: z.string(), generation: z.string() }).parse(await clusterNodeRequest(runtime, source.serverId, 'completion-source', { path: source.path }, signal))
        if (source.sha256 !== current.sha256 || source.generation !== current.generation) issues.push({ serverId: source.serverId, code: 'sources',
          detail: 'Execution evidence changed: ' + source.path, remedy: 'Read the original file and save an accurate execution entry with its current evidence; do not repeat training.' })
      }
    }
    return { services, stageChecks, check: checkExperimentCompletion({ submission: runtime.submission, planRevision: plan.revision, planSteps: plan.steps.length, stages: plan.stages ?? [],
      sessionId, ...(progress?.progress === undefined ? {} : { progress: progress.progress }), entries: executionEntries(),
      nodes: await clusterCommandStatuses(runtime, signal), environments: await environmentChecks(signal), services, issues }) }
  }
  const finish = (state: 'completed' | 'blocked' | 'failed', detail?: string) => {
    if (settling) return
    settling = true
    void settle(state, detail).catch((error: unknown) => {
      ctx.logger.error(String(error)); writeClusterReceipt(config.root, id, { state: 'failed', detail: String(error) }, planning ? 'planning-outcome.json' : 'outcome.json'); process.kill(process.pid, 'SIGTERM')
    })
  }
  if (runtime.submission.protocol !== 4) throw new Error('Legacy experiments must retain their original model runtime')
  const snapshot = runtime.submission.models[planning ? 'planning' : 'execution']
  const selection = { provider: snapshot.provider, model: snapshot.model,
    ...(snapshot.reasoningEffort === undefined ? {} : { reasoningEffort: snapshot.reasoningEffort }) }
  const modelScope = await openPhaseModelContext(ctx, snapshot, config.agentContext)
  ctx.effect(() => modelScope.dispose, 'Aspera phase provider')
  handle = await modelScope.context.agents.create({ sessionId, meta: { cwd: resolve(root, 'agent-workspace'), agentPreset: 'aspera-single' },
    agentOptions: { provider: selection.provider, model: selection.model }, setup: async (agentCtx, agent) => {
      await ctx.agentPresets.mount(agentCtx, 'aspera-single')
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      agentCtx.tools.restrict({ allow: [] })
      installKnowledge(agentCtx, runtime, config)
      if (!planning) {
        installNodeTools(agentCtx, runtime, config, committed => { executionRecordCommitted = committed })
        waitCommands = installExecutionCommands(agentCtx, runtime, config, (serverId, commandId, signal) => stages.beforeLaunch(serverId, commandId, signal))
        executionProgress = installExecutionSteps(agentCtx, runtime, config, sessionId, readFileSync(resolve(config.root, 'state/coordinator.generation'), 'utf8'))
        agentCtx.effect(() => agentCtx.tools.register(defineTool({ name: 'register_experiment_stage',
          description: 'Register actual training-stage evidence BEFORE its command starts. json: stageId, serverId, attemptId, commandId, parameters, trainerState, metrics, optional resumeState/samples/attemptLabel/evaluation/inference/baseControl. Continuing also checks optimizer.pt, scheduler.pt and rng_state.pth beside resumeState; optimizerState/schedulerState/rngState may select actual filenames in that same checkpoint. Paths are workspace-relative. Requirements come only from approved plan.stages; cumulative endStep and additionalSteps are distinct. Continuing a scheduler does not restart warmup. This tool never launches training or accepts a changed approved target.',
          parameters: { json: { type: 'string', required: true } }, output, presentCall,
          execute: async (args, execution) => JSON.stringify(await stages.register(stageRegistrationInputSchema.parse(JSON.parse(args.json)), approvedPlan(), execution.signal)) })))
        agentCtx.effect(() => agentCtx.tools.register(defineTool({ name: 'verify_experiment_stage',
          description: 'Independently verify an approved stage against its original command, cumulative and additional optimizer steps, recorded metrics, effective parameters, scheduler and sample semantics. Missing or conflicting evidence remains unverified. json: serverId, stageId. This does not run training or change any target.',
          parameters: { json: { type: 'string', required: true } }, output, presentCall,
          execute: async (args, execution) => {
            const input = z.object({ serverId: serverIdSchema, stageId: experimentStageIdSchema }).strict().parse(JSON.parse(args.json))
            const registration = stages.list().find(value => value.serverId === input.serverId && value.stageId === input.stageId)
            if (registration === undefined) throw new Error('Approved stage has not been registered')
            return JSON.stringify(await stages.verify(registration, execution.signal))
          } })))
        agentCtx.effect(() => agentCtx.tools.register(defineTool({ name: 'inspect_experiment_completion',
          description: 'Read the program completion checks for every original node. Missing execution records require record_experiment_execution using existing logs and results, not another training run. Step reports, Markdown reports and finish detail do not save execution evidence.',
          parameters: {}, output, presentCall, execute: async (_args, execution) => JSON.stringify((await inspectCompletion(execution.signal)).check) })))
      }
      installExperimentQuestions(agentCtx, ctx, agent, runtime, config, planning, error => { finish('failed', `Operator question could not be delivered: ${String(error)}`) })
      agentCtx.effect(() => agentCtx.tools.register(defineTool({ name: planning ? 'save_experiment_plan' : 'finish_experiment',
        description: planning ? 'Save the version-specific plan without running commands. plan_json: summary, steps (strings), frameworks ([{name,version,documentation:HTTPS URL}]), stages for Transformers training. Each stage: stageId,planStep,title,framework:"transformers",startStep,additionalSteps,endStep,metricScope:"stage"|"cumulative",loggingSteps,scheduler:{mode:"fresh"|"continue"|"restart",type:"cosine"|"linear"|"constant",learningRate,warmupSteps,totalSteps}; optional samples:{unit,meaning,expectedCount,basis,perDeviceBatchSize,gradientAccumulationSteps,worldSize,datasetSize?,firstIndex?}, requiredFiles and results:{evaluationSamples?,inferencePrompts?,baseControl?}. Freeze permitted choices before approval. startStep+additionalSteps=endStep; continuing a scheduler retains its original horizon and warmup. Optional conditionalSteps [{step,trigger:"command-failure",commandIds}] declares conditional work. The objective and servers stay fixed. Semi mode requires approval.' : 'Request finalization after inspecting actual results. completed requires independent node, stage, execution and step checks. blocked also waits for original commands and checks evidence; it cannot bypass missing finalization reports. Provide reason and actual evidence_seqs_json for budget claims. Unsupported context/budget explanations request correction. Never repeat settled training to fill records. Healthy registered inference services survive completion.',
        parameters: { status: { type: 'string', enum: ['completed', 'blocked'], required: true }, detail: { type: 'string' }, plan_json: { type: 'string' },
          reason: { type: 'string', enum: ['requirement', 'input-context-limit', 'output-token-limit', 'program-budget', 'compaction-failure', 'agent-report'] }, evidence_seqs_json: { type: 'string' } }, output, presentCall,
        execute: async (args, execution) => {
          let finalDetail = args.detail
          if (!planning) {
            const waits = await waitCommands?.(execution.signal)
            const checked = await inspectCompletion(execution.signal), nodes = await clusterCommandStatuses(runtime, execution.signal)
            const activeCommands = nodes.flatMap(node => node.commands.filter(command => !command.released
              && !checked.services.some(service => service.serverId === node.serverId && service.commandId === command.commandId)).map(command => node.serverId + '/' + command.commandId))
            const key = args.reason ?? reportedFinishReason(args.detail ?? '')
            const decision = decideExperimentFinish({ experimentId: id, sessionId, requested: args.status === 'completed' ? 'completed' : 'blocked', detail: args.detail ?? '',
              ...(args.reason === undefined ? {} : { reason: finishReasonSchema.parse(args.reason) }),
              ...(args.evidence_seqs_json === undefined ? {} : { evidenceSeqs: z.array(z.number().int().nonnegative()).parse(JSON.parse(args.evidence_seqs_json)) }),
              observations: budgetObservations, check: checked.check, activeCommands, corrections: finishCorrections.get(key) ?? 0, policy, facts: { checked, nodes } })
            await writeFileAtomic(resolve(root, 'finish-decision.v1.json'), JSON.stringify(decision) + '\n', { mode: 0o600 })
            if (!['accepted', 'agent-incomplete'].includes(decision.decision)) {
              finishCorrections.set(key, (finishCorrections.get(key) ?? 0) + 1)
              return JSON.stringify({ state: 'active', decision, check: checked.check, waits })
            }
            const final = await inspectCompletion(execution.signal), finalNodes = await clusterCommandStatuses(runtime, execution.signal)
            if (JSON.stringify(nodes) !== JSON.stringify(finalNodes)
              || JSON.stringify(checked.stageChecks.map(value => value.sources)) !== JSON.stringify(final.stageChecks.map(value => value.sources))
              || JSON.stringify(checked.check.issues) !== JSON.stringify(final.check.issues)) return JSON.stringify({ state: 'active', detail: 'Finalization facts changed during verification; inspect the original results again without restarting commands', check: final.check })
            finalDetail = decision.detail
          }
          if (planning && args.status === 'completed') {
            const plan = planSchema.parse({ ...z.object({ summary: z.string(), steps: z.array(z.string()), frameworks: planSchema.shape.frameworks, stages: planSchema.shape.stages, conditionalSteps: planSchema.shape.conditionalSteps }).strict().parse(JSON.parse(args.plan_json ?? '{}')), revision: 1, createdAt: Date.now() })
            if (plan.stages?.some(stage => stage.planStep > plan.steps.length) || new Set(plan.stages?.map(stage => stage.stageId)).size !== (plan.stages?.length ?? 0)) throw new Error('Training stages must have unique identities and refer to actual plan steps')
            if (plan.conditionalSteps?.some(step => step.step > plan.steps.length) || new Set(plan.conditionalSteps?.map(value => value.step)).size !== (plan.conditionalSteps?.length ?? 0)) throw new Error('Conditional steps must uniquely refer to actual approved plan steps')
            if (plan.frameworks.some(framework => /^(?:ms-swift|swift|transformers|peft)$/i.test(framework.name)) && !plan.stages?.length) throw new Error('A training plan must include structured stages with cumulative/additional steps and scheduler requirements before approval')
            writeClusterReceipt(config.root, id, { plan, sessionId }, 'plan.json'); planSaved = true
          }
          const goal = ctx.goals.get(handle.agent)
          if (goal === undefined) throw new Error('experiment Goal is missing')
          if (args.status === 'blocked') ctx.goals.block(handle.agent, { id: goal.id, revision: goal.revision }, { code: 'aspera-requirement', message: finalDetail ?? 'Requirements cannot be met within the assigned resources.' })
          else ctx.goals.complete(handle.agent, { id: goal.id, revision: goal.revision })
          return JSON.stringify({ state: args.status, detail: finalDetail })
        } })))
    } })
  ctx.effect(() => () => handle.dispose(), 'Aspera Agent handle')
  async function settle(state: 'completed' | 'blocked' | 'failed', detail?: string): Promise<void> {
    await handle.agent.whenIdle(); await ctx.sessionPersistence.flush()
    let unknownCommands: string[] = []
    if (!planning && waitCommands !== undefined) {
      try { unknownCommands = (await waitCommands(new AbortController().signal)).filter(wait => wait.state !== 'settled').map(wait => wait.serverId + '/' + wait.commandId) }
      catch (error) { unknownCommands = ['unconfirmed-node-command-state']; detail = 'Original command exits could not be read: ' + String(error) }
      if (unknownCommands.length > 0) { state = 'blocked'; detail = [detail, 'Finalization stopped with unconfirmed original command exits; allocation release remains unconfirmed.'].filter(Boolean).join('\n') }
    }
    let services: InferenceService[] = []
    if (state === 'completed' && planning && !planSaved) { state = 'failed'; detail = 'Planning completed without a durable plan.' }
    if (!planning) {
      let checked: Awaited<ReturnType<typeof inspectCompletion>>
      try { checked = await inspectCompletion(new AbortController().signal) }
      catch (error) { checked = { services: [], stageChecks: [], check: { version: 1, ready: false, checkedAt: Date.now(), issues: [{ code: 'release', detail: String(error), remedy: 'Read the original command and resource records before retrying finalization; do not restart work' }] } } }
      services = checked.services
      if (state === 'completed' && !checked.check.ready) { state = 'failed'; detail = 'Completion verification failed: ' + checked.check.issues.map(issue => `${issue.code}: ${issue.detail}`).join('; ') }
      const path = resolve(root, 'finish-decision.v1.json')
      const prior = existsSync(path) ? finishDecisionSchema.parse(JSON.parse(readFileSync(path, 'utf8'))) : undefined
      const reason = budgetObservations.at(-1)?.reason ?? prior?.reason ?? 'agent-report'
      const decision = decideExperimentFinish({ experimentId: id, sessionId, requested: state === 'completed' ? 'completed' : 'blocked', detail: detail ?? '', reason,
        observations: budgetObservations, check: checked.check, activeCommands: unknownCommands, corrections: prior?.corrections ?? 0, policy, facts: checked })
      if (!['accepted', 'wait', 'agent-incomplete'].includes(decision.decision)) decision.decision = 'agent-incomplete'
      await writeFileAtomic(path, JSON.stringify({ ...decision, detail: [decision.detail, detail].filter(Boolean).join('\n') }) + '\n', { mode: 0o600 })
    }
    writeClusterReceipt(config.root, id, { state: state === 'completed' && services.some(service => !service.released) ? 'serving' : state, detail }, planning ? 'planning-outcome.json' : 'outcome.json')
    await handle.dispose(); process.kill(process.pid, 'SIGTERM')
  }
  ctx.on('goal/changed', ({ agent, change }) => { if (agent !== handle.agent) return; if (change.goal?.phase === 'complete') finish('completed'); if (change.goal?.phase === 'blocked') finish('blocked', change.goal.blockedReason?.message) })
  ctx.on('session/event', async (session, event) => {
    if (session.id !== handle.agent.session.id || settling || event.type !== 'turn/end' || event.data.reason.kind !== 'max-tokens') return
    // Goal mutations append to this Session after its current event publication completes.
    await Promise.resolve()
    if (settling) return
    const detail = `${planning ? 'planning' : 'execution'}: Agent stopped at the model token limit (max-tokens) before completing the experiment. Inspect its Session and command results; existing commands were not restarted.`
    try {
      const current = ctx.goals.get(handle.agent)
      if (current?.phase === 'active') ctx.goals.block(handle.agent, { id: current.id, revision: current.revision }, { code: 'aspera-model-token-limit', message: detail })
      else finish('blocked', detail)
    } catch (error: unknown) { finish('failed', `${detail} Could not persist the blocked Goal: ${String(error)}`) }
  }, { global: true })
  const retryLifetime = new AbortController()
  ctx.effect(() => () => { retryLifetime.abort(new Error('Experiment stopped')) }, 'Aspera: transient retry')
  ctx.on('agent/error', ({ agent, error }) => {
    if (agent !== handle.agent || settling) return
    if (!(error instanceof HarnessError) || !['RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE'].includes(error.code)) {
      finish('failed', `${planning ? 'planning' : 'execution'}: Agent failed: ${String(error)}; inspect this experiment Session.`); return
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
  if (runtime.submission.protocol !== 4) throw new Error('Legacy experiments must retain their original release')
  installGoalContinuation(ctx, handle.agent, config.goalContinuationWindow)
  const goal = ctx.goals.create(handle.agent, { objective: runtime.submission.objective, maxGoalRounds: config.goalContinuationWindow })
  let approved = ''
  if (!planning) approved = readFileSync(resolve(root, 'approved-plan.json'), 'utf8')
  handle.agent.followup(createUserMessage({ source: { kind: 'aspera', experimentId: id }, content: [{ type: 'text', text:
    `${planning ? 'Prepare a plan only. You cannot launch commands in this role.' : 'Execute the approved plan on every selected node as one joint experiment.'}\n`
    + `Requirements: ${JSON.stringify(runtime.submission)}\nApproved plan: ${approved}\n`
    + (planning ? 'For Transformers or ms-swift training, save structured plan.stages as described by save_experiment_plan. Distinguish restored startStep, additionalSteps and cumulative endStep. Freeze the scheduler mode and horizon, metric coverage, sample counting basis, result requirements and any conditional steps before approval. '
      : 'Read get_experiment_execution_progress before starting. Report every approved-plan step as running before work, completed after checking its results, or blocked with a concrete reason. Use the returned revision for each report and re-read on a revision conflict. Register each approved training stage on each node before its command, providing complete effective parameter JSON and actual trainer state, metrics, sample and result paths. verify_experiment_stage independently checks the approved arithmetic and restored scheduler; continuing does not repeat initial warmup. Ordinary command tools wait for actual terminal exit and cleanup without another model request. Use run_experiment_command_group to launch all distributed participants before waiting. Do not use shell sleep or repeated empty log reads to wait. Step reports are Agent claims; command and result acceptance still decides completion. Before finishing, call inspect_experiment_completion and record_experiment_execution on EVERY selected node with actual framework, version, script, environment, effective parameters, artifacts and evaluation. A Markdown report, plan_json or finish detail does not save execution evidence. For success all necessary checks and step reports must pass. A real independently evidenced failure may end blocked with unfinished steps; missing reports and unsupported budget claims require correction. Never repeat a settled command merely to repair a missing report. ')
    + 'Read shipped framework guidance and the exact version documentation. Use inspect_experiment_environment and prepare_experiment_environment to create/install/verify training on each node. create preserves existing direct requirements and installs the merged requirements; install explicitly adjusts the requirement set. The program executes uv with a separate fixed-pip installer; training contains only requested dependencies. Reuse training and verified materials. Request actual dependencies, key imports and required CUDA checks. prepare_experiment_environment waits internally for the final receipt, real process exit and admission release; do not issue shell commands to wait or poll during installation. Empty requirements verify only a base interpreter. On failure or unknown outcome inspect/recover the original operation, then reverify. Unchanged package conflicts require repairing their reported cause; changing operation IDs, unrelated dependencies or create/install is insufficient. Do not create a second venv, copy wheels or install through ordinary shell commands. If space is insufficient, use the owned cleanup preview and tool. Always use the returned absolute interpreter. User-site installation is disabled; never fall back to .local, overwrite a legacy environment or write shared dependencies directly. Use make-writable for specific files with all commands/services stopped. Verify a short run before long training. Record actual versions, scripts, dependencies, parameters, artifacts and evaluation. '
    + 'Before new installations or downloads, inspect account-side storage and historical environments; do not infer absence from sandbox find. A matching released historical environment is borrowed read-only as training without installing or copying dependencies. Optional reuseCandidateId selects a program-issued candidate; never change its source. Inspect the pinned model/dataset manifests, assess_experiment_storage with all material IDs, environment requirements and output/checkpoint budgets, then prepare_experiment_materials. Unknown training capacity remains pending. Each physical volume must fit independently. Both installation and download tools enforce program checks even if inspection was omitted. Use returned local material paths and offline framework loading (HF_HUB_OFFLINE=1 and TRANSFORMERS_OFFLINE=1) to prevent duplicate downloads. Download failures retain the original operation ID and verified shards. Historical cleanup uses selected candidate IDs from a fresh preview; retain unique usable materials and all previous environments, results and logs. '
    + 'For multiple nodes, preserve stable ranks, shared rendezvous and verify a real collective communication test. Never reduce the node group or change explicit training requirements. '
    + (runtime.submission.strategy.mode === 'semi' ? 'When independent investigation cannot resolve a choice, use ask_user_question to pause for a desktop reply. A reply cannot change explicit requirements or grant permissions. ' : 'Human waiting is disabled. Decide unspecified parameters within the constraints, retry recoverable errors and use short measured runs to adjust. ')
    + 'There is no total task runtime, command or round budget. Do not install Harness plugins, change the control service environment, or detach unmanaged processes. Preserve specified models, data, training methods and servers. Mark blocked with a concrete reason and evidence when constraints cannot be satisfied; use a new experiment for changed requirements. '
    + 'An inference model must bind to 127.0.0.1 and pass its HTTP health check before completion. If external access is requested, use the saved node inferenceMapping with publish=true and verify external.state=reachable before reporting it usable. Never infer a platform URL from a private IP or SSH port. The node gateway manages authentication; do not print or request credentials. Ordinary commands must settle. Use the finish tool to persist the final outcome.' }] }))
  await ctx.sessionPersistence.flush()
  writeClusterReceipt(config.root, id, { sessionId, goalId: goal.id }, planning ? 'planning-started.json' : 'started.json')
}
