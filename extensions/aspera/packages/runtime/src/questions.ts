/** Experiment-owned answerer for the existing DSH question service. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import { experimentQuestionSchema, questionItemSchema } from '@aspera/experiments'
import type { ClusterRuntimeConfig, ClusterPrivate } from './cluster-runtime.ts'
import { z } from 'zod'

/** Mount an answerer without exposing credentials or allowing replies to edit requirements.
 * @param ctx - exact Agent context. @param host - injected worker services. @param agent - question owner. @param runtime - pinned submission. @param config - operation bounds. @param planning - planning role. @param onFailure - terminal infrastructure failure handler.
 */
export function installExperimentQuestions(ctx: Context, host: Context, agent: Agent, runtime: ClusterPrivate, config: ClusterRuntimeConfig, planning: boolean, onFailure: (error: unknown) => void): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => { lifetime.abort(new Error('Experiment Agent disposed')) }, 'Aspera: question lifetime')
  const calls = new Set<string>()
  ctx.on('tools/pre-execute', async (execution, next) => {
    if (execution.agent !== agent) return next()
    if (host.goals.get(agent)?.phase === 'paused') return { kind: 'deny', reason: 'Experiment is awaiting its saved operator reply' }
    return next()
  })
  const control = async (operation: string, body: object, signal: AbortSignal) => {
    const response = await fetch(`http://127.0.0.1:${runtime.submission.coordinator.remotePort + 1}/aspera/v2/${operation}`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${readFileSync(resolve(config.root, 'secrets/coordinator.token'), 'utf8').trim()}` },
      body: JSON.stringify({ ...body, experimentId: runtime.submission.experimentId }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(runtime.toolTimeoutMs)]), redirect: 'error',
    })
    const result: unknown = await response.json()
    if (!response.ok) throw new Error(z.object({ error: z.string() }).parse(result).error)
    return result
  }
  ctx.on('user-questions/request', async (request, next) => {
    if (request.agent !== undefined && request.agent !== agent) return next()
    if (runtime.submission.protocol !== 3 || runtime.submission.strategy.mode !== 'semi') throw new UserQuestionError('Automatic experiments decide within constraints or report a blocker; human waiting is disabled.', 'ASPERA_UNATTENDED')
    if (request.agent !== agent || request.wait === undefined || !calls.has(request.wait.callId)) throw new UserQuestionError('An experiment question requires its logged tool invocation.', 'ASPERA_UNBOUND_QUESTION')
    const signal = request.signal === undefined ? lifetime.signal : AbortSignal.any([lifetime.signal, request.signal])
    try {
      await host.sessionPersistence.flush()
      const question = experimentQuestionSchema.parse({ version: 1, questionId: randomUUID(), revision: 1,
        experimentId: runtime.submission.experimentId, sessionId: agent.session.id, callId: request.wait.callId,
        stage: planning ? 'planning' : 'running', questions: request.questions, state: 'open', createdAt: Date.now() })
      await control('open-question', { question }, signal)
      const goal = host.goals.get(agent)
      if (goal?.phase !== 'active') throw new Error('Question owner has no active Goal')
      host.goals.pause(agent, { id: goal.id, revision: goal.revision })
      await host.sessionPersistence.flush()
      while (true) {
        signal.throwIfAborted()
        const saved = experimentQuestionSchema.parse(await control('question', { questionId: question.questionId }, signal))
        if (saved.state === 'expired') throw new Error('Question expired; this experiment cannot resume')
        if (saved.answer !== undefined) {
          const delivered = experimentQuestionSchema.parse(await control('consume-question', {
            questionId: question.questionId, revision: question.revision, sessionId: question.sessionId, callId: question.callId,
          }, signal))
          signal.throwIfAborted()
          const current = host.goals.get(agent)
          if (current?.id !== goal.id || current.phase !== 'paused' || delivered.answer === undefined) throw new Error('Original question Goal is no longer resumable')
          host.goals.resume(agent, { id: current.id, revision: current.revision })
          return delivered.answer
        }
        await delay(config.pollIntervalMs, undefined, { signal })
      }
    } catch (error: unknown) {
      if (!signal.aborted) {
        onFailure(error)
        let current = host.goals.get(agent)
        if (current?.phase === 'paused') {
          current = host.goals.resume(agent, { id: current.id, revision: current.revision })
        }
        if (current?.phase === 'active') host.goals.block(agent, { id: current.id, revision: current.revision }, {
          code: 'aspera-question-infrastructure', message: String(error),
        })
      }
      throw error
    }
  })
  if (runtime.submission.protocol !== 3 || runtime.submission.strategy.mode !== 'semi') return
  ctx.effect(() => ctx.tools.register(defineTool({ name: 'ask_user_question',
    description: 'Pause this experiment for an operator decision only when autonomous investigation cannot resolve it. Replies cannot authorize new permissions or change the specified model, data, training method or server group; those require a new experiment.',
    parameters: { questions: { type: 'array', required: true, items: { type: 'object', additionalProperties: false, properties: {
      id: { type: 'string', required: true }, question: { type: 'string', required: true }, detail: { type: 'string' }, header: { type: 'string' },
      options: { type: 'array', items: { type: 'object', additionalProperties: false, properties: { label: { type: 'string', required: true }, description: { type: 'string' } } } },
      multiSelect: { type: 'boolean' },
    } } } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    presentCall: args => ({ card: 'generic', title: 'Aspera operator question', kind: 'other', rawInput: args }),
    execute: async (args, execution) => {
      calls.add(execution.callId)
      try { return JSON.stringify(await host.userQuestions.ask({ agent, questions: z.array(questionItemSchema).min(1).max(16).parse(args.questions), signal: execution.signal, wait: { callId: execution.callId } })) }
      finally { calls.delete(execution.callId) }
    },
  })))
}
