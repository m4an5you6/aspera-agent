/** A standard DSH Agent can supplement evidence but has no execution or installation tools. */
import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { serverIdSchema, projectAgentRecord, stageRegistrationInputSchema, completionSourceInputSchema } from '@aspera/experiments'
import { z } from 'zod'
import type { CompletionReview, AgentRecordPage } from '@aspera/experiments'
import { openPhaseModelContext } from '@aspera/runtime'
import type { PhaseContextPolicy } from '@aspera/runtime'
import type { FleetExperiment } from './types.ts'
import type { CompletionReviewOwner, CompletionReviewTools } from './completion-review.ts'

/** @param ctx - existing Host composition. @param record - unchanged original experiment. @param review - independent operation.
 * @param tools - constrained recording and acceptance. @param owner - original read-only sources. @param policy - standard DSH context policy.
 * @param trace - original Session read. @param signal - operation cancellation. @returns when the review ends without starting training.
 */
export async function runCompletionReviewAgent(ctx: Context, record: FleetExperiment, review: CompletionReview, tools: CompletionReviewTools,
  owner: Pick<CompletionReviewOwner, 'snapshot' | 'source'>, policy: PhaseContextPolicy,
  trace: (beforeSeq?: number) => Promise<AgentRecordPage>, signal: AbortSignal): Promise<void> {
  const model = record.models?.execution
  if (model === undefined) throw new Error('Original execution model snapshot is unavailable')
  const scope = await openPhaseModelContext(ctx, model, policy)
  let handle: AgentHandle | undefined
  const done = Promise.withResolvers<void>(), off: (() => void)[] = []
  let started = false
  let failure: unknown
  const stop = () => { handle?.agent.cancel({ kind: 'user' }); done.resolve() }
  signal.addEventListener('abort', stop, { once: true })
  try {
    off.push(ctx.on('agent/error', ({ agent, error }) => { if (agent === handle?.agent) { failure = error; done.resolve() } }))
    off.push(ctx.on('agent/status', ({ agent, status }) => {
      if (agent !== handle?.agent) return
      if (status === 'running') started = true
      if (started && status === 'idle') done.resolve()
    }, { global: true }))
    off.push(ctx.on('session/event', (session, event) => {
      if (session.id === review.sessionId) tools.event(projectAgentRecord(event, { experimentId: review.experimentId, phase: 'execution', sessionId: review.sessionId }, Infinity))
    }, { global: true }))
    const register = async (agentCtx: Context, agent: import('@deepseek-ai/dsh-agent').Agent) => {
      installModelSelection(agentCtx, { current: { provider: model.provider, model: model.model }, assembled: undefined })
      agentCtx.tools.restrict({ allow: [] })
      const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
      const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera completion evidence', kind: 'other' as const, rawInput: args })
      const add = (tool: Parameters<typeof agentCtx.tools.register>[0]) => agentCtx.effect(() => agentCtx.tools.register(tool))
      add(defineTool({ name: 'get_experiment_requirements', description: 'Read the unchanged original requirements and approved plan. This operation is evidence review, never training.', parameters: {}, output, presentCall,
        execute: async () => JSON.stringify({ submission: record.submission, plan: (record.latest ?? record.receipt)?.plan, stageRequirements: tools.requirements(), originalSessionId: review.executionSessionId }) }))
      add(defineTool({ name: 'get_experiment_execution_progress', description: 'Read original step reports without changing them.', parameters: {}, output, presentCall,
        execute: async (_args, execution) => JSON.stringify(await tools.progress(execution.signal)) }))
      add(defineTool({ name: 'register_experiment_stage',
        description: 'Bind existing historical training files and command to program-returned original stageRequirements. json: stageId, serverId, attemptId, commandId, parameters, trainerState, metrics, optional resumeState/samples/evaluation/inference/baseControl/attemptLabel. Paths are literal workspace-relative files. Requirements cannot be supplied, weakened or changed. This reads existing training only and does not start or modify it.',
        parameters: { json: { type: 'string', required: true } }, output, presentCall,
        execute: async (args, execution) => JSON.stringify(await tools.registerStage(stageRegistrationInputSchema.parse(JSON.parse(args.json)), execution.signal)) }))
      add(defineTool({ name: 'verify_experiment_stage',
        description: 'Read and independently verify a registered historical stage. json: serverId, stageId. Additional optimizer steps, cumulative endpoint, sparse metrics, restored scheduler, actual sample order and required results are checked separately. Do not rerun training or inference to repair missing evidence.',
        parameters: { json: { type: 'string', required: true } }, output, presentCall,
        execute: async (args, execution) => { const value = z.object({ serverId: serverIdSchema, stageId: z.string().min(1) }).strict().parse(JSON.parse(args.json)); return JSON.stringify(await tools.verifyStage(value.serverId, value.stageId, execution.signal)) } }))
      add(defineTool({ name: 'report_experiment_step',
        description: 'Supplement an original approved-plan step using existing sources without changing its old report. Read get_experiment_execution_progress and pass assessment.revision as expected_revision. sources_json is [{serverId,path,purpose}]. completed is an Agent report, independently checked at verification. not-applicable requires an original structured conditional trigger whose commands all succeeded; a missing or unknown result cannot be skipped.',
        parameters: { step: { type: 'number', required: true }, expected_revision: { type: 'number', required: true }, state: { type: 'string', enum: ['completed', 'blocked', 'not-applicable'], required: true }, detail: { type: 'string', required: true }, sources_json: { type: 'string', required: true } }, output, presentCall,
        execute: async (args, execution) => JSON.stringify(await tools.reportStep({ step: args.step, expectedRevision: args.expected_revision,
          state: z.enum(['completed', 'blocked', 'not-applicable']).parse(args.state), detail: args.detail,
          sources: z.array(completionSourceInputSchema).min(1).parse(JSON.parse(args.sources_json)) }, execution.callId, execution.signal)) }))
      add(defineTool({ name: 'get_experiment_commands', description: 'Read original command results and exit evidence. Commands cannot be started.', parameters: {}, output, presentCall,
        execute: async (_args, execution) => JSON.stringify((await owner.snapshot(record, execution.signal)).commands) }))
      add(defineTool({ name: 'list_experiment_files', description: 'Read existing evidence file paths. Dependencies and model caches are excluded.', parameters: {}, output, presentCall,
        execute: async (_args, execution) => JSON.stringify((await owner.snapshot(record, execution.signal)).files) }))
      add(defineTool({ name: 'read_experiment_file', description: 'Read a bounded head and tail of an existing experiment-relative file. No writes or command execution are available.',
        parameters: { server_id: { type: 'string', required: true }, path: { type: 'string', required: true } }, output, presentCall,
        execute: async (args, execution) => JSON.stringify(await owner.source(record, { serverId: serverIdSchema.parse(args.server_id), path: args.path, purpose: 'parameters' }, execution.signal)) }))
      add(defineTool({ name: 'read_original_execution_trace', description: 'Read the original execution Session with its own sequence numbers.',
        parameters: { before_seq: { type: 'number' } }, output, presentCall, execute: async args => JSON.stringify(await trace(args.before_seq)) }))
      add(defineTool({ name: 'inspect_experiment_completion', description: 'Read program-owned completion checks and missing node evidence. Existing reports do not substitute for execution entries.', parameters: {}, output, presentCall,
        execute: async (_args, execution) => JSON.stringify(await tools.inspect(execution.signal)) }))
      add(defineTool({ name: 'record_experiment_execution', description: 'Supplement the actual serverId, framework package name, version, script (relative), environment, parameters (string values), artifacts (relative paths), evaluation (numbers). sources_json must cite {serverId,path,purpose} for framework,script,environment,parameters and existing results. Effective parameters and evaluation must match saved JSON/JSONL; artifacts require their actual paths. This never edits the original execution file.',
        parameters: { json: { type: 'string', required: true, description: 'JSON object with exactly serverId, framework, version, script, environment, parameters (map of exact saved keys to String(value)), artifacts (relative file paths), evaluation (map of exact saved keys to finite numbers). No training or inference fields. Environment is a literal workspace-relative path, never a shell variable.' },
          sources_json: { type: 'string', required: true, description: 'JSON array of {serverId,path,purpose}. purpose is exactly framework, script, environment, parameters, training, evaluation, artifact or inference. One file may support several purposes. Use complete structured JSON/JSONL for parameters/evaluation; all diagnosed mismatches must be corrected together.' } }, output, presentCall,
        execute: async (args, execution) => JSON.stringify(await tools.record(args.json, args.sources_json, execution.callId, execution.signal)) }))
      let accepted: CompletionReview | undefined
      const verify = async (lifetime: AbortSignal) => {
        if (accepted !== undefined) return JSON.stringify(accepted)
        const result = await tools.verify(lifetime)
        if (result.phase === 'passed') {
          accepted = result
          const goal = ctx.goals.get(agent)
          if (goal?.phase === 'active') ctx.goals.complete(agent, { id: goal.id, revision: goal.revision })
          done.resolve()
        }
        return JSON.stringify(result)
      }
      add(defineTool({ name: 'verify_experiment_completion', description: 'Ask the program to recheck every original node, source hash, environment and result, then persist a separate assessment. Only the program can mark this review passed.', parameters: {}, output, presentCall,
        execute: async (_args, execution) => verify(execution.signal) }))
      add(defineTool({ name: 'finish_experiment', description: 'Finish only this evidence review. completed requests independent verification; blocked records missing evidence. Neither option runs training or changes the original failure.',
        parameters: { status: { type: 'string', enum: ['completed', 'blocked'], required: true }, detail: { type: 'string' } }, output, presentCall,
        execute: async (args, execution) => {
          if (args.status === 'completed') return verify(execution.signal)
          await tools.block(args.detail ?? 'Original evidence cannot be confirmed')
          const goal = ctx.goals.get(agent)
          if (goal?.phase === 'active') ctx.goals.block(agent, { id: goal.id, revision: goal.revision }, { code: 'aspera-completion-evidence', message: args.detail ?? 'Original evidence is unavailable' })
          done.resolve(); return JSON.stringify({ state: 'blocked' })
        } }))
    }
    const sessionId = SessionId(review.sessionId), stat = await ctx.sessionPersistence.stat(sessionId)
    const agentOptions = { provider: model.provider, model: model.model }
    const cwd = resolve(resolveDshHome(), 'aspera-run-records', review.experimentId, 'review', review.operationId)
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    handle = stat === undefined ? await scope.context.agents.create({ sessionId, meta: { cwd }, agentOptions, setup: register })
      : await scope.context.agents.resume({ resumeSessionId: sessionId, agentOptions, setup: register })
    signal.throwIfAborted()
    if (ctx.goals.get(handle.agent)?.phase !== 'active') ctx.goals.create(handle.agent, { objective: 'Supplement and independently verify existing completion evidence; never run training, installation, inference or services.' })
    handle.agent.followup(createUserMessage({ source: { kind: 'aspera', experimentId: review.experimentId }, content: [{ type: 'text', text: `Review original experiment ${review.experimentId}, operation ${review.operationId}. Original result and Session remain immutable. Read get_experiment_requirements and inspect_experiment_completion. stageRequirements are program-derived from the original approved requirements. Register each historical stage with its actual command and files, then verify_experiment_stage; never supply weaker requirements. Distinguish additional steps from the cumulative endpoint and preserve the restored scheduler rather than repeating warmup. Read existing final files, not stale intermediate checklists. Use record_experiment_execution on EVERY selected node with exact saved values and sources_json. Correct all diagnosed mismatches together; parameters are strings using exact saved JSON keys, evaluation values are finite numbers, and paths are literal workspace-relative paths. Read get_experiment_execution_progress and supplement unfinished steps with report_experiment_step using assessment.revision and actual evidence sources. Original reports stay unchanged; not-applicable needs an original structured conditional rule and program checks. Do not fabricate evidence or rerun training, evaluation or inference. A historical pyenv is verified read-only and is not a new managed environment. After recording call verify_experiment_completion; only a passed result ends this review successfully. If original evidence is unavailable, finish_experiment blocked with concrete missing files and nodes. Reports and completion claims do not save execution evidence.` }] }))
    await done.promise
    signal.throwIfAborted()
    if (failure !== undefined) throw failure
    await handle.agent.whenIdle(); await ctx.sessionPersistence.flush()
  } finally {
    signal.removeEventListener('abort', stop)
    handle?.agent.cancel({ kind: 'user' })
    await handle?.dispose(); for (const dispose of off.reverse()) dispose(); await scope.dispose()
  }
}
