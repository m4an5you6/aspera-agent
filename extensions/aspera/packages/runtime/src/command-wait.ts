/** Exclusive tools wait for original command exits without involving another model request. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { clusterCommandResultSchema, experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import type { CommandWait, ExperimentId, ExperimentServerId } from '@aspera/experiments'
import type { FinalizationPolicy } from './finalization-policy.ts'
import { CommandAdmissionRejected } from './command-admission.ts'

/** Lightweight authenticated response includes the allocation identity, not just a command name. */
export const commandObservationSchema = z.object({ experimentId: experimentIdSchema, serverId: serverIdSchema,
  result: clusterCommandResultSchema, requestHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), checkedAt: z.number().int().nonnegative() }).strict()
/** The caller owns durable state, scoped authentication and the original command contents. */
export interface CommandWaitOptions {
  experimentId: ExperimentId; serverId: ExperimentServerId; commandId: string; startedAt: number;
  signal: AbortSignal; policy: FinalizationPolicy;
  requestHash?: string; purpose?: 'run' | 'diagnostic'; prior?: CommandWait;
  submit?(signal: AbortSignal): Promise<unknown>
  read(signal: AbortSignal): Promise<unknown>
  save(record: CommandWait): Promise<void> | void
}
/** @param options - original command and bounded reader. @returns settled facts or an unresolved observation; never restarts or kills a command. */
export async function waitExperimentCommand(options: CommandWaitOptions): Promise<CommandWait> {
  const { experimentId, serverId, commandId, signal, policy, startedAt } = options
  const requestHash = options.requestHash ?? options.prior?.requestHash, purpose = options.purpose ?? options.prior?.purpose
  if (options.requestHash !== undefined && options.prior?.requestHash !== undefined && options.requestHash !== options.prior.requestHash
    || options.purpose !== undefined && options.prior?.purpose !== undefined && options.purpose !== options.prior.purpose) {
    throw new Error('Command ID is bound to different content or purpose; use a new run_id for a different command')
  }
  let deadline = options.prior?.reconnectDeadlineAt, last = options.prior?.result
  let confirmed = false
  let submitError = options.prior?.submitError, observationError = options.prior?.observationError
  const observe = (state: CommandWait['state'], detail?: string): CommandWait => ({ version: 1, formatVersion: '0.1.4', experimentId, serverId, commandId,
    state, startedAt, checkedAt: Date.now(), elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(requestHash === undefined ? {} : { requestHash }), ...(purpose === undefined ? {} : { purpose }),
    ...(deadline === undefined ? {} : { reconnectDeadlineAt: deadline }),
    ...(submitError === undefined ? {} : { submitError }), ...(observationError === undefined ? {} : { observationError }),
    ...(last === undefined ? {} : { result: last }), ...(detail === undefined ? {} : { detail }) })
  const lifetime = () => AbortSignal.any([signal, AbortSignal.timeout(Math.min(policy.readTimeoutMs,
    deadline === undefined ? policy.readTimeoutMs : Math.max(1, deadline - Date.now())))])
  try {
    signal.throwIfAborted()
    await options.save(observe('waiting'))
    if (options.submit !== undefined && options.prior?.state !== 'unknown' && options.prior?.reconnectDeadlineAt === undefined) {
      try { await options.submit(lifetime()) }
      catch (error) {
        signal.throwIfAborted(); submitError ??= String(error)
        if (error instanceof CommandAdmissionRejected && error.receipt.experimentId === experimentId
          && error.receipt.serverId === serverId && error.receipt.commandId === commandId && error.receipt.requestHash === requestHash) {
          const result = { ...observe('rejected', error.receipt.detail), rejection: error.receipt }
          await options.save(result); return result
        }
        deadline ??= Date.now() + policy.reconnectTimeoutMs
        await options.save(observe('waiting'))
      }
    }
    for (;;) {
      signal.throwIfAborted()
      try {
        const row = commandObservationSchema.parse(await options.read(lifetime()))
        if (row.experimentId !== experimentId || row.serverId !== serverId || row.result.commandId !== commandId) {
          last = undefined
          const result = observe('unknown', 'Command observation belongs to another experiment, node or command; allocation release is unconfirmed')
          await options.save(result); return result
        }
        if (requestHash !== undefined && row.requestHash === undefined) {
          last = undefined
          const result = observe('unknown', 'Command content identity is unavailable; the previous result cannot confirm this request')
          await options.save(result); return result
        }
        if (requestHash !== undefined && requestHash !== row.requestHash || purpose !== undefined && purpose !== (row.result.purpose ?? 'run')) {
          last = undefined
          const result = observe('rejected', 'Command ID is bound to different content or purpose; the original command is unchanged; use a new run_id')
          await options.save(result); return result
        }
        last = row.result; deadline = undefined; confirmed = true
      } catch (error) {
        signal.throwIfAborted(); observationError = String(error); deadline ??= Date.now() + policy.reconnectTimeoutMs
      }
      const terminal = confirmed && last !== undefined && last.released && !['starting', 'running'].includes(last.state)
      const exhausted = deadline !== undefined && Date.now() >= deadline
      const record = observe(terminal ? 'settled' : exhausted ? 'unknown' : 'waiting', exhausted
        ? 'Connection recovery budget exhausted; inspect this original command without resubmitting it: ' + (submitError ?? observationError) : undefined)
      await options.save(record)
      if (terminal || exhausted) return record
      await delay(Math.min(policy.pollIntervalMs, deadline === undefined ? policy.pollIntervalMs : Math.max(1, deadline - Date.now())), undefined, { signal })
    }
  } catch (error) {
    if (signal.aborted) await options.save(observe('cancelled', 'Observation cancelled; this does not confirm remote process exit'))
    throw error
  }
}
