import { storagePolicyProposalRequestSchema, storagePolicyPreserves, storagePolicyRecordSchema, storagePolicyStatusSchema } from '@aspera/experiments'
import { waitForStoragePolicy } from './storage-policy-wait.ts'
import type { ExperimentStoragePolicy } from '@aspera/experiments'
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
import { verifyStorageRegistrationSchema } from '@aspera/experiments'
import { clusterChunkSchema, serverIdSchema, planSchema, executionEntrySchema, progressSchema, serviceSchema } from '@aspera/experiments'
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
import { installServiceVerificationTool } from './service-verification-tool.ts'
import { installInferenceServiceTools } from './inference-service-tools.ts'
import { readCommandOutput } from './command-output.ts'
import { StageRegistry } from './stage-runtime.ts'
import { finalizationPolicySchema } from './finalization-policy.ts'
import { decideExperimentFinish, reportedFinishReason } from './finish-decision.ts'
import type { BudgetObservation } from './finish-decision.ts'
import type { CommandWait } from '@aspera/experiments'
import { storageInspectionScopeSchema, requirementEvidenceReferenceSchema, requirementEvidenceSchema } from '@aspera/experiments'
import type { RequirementEvidence } from '@aspera/experiments'
import { storageToolResult, storageToolPageSchema } from './storage-tool-result.ts'
import { documentationReadSchema } from '@aspera/experiments'
import { PlanDraft } from './plan-draft.ts'
import { FrameworkDocumentation, resolveDocumentationPolicy } from './framework-documentation.ts'
import { installPlanTools, planningToolParameters } from './plan-tools.ts'
import { readSubmittedInput, submittedInputReadSchema } from './submitted-input.ts'
import { loadPlanRequirements, assertSubmittedPlanRequirements } from './plan-requirements.ts'

const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera node operation', kind: 'other' as const, rawInput: args })

function installKnowledge(ctx: Context, runtime: ClusterPrivate, config: ClusterRuntimeConfig, sessionId: SessionId): void {
  const limits = resolveDocumentationPolicy(runtime.documentationPolicy, config)
  const documents = new FrameworkDocumentation(serverRunRoot(runtime.submission.coordinator, runtime.submission.experimentId),
    { experimentId: runtime.submission.experimentId, deploymentId: runtime.submission.deploymentId, sessionId },
    { ...limits, documentationHosts: config.documentationHosts, documentationBytes: config.documentationBytes })
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_framework_guidance', description: 'Read shipped guidance for generic version-pinned Megatron, MS-SWIFT or Unsloth preparation. Framework parameters are chosen from documentation and verified with short runs.',
    parameters: { framework: { type: 'string', enum: ['megatron', 'swift', 'unsloth'], required: true } }, output, presentCall,
    execute: async args => readFileSync(new URL(`../skills/${args.framework}/SKILL.md`, import.meta.url), 'utf8') })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_framework_documentation', description: 'Read allowlisted HTTPS version-specific documentation with an independent total deadline. Results are original bounded text pages, not summaries. Use returned next cursors or query to locate text in a saved snapshot. Successful reads are cached. refresh=true fetches a new snapshot; retry=true explicitly retries a failed read. Failures never cause hidden retries. Record the exact version and URL in the plan.',
    parameters: planningToolParameters(documentationReadSchema), output, presentCall,
    execute: async (args, execution) => JSON.stringify(await documents.read(documentationReadSchema.parse(args), execution.signal)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_experiment_requirements', description: 'Read immutable objective, node inventory, execution mode, versions and input digests. It returns no credentials.', parameters: {}, output, presentCall,
    execute: async () => JSON.stringify(runtime.submission) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_experiment_input', description: 'Read a declared input as bounded UTF-8 text without a shell or training allocation. Begin at offset=0; follow returned nextOffset and generation until eof. Large JSON is paged text, not a complete object per page. Use encoding=base64 explicitly for binary files. Only submitted input basenames are available.',
    parameters: planningToolParameters(submittedInputReadSchema), output, presentCall,
    execute: async args => {
      const folder = resolve(serverRunRoot(runtime.submission.coordinator, runtime.submission.experimentId), 'inputs')
      return JSON.stringify(readSubmittedInput(folder, runtime.submission.inputs.map(input => input.name), args, Math.min(config.chunkBytes, limits.documentationPageBytes)))
    } })))
}

function installNodeTools(ctx: Context, runtime: ClusterPrivate, config: ClusterRuntimeConfig, executionRecorded: (committed: boolean) => void,
  evidenceContext: () => { sessionId: string; planRevision: number }, approvedStoragePolicy: () => ExperimentStoragePolicy | undefined): void {
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'verify_experiment_storage',
    description: 'Verify a root observed by inspect_experiment_storage. json: operationId UUID, rootId, observationId. Preserve fixed placement: a live mount replacement cannot change this experiment. A copied historical root receives a new registration after owner, mount and writer checks; discover candidates again and reverify content. This does not release resources or prove materials absent.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output, presentCall,
    execute: async (args, execution) => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'storage-register',
      verifyStorageRegistrationSchema.parse(JSON.parse(args.json)), execution.signal)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_experiment_environment',
    description: 'Read registered Python environments, historical read-only borrowing candidates, reuse plans, immutable installation materials and account-side disk usage on an assigned node. A directory hidden by the command sandbox is not absent on the server. Returns complete bounded JSON and saved detail pages. Read inline scalar values directly; pass a returned details or page object as details_json for complete original fields, including installation/recovery results. Optional operation_id reads only that original operation, deadline, process exit and admission status without scanning packages. This is read-only. An unresolved outcome requires recovery of the original operation before another mutation.',
    parameters: { server_id: { type: 'string', required: true }, operation_id: { type: 'string' }, details_json: { type: 'string' } }, output,
    presentCall: args => ({ card: 'generic', title: 'Inspect training environment', kind: 'other', rawInput: args }),
    execute: async (args, execution) => {
      const serverId = serverIdSchema.parse(args.server_id)
      const runRoot = serverRunRoot(runtime.submission.coordinator, runtime.submission.experimentId)
      if (!runtime.submission.nodes.some(node => node.server.id === serverId)) throw new Error('Storage inspection server is outside this experiment allocation')
      if (args.details_json !== undefined) return JSON.stringify(await storageToolResult({ runRoot, serverId,
        experimentId: runtime.submission.experimentId, page: storageToolPageSchema.parse(JSON.parse(args.details_json)), maxBytes: config.storageToolResultBytes, archiveServerId: runtime.submission.coordinator.id }))
      const value = await clusterNodeRequest(runtime, serverId, args.operation_id === undefined ? 'environment-inspect' : 'environment-status',
        args.operation_id === undefined ? {} : { operationId: environmentOperationIdSchema.parse(args.operation_id) }, execution.signal)
      return JSON.stringify(await storageToolResult({ runRoot, serverId,
        experimentId: runtime.submission.experimentId, value, maxBytes: config.storageToolResultBytes, archiveServerId: runtime.submission.coordinator.id }))
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_experiment_storage',
    description: 'Discover owned storage outside the command sandbox. Optional scope_json selects {kind:"account"}, {kind:"experiment",experimentId}, or {kind:"directory",rootId,relativePath} under a confirmed root. You choose the scope and investigation order. Returned materialCandidates are unverified references for inspect/prepare_experiment_materials. refresh starts a bounded scan; cursor continues the same node, scope and mount identity. Incomplete discovery cannot establish absence or ownership of unattributed bytes. Targeted reuse does not require a complete account scan.',
    parameters: { server_id: { type: 'string', required: true }, refresh: { type: 'boolean' }, cursor: { type: 'string' }, scope_json: { type: 'string' } }, output,
    presentCall: args => ({ card: 'generic', title: 'Inspect server storage', kind: 'other', rawInput: args }),
    execute: async (args, execution) => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'storage-inspect',
      { ...(args.refresh === undefined ? {} : { refresh: args.refresh }), ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
        ...(args.scope_json === undefined ? {} : { scope: storageInspectionScopeSchema.parse(JSON.parse(args.scope_json)) }) }, execution.signal)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_experiment_storage_policy',
    description: 'Read the node approved policy and pending proposals. This node has approved retained content and pending revisions. Byte estimates can change without reducing the retained contents. An Agent cannot approve its own proposal.',
    parameters: { server_id: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Read retained experiment content', kind: 'other', rawInput: args }),
    execute: async (args, execution) => JSON.stringify(storagePolicyStatusSchema.parse(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'storage-policy-status',
      { evidenceContext: evidenceContext(), approvedStoragePolicy: approvedStoragePolicy() }, execution.signal))) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'propose_experiment_storage_policy',
    description: 'Propose retained contents, not arbitrary byte reductions. json: operationId UUID, expectedRevision, reason and policy {artifact:adapter|full-model|other,checkpointCount,optimizerState,schedulerState,recoveryPoints,outputMinimumBytes,checkpointMinimumBytes,basis}. Required-content reductions need Host approval under the experiment confirmation policy. The tool waits for manual approval or rejection; do not poll the model or start another proposal. Never approve through shell or HTTP. Read the current policy first.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Request retained-content revision', kind: 'other', rawInput: args }),
    execute: async (args, execution) => {
      const request = storagePolicyProposalRequestSchema.parse(JSON.parse(args.json)), serverId = serverIdSchema.parse(args.server_id)
      const proposal = storagePolicyRecordSchema.parse(await clusterNodeRequest(runtime, serverId, 'storage-policy-propose', { ...request, evidenceContext: evidenceContext(), approvedStoragePolicy: approvedStoragePolicy() }, execution.signal))
      const original = approvedStoragePolicy()
      if (runtime.submission.strategy.mode !== 'automatic' || original === undefined || !storagePolicyPreserves(original, request.policy)) return JSON.stringify(await waitForStoragePolicy({ proposal,
        policy: managedEnvironmentPolicySchema.parse(config.managedEnvironments ?? {}), signal: execution.signal,
        read: async signal => {
          const status = storagePolicyStatusSchema.parse(await clusterNodeRequest(runtime, serverId, 'storage-policy-status', {}, signal))
          const selected = status.proposals.find(row => row.proposalId === request.operationId)
          if (selected === undefined) throw new Error('Original storage policy proposal is unavailable')
          return selected
        } }))
      return JSON.stringify(await clusterNodeRequest(runtime, serverId, 'storage-policy-decide', { proposalId: request.operationId,
        expectedRevision: request.expectedRevision, approve: original !== undefined && storagePolicyPreserves(original, request.policy), evidenceContext: evidenceContext() }, execution.signal))
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'assess_experiment_storage',
    description: 'Preview or commit capacity per filesystem. mode defaults to preview and does not reserve space. commit requires policyRevision selecting approved retained contents. First use prepare_experiment_environment action=verify-reuse; reuse evidence can reduce estimates without reducing retention. Partial model verification can contribute matching files. json: operationId UUID, environmentId training, requirements, materialIds, outputBytes, checkpointBytes; optional environmentEstimate {peakBytes,basis} and allowEnvironmentFallback. IDs in materialRequirements also join materialIds. A complete requirement set defaults assessmentScope to experiment; explicitly choose declared for a partial trial. Ready covers only the resolved scope. For experiment scope register materialRequirements {planRevision,complete,materials:[{kind,repository,revision,files?,materialId?}]}; unresolved requirements stay pending. Select verified sources with materialSources:[{materialId,verificationOperationId,mode:readonly|copy}]. Readonly requires every canonical file; copy can repair known missing files into a managed target. Unknown source files stay pending. Without materialSources, the result covers default assets only, not the absence of historical copies. Reuse the operationId for the same request. Only an unused training environment may fall back to system storage after measured admission; models, data, outputs and used directories retain their locations.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Assess storage capacity', kind: 'other', rawInput: args }),
    execute: async (args, execution) => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'storage-assess',
      { ...assessExperimentStorageSchema.parse(JSON.parse(args.json)), evidenceContext: evidenceContext(), approvedStoragePolicy: approvedStoragePolicy() }, execution.signal)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'inspect_experiment_materials',
    description: 'Inspect a fixed model or dataset manifest without hashing or downloading large files. json: kind model/dataset, provider huggingface, repository owner/name, immutable 40-character revision, optional files, configured HTTPS mirror and reuseCandidateId from targeted discovery. metadataSource auto (default), node, host or cache selects where canonical metadata is obtained. Inspection does not select a source for later calls. You may discover candidates before or after this call; pass the chosen reuseCandidateId directly to prepare_experiment_materials action verify without repeating inspection. An unverified candidate is not missing-download evidence. Host recovery uses the same persisted request and deadline. ModelScope can transfer digest-checked files but cannot attest a Hugging Face commit.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Inspect fixed model and data', kind: 'other', rawInput: args }),
    execute: async (args, execution) => {
      const serverId = serverIdSchema.parse(args.server_id)
      const request = inspectExperimentMaterialsSchema.parse(JSON.parse(args.json))
      const policy = managedEnvironmentPolicySchema.parse(config.managedEnvironments ?? {})
      const deadline = Date.now() + storageGovernancePolicySchema.parse(policy.governance ?? {}).metadataWaitTimeoutMs
      for (;;) {
        const result = await clusterNodeRequest(runtime, serverId, 'material-inspect', { ...request, evidenceContext: evidenceContext() }, execution.signal)
        const pending = z.object({ state: z.literal('metadata-pending') }).safeParse(result)
        if (!pending.success || Date.now() >= deadline) return JSON.stringify(result)
        await delay(policy.operationPollIntervalMs, undefined, { signal: execution.signal })
      }
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'prepare_experiment_materials',
    description: 'Verify, acquire or recover fixed material and wait for final process exit. json: operationId UUID, materialId, optional reuseCandidateId, action verify/acquire/recover. Read-only verify binds the explicit candidate regardless of earlier inspection; omitting reuseCandidateId automatically discovers and verifies owned equivalent sources, preferring minimum additional storage. Explicit candidates never switch sources on failure. It needs no budget and never downloads or publishes; it retains per-file checkpoints and the original deadline. fileResults distinguishes verified, missing, mismatch, unreadable and unverified files. Capacity assessment automatically uses a settled compatible verification; materialSources may explicitly bind its verification operationId. Acquire requires budgetId and uses its fixed source and readonly/copy mode, with retained source protection. Recover the same request after disconnects. Equivalent verification under another ID is rejected with the original operation ID; recover that operation without resetting its deadline. Do not download another copy with shell commands.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Prepare fixed model and data', kind: 'other', rawInput: args }),
    execute: async (args, execution) => {
      const serverId = serverIdSchema.parse(args.server_id)
      const request = prepareExperimentMaterialsSchema.parse(JSON.parse(args.json))
      return JSON.stringify(await prepareMaterialAndWait({ experimentId: runtime.submission.experimentId, serverId, operationId: request.operationId,
        materialId: request.materialId,
        policy: managedEnvironmentPolicySchema.parse(config.managedEnvironments ?? {}), signal: execution.signal,
        submit: signal => clusterNodeRequest(runtime, serverId, 'material-prepare', { ...request, evidenceContext: evidenceContext() }, signal),
        read: signal => clusterNodeRequest(runtime, serverId, 'material-status', { operationId: request.operationId }, signal) }))
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'prepare_experiment_environment',
    description: 'Prepare an isolated Python environment and wait for its final receipt, process exit and admission release. json: environmentId (normally training), operationId (UUID; identical content on retry), action verify-reuse/create/install/verify/make-writable/repair. Optional reuseCandidateId selects historicalEnvironments[].id; omit it for program-selected reuse. verify-reuse only checks the source and never publishes or installs. Its preflight status reusable/repair-required/incompatible/unknown guides your next choice, optional repairPlanId and recheckSource, requirements, modules, requireCuda, optional purpose/directory, files for make-writable. create installs requirements and merges existing direct constraints; install explicitly replaces the dependency requirements. Empty requirements verify only the base interpreter. The program owns uv commands, uses a separate fixed-pip installer and checks reuse and space. Training receives only requested dependencies. Unchanged deterministic package conflicts return the original operation and required repair before training creation or payload installation; changing operation ID or create/install cannot bypass this check. The tool waits internally; no model polling or shell wait is needed. Use the returned absolute python path only after completed. For failed or unknown results inspect/recover the original operation, then reverify under the same environment identity. Do not create a second environment or copy wheels. All commands/services must exit before mutation. When diagnostics provide repairPlans, you choose another candidate or action=repair with its repairPlanId and a new operationId under the same environmentId. Repair inherits the approved requirements and rebuilds from verified materials; it never edits the historical source. Inspect detail pages for diagnostics and repairPlans. For an authenticated submitted wheel with stale top_level RECORD or internal tags conflicting with its declared filename, you may explicitly choose repairWheelMetadata=true with action=repair and its repairPlanId. The program creates a distinct metadata-only build, proves original and executable/library bytes unchanged, and still requires standard target-tag, import, dependency and CUDA verification. Never rewrite old source RECORD files. recheckSource=true explicitly rechecks a changed or disputed historical failure. Unknown download/copy/peak estimates are not zero. Environment verification does not replace training acceptance.',
    parameters: { server_id: { type: 'string', required: true }, json: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Prepare training environment', kind: 'other', rawInput: args }),
    execute: async (args, execution) => {
      const serverId = serverIdSchema.parse(args.server_id)
      if (!runtime.submission.nodes.some(node => node.server.id === serverId)) throw new Error('server is outside this experiment allocation')
      const request = prepareExperimentEnvironmentSchema.parse(JSON.parse(args.json))
      const value = await prepareEnvironmentAndWait({ experimentId: runtime.submission.experimentId, serverId, operationId: request.operationId,
        policy: managedEnvironmentPolicySchema.parse(config.managedEnvironments ?? {}), signal: execution.signal,
        transport: { submit: signal => clusterNodeRequest(runtime, serverId, 'environment-prepare', { ...request, evidenceContext: evidenceContext() }, signal),
          read: signal => clusterNodeRequest(runtime, serverId, 'environment-status', { operationId: request.operationId }, signal) } })
      return JSON.stringify(await storageToolResult({ runRoot: serverRunRoot(runtime.submission.coordinator, runtime.submission.experimentId),
        serverId, experimentId: runtime.submission.experimentId, value, maxBytes: config.storageToolResultBytes, archiveServerId: runtime.submission.coordinator.id }))
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'recover_experiment_environment',
    description: 'Reconcile an original environment operation after a failed launch, disconnect, timeout or confirmed installer exit, including an already exitConfirmed failed receipt. The node checks the original process group, publication, generation and private residue; it preserves the original receipt. Recovery requires prepare_experiment_environment verification with a new operation ID under the original environment identity; install only missing dependencies if verification fails. Verified environments may have ordinary temporary cleanup pending; safety failures remain blocked. No PID or filesystem path is accepted.',
    parameters: { server_id: { type: 'string', required: true }, operation_id: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Recover training environment', kind: 'other', rawInput: args }),
    execute: async args => {
      const serverId = serverIdSchema.parse(args.server_id)
      const value = await clusterNodeRequest(runtime, serverId, 'environment-recover', { operationId: environmentOperationIdSchema.parse(args.operation_id) })
      return JSON.stringify(await storageToolResult({ runRoot: serverRunRoot(runtime.submission.coordinator, runtime.submission.experimentId),
        serverId, experimentId: runtime.submission.experimentId, value, maxBytes: config.storageToolResultBytes, archiveServerId: runtime.submission.coordinator.id }))
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'preview_experiment_cache_cleanup',
    description: 'Read an owned cleanup preview for an assigned node. Candidates include confirmed exited installation residue, unreferenced shared package objects and duplicate verified wheels with an independently retained copy. Unique verified wheels, environments, models, datasets, results, logs and releases are preserved. Historical, manager-cache, input-duplicate and release-asset-duplicate candidates require an explicit candidate_ids selection. Input compaction preserves each path and byte through hardlinks only after original tasks are durably released; current and unconfirmed snapshots are excluded. Release-asset compaction only hardlinks equal immutable LibreOffice/terminal resources from idle sealed releases, preserving all paths and bytes; the selected/active release and external aliases are excluded. Manager caches are confined idle Aspera pnpm/uv caches and are evicted through their managers; imported Python materials and training environments remain intact. A later environment operation can invalidate the preview; request a fresh preview and new cleanup operation after that refusal. referenceRepairs separately lists removed-environment references and their eligibility. Select eligible IDs explicitly with reference_repair_ids in cleanup_experiment_cache; this preserves the retained experiment and its files. Pass the returned fingerprint; unknown process outcomes require recovery first.',
    parameters: { server_id: { type: 'string', required: true } }, output,
    presentCall: args => ({ card: 'generic', title: 'Preview environment cache cleanup', kind: 'other', rawInput: args }),
    execute: async args => JSON.stringify(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), 'environment-preview')) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'cleanup_experiment_cache',
    description: 'Clean only the assigned node candidates from preview_experiment_cache_cleanup after checking references and process exit again. Use operation_id (UUID) and the exact preview fingerprint; repeat identical inputs to read the original result after a lost reply. Low space does not bypass ownership or process checks. Optional reference_repair_ids is a JSON list of eligible referenceRepairs IDs. With references only, no cache files are deleted. No arbitrary deletion path is accepted.',
    parameters: { server_id: { type: 'string', required: true }, operation_id: { type: 'string', required: true }, fingerprint: { type: 'string', required: true }, candidate_ids: { type: 'string' }, reference_repair_ids: { type: 'string' } }, output,
    presentCall: args => ({ card: 'generic', title: 'Clean environment cache', kind: 'other', rawInput: args }),
    execute: async args => {
      const serverId = serverIdSchema.parse(args.server_id)
      return JSON.stringify(await clusterNodeRequest(runtime, serverId, 'environment-cleanup', { experimentId: runtime.submission.experimentId,
        operationId: environmentOperationIdSchema.parse(args.operation_id), nodes: [{ serverId, fingerprint: deploymentIdSchema.parse(args.fingerprint),
          ...(args.candidate_ids === undefined ? {} : { candidateIds: z.array(z.string()).parse(JSON.parse(args.candidate_ids)) }),
          ...(args.reference_repair_ids === undefined ? {} : { referenceRepairIds: z.array(deploymentIdSchema).min(1).parse(JSON.parse(args.reference_repair_ids)) }) }] }))
    } })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'read_experiment_file', description: 'Read a bounded workspace file, overview log, or a command output stream. For command output pass command_id=run_id and stream=stdout|stderr without path; use the log references returned by command tools, including diagnostics. Diagnostic output is outside the read-only workspace, not logs/<run_id>.log. Pass path only for an existing workspace-relative file; omit path and command_id for the legacy overview. Continue with returned offset and generation; reset means rotation. Missing output does not establish success.',
    parameters: { server_id: { type: 'string', required: true }, path: { type: 'string' }, command_id: { type: 'string' }, stream: { type: 'string', enum: ['stdout', 'stderr'] }, offset: { type: 'number', required: true }, generation: { type: 'string' } }, output, presentCall,
    execute: async (args, execution) => {
      if (args.command_id !== undefined) {
        if (args.path !== undefined) throw new Error('Select a command stream or a workspace path, not both')
        return JSON.stringify(await readCommandOutput(runtime, { server_id: args.server_id, command_id: args.command_id, stream: args.stream,
          offset: args.offset, generation: args.generation }, finalizationPolicySchema.parse(config.finalization ?? {}).commandOutputBytes, execution.signal))
      }
      if (args.stream !== undefined) throw new Error('A command stream requires command_id')
      const chunk = clusterChunkSchema.parse(await clusterNodeRequest(runtime, serverIdSchema.parse(args.server_id), args.path === undefined ? 'log' : 'file',
        { offset: args.offset, path: args.path, generation: args.generation }, execution.signal))
      return JSON.stringify({ ...chunk, data: undefined, text: Buffer.from(chunk.data, 'base64').toString('utf8') })
    } })))
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
  installInferenceServiceTools(ctx, runtime)
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
  const planningLimits = resolveDocumentationPolicy(runtime.documentationPolicy, config)
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
  const approvedPlan = () => {
    const plan = planSchema.parse(JSON.parse(readFileSync(resolve(root, 'approved-plan.json'), 'utf8')))
    assertSubmittedPlanRequirements(runtime.submission, root, plan)
    return plan
  }
  if (!planning) approvedPlan()
  const evidenceContext = () => ({ sessionId, planRevision: existsSync(resolve(root, 'approved-plan.json')) ? approvedPlan().revision : 0 })
  const readRequirementEvidence = async (references: z.infer<typeof requirementEvidenceReferenceSchema>[], signal: AbortSignal): Promise<RequirementEvidence[]> => {
    const result: RequirementEvidence[] = []
    for (const reference of references) {
      const value = await clusterNodeRequest(runtime, reference.serverId, 'storage-requirement-evidence', { reference, evidenceContext: evidenceContext() }, signal)
      if (value !== null) result.push(requirementEvidenceSchema.parse(value))
    }
    return result
  }
  const stages = new StageRegistry(root, id, sessionId, {
    source: async (serverId, path, purpose, signal) => {
      const value = z.object({ sha256: z.string(), generation: z.string(), bytes: z.number(), text: z.string(), truncated: z.boolean() })
        .parse(await clusterNodeRequest(runtime, serverId, 'stage-source', { path, metadataOnly: purpose === 'artifact' }, signal))
      return { source: completionSourceSchema.parse({ serverId, path, purpose, sha256: value.sha256, generation: value.generation, bytes: value.bytes }), text: value.text, truncated: value.truncated }
    },
    command: async (serverId, commandId, signal) => (await clusterCommandStatuses(runtime, signal)).find(node => node.serverId === serverId)?.commands.find(command => command.commandId === commandId),
  }, policy, async (stage, signal) => {
    await clusterNodeRequest(runtime, stage.serverId, 'retain-checkpoints', { stage }, signal)
  })
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
    for (const service of services.filter(service => !service.released && service.external !== undefined)) {
      const result = z.object({ verified: z.boolean() }).parse(await clusterNodeRequest(runtime, service.serverId, 'service-verification-facts', { serviceId: service.id }, signal))
      if (!result.verified) issues.push({ code: 'results', serverId: service.serverId, detail: 'Published service lacks program-verified public authentication and generation: ' + service.id,
        remedy: 'Call verify_inference_service for this registered service and inspect its actual result; a report or local health check does not establish public access.' })
    }
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
      installKnowledge(agentCtx, runtime, config, sessionId)
      if (planning) installPlanTools(agentCtx, new PlanDraft(root, { experimentId: id, sessionId, deploymentId: runtime.submission.deploymentId },
        planningLimits.documentationPageBytes, loadPlanRequirements(runtime.submission, root)), planningLimits.documentationPageBytes, (state, detail) => {
        const goal = ctx.goals.get(handle.agent)
        if (goal === undefined) throw new Error('experiment Goal is missing')
        if (state === 'blocked') ctx.goals.block(handle.agent, { id: goal.id, revision: goal.revision }, { code: 'aspera-requirement', message: detail ?? 'Requirements cannot be met within the assigned resources.' })
        else { planSaved = true; ctx.goals.complete(handle.agent, { id: goal.id, revision: goal.revision }) }
      })
      if (!planning) {
        installNodeTools(agentCtx, runtime, config, committed => { executionRecordCommitted = committed }, evidenceContext, () => approvedPlan().storagePolicy)
        installServiceVerificationTool(agentCtx, runtime, config)
        waitCommands = installExecutionCommands(agentCtx, runtime, config, (serverId, commandId, signal) => stages.beforeLaunch(serverId, commandId, signal))
        executionProgress = installExecutionSteps(agentCtx, runtime, config, sessionId, readFileSync(resolve(config.root, 'state/coordinator.generation'), 'utf8'))
        agentCtx.effect(() => agentCtx.tools.register(defineTool({ name: 'register_experiment_stage',
          description: 'Register an approved training attempt BEFORE its command starts. json: stageId, serverId, attemptId, commandId, parameters, trainerState, metrics; optional resumeState/samples/attemptLabel/evaluation/inference/baseControl. parameters is an existing workspace-relative JSON FILENAME; trainerState and metrics are FILENAME paths that the command will write. A logged trainer-state copy can identify an approved native endpoint only when complete bytes, size and SHA-256 match; results retain the actual loaded adapter path, never the log directory. resumeState names the existing trainer_state.json FILE inside the original checkpoint, not its directory; the program reads its global_step before registration. Do not pass objects or JSON text as filenames. Metrics accept JSON/JSONL rows with numeric step or global_step (or formatted global_step/max_steps), loss and learning_rate. Evaluation requires numeric n/eval_samples/num_samples and finite eval_loss. Inference accepts JSON arrays, result objects (results/outputs/generations) or JSONL rows with nonempty response/output/generated_text. Evaluation and each inference response identify adapter_path/checkpoint/model_checkpoint; attempt_id/phase must match attemptLabel when specified. Preserve raw logs when producing these structured evidence files. After an original command fails and releases, choose previousAttemptId, a NEW attemptId/commandId and separate output paths to retry; preserve original evidence. Running, successful and unconfirmed commands cannot be replaced. Retry keeps the approved requirement and resume/optimizer/scheduler/RNG sources. Continuing checks optimizer.pt, scheduler.pt and rng_state.pth beside resumeState; optional optimizerState/schedulerState/rngState select actual checkpoint files. Cumulative endStep and additionalSteps are distinct; continuation does not restart warmup. For native checkpoint-N/trainer_state.json intermediate outputs in the final output directory, an explicit integer step-based save_strategy/save_steps and save_total_limit must produce and retain every approved point. Continuation inherits save_steps from the original native TrainerState even when the new CLI requests another interval. Initial registration checks approved later continuation points too; choose compatible initial save_steps before training, preserving the approved retention count and existing checkpoints. The native state must record step N; renaming another checkpoint does not satisfy it. This tool never launches training.',
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
      if (!planning) agentCtx.effect(() => agentCtx.tools.register(defineTool({ name: 'finish_experiment',
        description: 'Request finalization after inspecting actual results. completed requires independent node, stage, execution and step checks. blocked also waits for original commands and checks evidence; it cannot bypass missing finalization reports. Provide reason and actual evidence_seqs_json for budget claims. Unsupported context/budget explanations request correction. Never repeat settled training to fill records. Healthy registered inference services survive completion.',
        parameters: { status: { type: 'string', enum: ['completed', 'blocked'], required: true }, detail: { type: 'string' }, plan_json: { type: 'string' },
          reason: { type: 'string', enum: ['requirement', 'input-context-limit', 'output-token-limit', 'program-budget', 'compaction-failure', 'agent-report'] }, evidence_seqs_json: { type: 'string' },
          requirement_evidence_json: { type: 'string', description: 'For reason=requirement, JSON array of {serverId,kind,id}. Environment failures use kind="environment-operation" with the original operation UUID after confirmed exit. Other kinds: storage-plan, material-request, material-operation. Only the referenced observation is verified; a failed candidate does not establish that all repairs are impossible.' } }, output, presentCall,
        execute: async (args, execution) => {
          let finalDetail = args.detail
          if (!planning) {
            const waits = await waitCommands?.(execution.signal)
            const checked = await inspectCompletion(execution.signal), nodes = await clusterCommandStatuses(runtime, execution.signal)
            const activeCommands = nodes.flatMap(node => node.commands.filter(command => !command.released
              && !checked.services.some(service => service.serverId === node.serverId && service.commandId === command.commandId)).map(command => node.serverId + '/' + command.commandId))
            const key = args.reason ?? reportedFinishReason(args.detail ?? '')
            const requirementEvidence = args.requirement_evidence_json === undefined ? [] : await readRequirementEvidence(
              z.array(requirementEvidenceReferenceSchema).max(128).parse(JSON.parse(args.requirement_evidence_json)), execution.signal)
            const decision = decideExperimentFinish({ experimentId: id, sessionId, requested: args.status === 'completed' ? 'completed' : 'blocked', detail: args.detail ?? '',
              planRevision: approvedPlan().revision, requirementEvidence,
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
      let requirementEvidence: RequirementEvidence[] = []
      try { requirementEvidence = prior?.requirementEvidence === undefined ? [] : await readRequirementEvidence(prior.requirementEvidence.map(value => value.reference), new AbortController().signal) }
      catch (error) { detail = [detail, 'Requirement evidence could not be re-read; its explanation remains unverified: ' + String(error)].filter(Boolean).join('\n') }
      const decision = decideExperimentFinish({ experimentId: id, sessionId, requested: state === 'completed' ? 'completed' : 'blocked', detail: detail ?? '', reason,
        planRevision: approvedPlan().revision, requirementEvidence,
        observations: budgetObservations, check: checked.check, activeCommands: unknownCommands, corrections: prior?.corrections ?? 0, policy, facts: checked })
      if (!['accepted', 'wait', 'agent-incomplete'].includes(decision.decision)) decision.decision = 'agent-incomplete'
      await writeFileAtomic(path, JSON.stringify({ ...decision, detail: [decision.detail, detail].filter(Boolean).join('\n') }) + '\n', { mode: 0o600 })
    }
    const serving = state === 'completed' && services.some(service => !service.released)
    writeClusterReceipt(config.root, id, { state: serving ? 'serving' : state, detail,
      ...(serving ? { servingServices: services.filter(service => !service.released).map(service => ({ serverId: service.serverId, serviceId: service.id })) } : {}) }, planning ? 'planning-outcome.json' : 'outcome.json')
    await handle.dispose(); process.kill(process.pid, 'SIGTERM')
  }
  ctx.on('goal/changed', ({ agent, change }) => { if (agent !== handle.agent) return; if (change.goal?.phase === 'complete') finish('completed'); if (change.goal?.phase === 'blocked') finish('blocked', change.goal.blockedReason?.message) })
  const retryLifetime = new AbortController()
  ctx.effect(() => () => { retryLifetime.abort(new Error('Experiment stopped')) }, 'Aspera: transient retry')
  ctx.on('session/event', async (session, event) => {
    if (session.id !== handle.agent.session.id || settling || event.type !== 'turn/end' || event.data.reason.kind !== 'max-tokens') return
    // Goal mutations append to this Session after its current event publication completes.
    await Promise.resolve()
    if (settling) return
    let consecutive = 0
    for (const prior of session.snapshotEvents().toReversed()) {
      if (prior.seq > event.seq) continue
      if (prior.type === 'tool/result') break
      if (prior.type === 'turn/end' && prior.data.reason.kind === 'max-tokens') consecutive += 1
    }
    if (consecutive <= policy.outputTokenCorrections) {
      void (async () => {
        await handle.agent.whenIdle()
        const current = ctx.goals.get(handle.agent)
        if (settling || retryLifetime.signal.aborted || current?.phase !== 'active') return
        handle.agent.followup(createUserMessage({ source: { kind: 'aspera', experimentId: id }, content: [{ type: 'text', text:
          `Program observed a single-response output token limit at Session event ${event.seq}. Continue this same Goal and Session; this is not evidence of input context exhaustion. Recovery ${consecutive}/${policy.outputTokenCorrections}. Use smaller tool arguments and local draft edits or bounded evidence reads. Inspect original operation receipts and existing results before continuing. Do not restart successful training or blindly resubmit unconfirmed operations; use authorized recovery and retry tools. Preserve checkpoints and raw logs.` }] }))
        ctx.goals.resume(handle.agent, { id: current.id, revision: current.revision })
        await ctx.sessionPersistence.flush()
      })().catch((error: unknown) => { if (!retryLifetime.signal.aborted) finish('failed', 'Output-limit recovery could not continue the original Agent: ' + String(error)) })
      return
    }
    const detail = `${planning ? 'planning' : 'execution'}: Agent stopped at the model token limit (max-tokens) before completing the experiment. Inspect its Session and command results; existing commands were not restarted.`
    try {
      const current = ctx.goals.get(handle.agent)
      if (current?.phase === 'active') ctx.goals.block(handle.agent, { id: current.id, revision: current.revision }, { code: 'aspera-model-token-limit', message: detail })
      else finish('blocked', detail)
    } catch (error: unknown) { finish('failed', `${detail} Could not persist the blocked Goal: ${String(error)}`) }
  }, { global: true })
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
    + (planning ? 'Plan only with the tools actually exposed in this Session. Declare workload=inference for a pure inference task and omit training stages; never invent historical stages or placeholder scheduler values to satisfy validation. Declare workload=training when new training is required. Retained checkpoints are inspected separately and never count as new training. Include storagePolicy describing retained artifact type, checkpoint count, optimizer/scheduler recovery states, required recoveryPoints, explicit byte minima and basis; estimates are not retention policy. You choose investigation and writing order. Use get_experiment_plan_schema for exact field types and valid examples. You may save a complete typed plan, or build update_experiment_plan_draft sections in any order. Drafts retain revisions and original step numbers. On validation errors repair only the reported fields, then save_experiment_plan with draft_revision; do not regenerate the full plan. samples.unit is example|microbatch, samples.meaning is consumed|fetched, explanatory text belongs in basis, and results.baseControl is boolean. For Transformers or ms-swift training preserve structured stages with restored startStep, additionalSteps, cumulative endStep, scheduler horizon and sample/result requirements. '
      : 'Read get_experiment_execution_progress before starting. Report every approved-plan step as running before work, completed after checking its results, or blocked with a concrete reason. Use the returned revision for each report and re-read on a revision conflict. Register each approved training stage on each node before its command. Supply filenames: parameters names an existing JSON file; trainerState, metrics and result paths are written by that attempt. After confirmed failure and release, register a new attempt with previousAttemptId, a new commandId and separate output paths; preserve the original evidence. verify_experiment_stage independently checks the approved arithmetic and restored scheduler; continuing does not repeat initial warmup. Ordinary command tools wait for actual terminal exit and cleanup without another model request. Use run_experiment_command_group to launch all distributed participants before waiting. Do not use shell sleep or repeated empty log reads to wait. Step reports are Agent claims; command and result acceptance still decides completion. Before finishing, call inspect_experiment_completion and record_experiment_execution on EVERY selected node with actual framework, version, script, environment, effective parameters, artifacts and evaluation. A Markdown report, plan_json or finish detail does not save execution evidence. For success all necessary checks and step reports must pass. A real independently evidenced failure may end blocked with unfinished steps; missing reports and unsupported budget claims require correction. Never repeat a settled command merely to repair a missing report. ')
    + 'Read shipped framework guidance and exact-version documentation. Documentation returns saved text pages with independent timeouts; use next/query, cached snapshots, explicit retry or another allowed source as appropriate. '
    + (planning ? '' :
    'First request prepare_experiment_environment action=verify-reuse before using a whole-install estimate. You choose to borrow, repair or investigate alternatives. Read get_experiment_storage_policy. assess_experiment_storage preview is a trial, commit selects the approved policyRevision. Correct estimates using evidence without reducing retained content; propose_experiment_storage_policy is required to reduce retained contents. A partial model source is an investigation result: choose another source or acquire only missing canonical files under an admitted budget. Use inspect_experiment_environment and prepare_experiment_environment to create/install/verify training on each node. create preserves existing direct requirements and installs the merged requirements; install explicitly adjusts the requirement set. The program executes uv with a separate fixed-pip installer; training contains only requested dependencies. Reuse training and verified materials. Request actual dependencies, key imports and required CUDA checks. prepare_experiment_environment waits internally for the final receipt, real process exit and admission release; do not issue shell commands to wait or poll during installation. Empty requirements verify only a base interpreter. On failure or unknown outcome inspect/recover the original operation. Read diagnostic and repair-plan detail pages. You choose whether to investigate another source, repair affected dependencies or rebuild training from verified materials with action=repair, repairPlanId and a new operation ID. The old environment stays unchanged. Explicitly select eligible referenceRepairs for reference-only cleanup when needed, then reverify. Unchanged package conflicts require repairing their reported cause; changing operation IDs, unrelated dependencies or create/install is insufficient. Do not create a second venv, copy wheels or install through ordinary shell commands. If space is insufficient, use the owned cleanup preview and tool. Always use the returned absolute interpreter. User-site installation is disabled; never fall back to .local, overwrite a legacy environment or write shared dependencies directly. Use make-writable for specific files with all commands/services stopped. Verify a short run before long training. Record actual versions, scripts, dependencies, parameters, artifacts and evaluation. '
    + 'Choose investigation scope and order yourself: target a known owned experiment/directory or scan more widely. Sandbox invisibility and incomplete discovery never establish account-wide absence or ownership of unattributed bytes. Targeted candidate verification does not require a complete account scan or download budget. A candidate is not trusted content: use managed read-only verification, then assess actual additional capacity and acquire with a ready budget. Declare fixed-material requirements for experiment-wide capacity; a declared-only ready result covers no omitted model/data requirements. Each physical volume must fit independently. The program enforces identity, release, integrity and write admission even when earlier inspection was omitted. Use returned read-only material bindings and offline framework loading (HF_HUB_OFFLINE=1 and TRANSFORMERS_OFFLINE=1); preserve operation IDs, deadlines and verified checkpoints after failures. Historical cleanup requires fresh program candidates and rechecks content before deletion; preserve unique materials, environments, results and logs. '
    + 'For multiple nodes, preserve stable ranks, shared rendezvous and verify a real collective communication test. Never reduce the node group or change explicit training requirements. '
    + (runtime.submission.strategy.mode === 'semi' ? 'When independent investigation cannot resolve a choice, use ask_user_question to pause for a desktop reply. A reply cannot change explicit requirements or grant permissions. ' : 'Human waiting is disabled. Decide unspecified parameters within the constraints, retry recoverable errors and use short measured runs to adjust. ')
    + 'There is no total task runtime, command or round budget. Do not install Harness plugins, change the control service environment, or detach unmanaged processes. Preserve specified models, data, training methods and servers. Mark blocked with a concrete reason and evidence when constraints cannot be satisfied; use a new experiment for changed requirements. '
)
    + (planning ? 'Use save_experiment_plan to persist the planning outcome. ' : 'For an inference-only recovery task, inspect_inference_checkpoints on the authorized original experiment, choose its native checkpoint and prepare_inference_checkpoint with the persistent operation ID. Use the protected returned adapterPath without copying weights or retraining. A snapshot never substitutes for explicitly required fresh training. An inference model must bind to 127.0.0.1 and pass its HTTP health check before completion. If external access is requested, use the saved node inferenceMapping with publish=true, then call verify_inference_service for actual public authentication and generation through the local Host before reporting it usable. To replace a failed service or load corrected code, use stop_inference_service and confirm released=true before starting with a new service_id. Ordinary commands cannot stop managed services. Never infer a platform URL from a private IP or SSH port. The node gateway manages authentication; do not print or request credentials. Ordinary commands must settle. Use the finish tool to persist the final outcome.') }] }))
  await ctx.sessionPersistence.flush()
  writeClusterReceipt(config.root, id, { sessionId, goalId: goal.id }, planning ? 'planning-started.json' : 'started.json')
}
