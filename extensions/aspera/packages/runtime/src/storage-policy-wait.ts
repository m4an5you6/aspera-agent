/** Retention confirmation waits outside node locks and never asks the model to poll. */
import { setTimeout as delay } from 'node:timers/promises'
import type { StoragePolicyRecord } from '@aspera/experiments'
import type { ManagedEnvironmentPolicy } from './managed-environment.ts'

/** @param input - original proposal, authenticated reads and configured recovery limits. @returns the decision for the same immutable proposal. */
export async function waitForStoragePolicy(input: { proposal: StoragePolicyRecord; policy: ManagedEnvironmentPolicy;
  signal: AbortSignal; read: (signal: AbortSignal) => Promise<StoragePolicyRecord> }): Promise<StoragePolicyRecord> {
  let current = input.proposal, disconnectedAt: number | undefined
  while (current.state === 'pending') {
    await delay(input.policy.operationPollIntervalMs, undefined, { signal: input.signal })
    try {
      const next = await input.read(AbortSignal.any([input.signal, AbortSignal.timeout(input.policy.readTimeoutMs)]))
      if (next.proposalId !== input.proposal.proposalId || next.requestHash !== input.proposal.requestHash
        || next.experimentId !== input.proposal.experimentId || next.serverId !== input.proposal.serverId
        || next.expectedRevision !== input.proposal.expectedRevision) throw new Error('Storage policy confirmation identity changed')
      current = next; disconnectedAt = undefined
    } catch (error) {
      input.signal.throwIfAborted()
      if (error instanceof Error && error.message === 'Storage policy confirmation identity changed') throw error
      disconnectedAt ??= Date.now()
      if (Date.now() - disconnectedAt >= input.policy.operationReconnectTimeoutMs) throw new Error(`Storage policy ${input.proposal.proposalId} decision is unconfirmed; read this original proposal before retrying`, { cause: error })
    }
  }
  return current
}
