/** Exclusive tools wait for original command exits without involving another model request. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { clusterCommandResultSchema, experimentIdSchema, serverIdSchema } from '@aspera/experiments'
import type { CommandWait, ExperimentId, ExperimentServerId } from '@aspera/experiments'
import type { FinalizationPolicy } from './finalization-policy.ts'

/** Lightweight authenticated response includes the allocation identity, not just a command name. */
export const commandObservationSchema = z.object({ experimentId: experimentIdSchema, serverId: serverIdSchema,
  result: clusterCommandResultSchema, checkedAt: z.number().int().nonnegative() }).strict()
/** The caller owns durable state, scoped authentication and the original command contents. */
export interface CommandWaitOptions {
  experimentId: ExperimentId; serverId: ExperimentServerId; commandId: string; startedAt: number;
  signal: AbortSignal; policy: FinalizationPolicy;
  submit?(signal: AbortSignal): Promise<unknown>
  read(signal: AbortSignal): Promise<unknown>
  save(record: CommandWait): Promise<void> | void
}
/** @param options - original command and bounded reader. @returns settled facts or an unresolved observation; never restarts or kills a command. */
export async function waitExperimentCommand(options: CommandWaitOptions): Promise<CommandWait> {
  const { experimentId, serverId, commandId, signal, policy, startedAt } = options
  let failureSince: number | undefined, last: CommandWait['result'], failure: unknown
  const observe = (state: CommandWait['state'], detail?: string): CommandWait => ({ version: 1, experimentId, serverId, commandId,
    state, startedAt, checkedAt: Date.now(), elapsedMs: Math.max(0, Date.now() - startedAt),
    ...(last === undefined ? {} : { result: last }), ...(detail === undefined ? {} : { detail }) })
  const lifetime = () => AbortSignal.any([signal, AbortSignal.timeout(Math.min(policy.readTimeoutMs,
    failureSince === undefined ? policy.readTimeoutMs : Math.max(1, policy.reconnectTimeoutMs - (Date.now() - failureSince))))])
  try {
    signal.throwIfAborted()
    await options.save(observe('waiting'))
    if (options.submit !== undefined) {
      try { await options.submit(lifetime()) }
      catch (error) { signal.throwIfAborted(); failure = error; failureSince = Date.now() }
    }
    for (;;) {
      signal.throwIfAborted()
      try {
        const row = commandObservationSchema.parse(await options.read(lifetime()))
        if (row.experimentId !== experimentId || row.serverId !== serverId || row.result.commandId !== commandId) {
          const result = observe('unknown', 'Command observation belongs to another experiment, node or command; allocation release is unconfirmed')
          await options.save(result); return result
        }
        last = row.result; failureSince = undefined
      } catch (error) {
        signal.throwIfAborted(); failure = error; failureSince ??= Date.now()
      }
      const terminal = last !== undefined && last.released && !['starting', 'running'].includes(last.state)
      const exhausted = failureSince !== undefined && Date.now() - failureSince >= policy.reconnectTimeoutMs
      const record = observe(terminal ? 'settled' : exhausted ? 'unknown' : 'waiting', exhausted
        ? 'Connection recovery budget exhausted; inspect this original command without resubmitting it: ' + String(failure) : undefined)
      await options.save(record)
      if (terminal || exhausted) return record
      await delay(Math.min(policy.pollIntervalMs, failureSince === undefined ? policy.pollIntervalMs
        : Math.max(1, policy.reconnectTimeoutMs - (Date.now() - failureSince))), undefined, { signal })
    }
  } catch (error) {
    if (signal.aborted) await options.save(observe('cancelled', 'Observation cancelled; this does not confirm remote process exit'))
    throw error
  }
}
