/** Logged execution tools report plan steps; coordinator validation owns their durability. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { executionProgressReadSchema, executionStepInputSchema, executionStepResultSchema } from '@aspera/experiments'
import type { ExecutionProgressRead } from '@aspera/experiments'
import type { ClusterPrivate, ClusterRuntimeConfig } from './cluster-runtime.ts'
import { clusterCoordinatorRequest } from './coordinator-request.ts'

/** Register only on the execution Agent, with worker-bound identity and logged diagnostics.
 * @param ctx - execution Agent scope. @param runtime - immutable experiment. @param config - private controller settings.
 * @param sessionId - owning execution Session. @param generation - owning coordinator lifetime.
 * @returns a read function used by completion checks; reports never replace independent acceptance.
 */
export function installExecutionSteps(ctx: Context, runtime: ClusterPrivate, config: ClusterRuntimeConfig,
  sessionId: string, generation: string): (signal: AbortSignal) => Promise<ExecutionProgressRead> {
  const read = async (signal: AbortSignal) => executionProgressReadSchema.parse(await clusterCoordinatorRequest(runtime, config, 'execution-progress', {}, signal))
  const output = { schema: { type: 'string' as const }, render: (_args: object, value: string) => [{ type: 'text' as const, text: value }] }
  const presentCall = (args: object) => ({ card: 'generic' as const, title: 'Aspera execution step', kind: 'other' as const, rawInput: args })
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'get_experiment_execution_progress',
    description: 'Read the current approved-plan step reports and their revision. Pending steps have not been reported. These Agent reports do not replace command, GPU or result acceptance.',
    parameters: {}, output, presentCall, execute: async (_args, execution) => JSON.stringify(await read(execution.signal)) })))
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'report_experiment_step',
    description: 'Report one step of the approved plan as running before work, completed after verified work, or blocked with a concrete reason. Steps are numbered from 1. Read get_experiment_execution_progress first and use its revision as expected_revision. On rejection, inspect the returned latest snapshot and retry only the report. A completed step cannot be reopened. This tool never launches commands or marks the experiment complete.',
    parameters: { plan_revision: { type: 'number', required: true }, expected_revision: { type: 'number', required: true },
      step: { type: 'number', required: true }, state: { type: 'string', enum: ['running', 'completed', 'blocked'], required: true }, detail: { type: 'string' } },
    output, presentCall, execute: async (args, execution) => {
      const input = executionStepInputSchema.parse({ planRevision: args.plan_revision, expectedRevision: args.expected_revision,
        step: args.step, state: args.state, ...(args.detail === undefined ? {} : { detail: args.detail }) })
      return JSON.stringify(executionStepResultSchema.parse(await clusterCoordinatorRequest(runtime, config, 'report-execution-step',
        { ...input, sessionId, callId: execution.callId, generation }, execution.signal)))
    } })))
  return read
}
