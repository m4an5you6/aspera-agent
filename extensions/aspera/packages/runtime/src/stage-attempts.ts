/** Immutable stage successors preserve failed attempts without replacing their registrations. */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, linkSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { stageAttemptTransitionSchema } from '@aspera/experiments'
import type { StageRegistration, StageRegistrationInput, StageAttemptTransition } from '@aspera/experiments'

/** @param prior - immutable failed attempt. @param next - requested successor. @returns after checking distinct output and unchanged resume sources. */
export function checkStageRetrySources(prior: StageRegistration, next: Omit<StageRegistrationInput, 'previousAttemptId'>): void {
  const oldOutputs = new Set([prior.trainerState, prior.metrics, prior.samples, prior.evaluation, prior.inference, prior.baseControl].filter(path => path !== undefined))
  for (const path of [next.trainerState, next.metrics, next.samples, next.evaluation, next.inference, next.baseControl]) {
    if (path !== undefined && oldOutputs.has(path)) throw new Error('A new attempt requires separate trainerState, metrics and result paths; preserve the failed attempt evidence')
  }
  for (const field of ['resumeState', 'optimizerState', 'schedulerState', 'rngState'] as const) {
    if (prior[field] !== next[field]) throw new Error('Retry must retain the approved resume and optimizer/scheduler/RNG sources')
  }
}

/** @param root - original private run root. @param prior - immutable predecessor. @returns its exclusive successor filename. */
export function stageSuccessorPath(root: string, prior: StageRegistration): string {
  return resolve(root, 'stage-attempts-v1', prior.serverId + '_' + prior.stageId, prior.attemptId + '.json')
}
/** @param root - original private run root. @param prior - current immutable attempt. @returns its validated successor when committed. */
export function readStageSuccessor(root: string, prior: StageRegistration): StageRegistration | undefined {
  const path = stageSuccessorPath(root, prior)
  let bytes: string
  try { bytes = readFileSync(path, 'utf8') }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  const transition = stageAttemptTransitionSchema.parse(JSON.parse(bytes))
  const next = transition.registration, command = transition.previousCommand
  if (transition.previousAttemptId !== prior.attemptId || command.commandId !== prior.commandId
    || command.state !== 'failed' || !command.released || typeof command.exitCode !== 'number' || command.exitCode === 0
    || next.experimentId !== prior.experimentId || next.serverId !== prior.serverId || next.stageId !== prior.stageId
    || next.sessionId !== prior.sessionId || next.planRevision !== prior.planRevision || next.historical || prior.historical
    || next.attemptId === prior.attemptId || next.commandId === prior.commandId
    || JSON.stringify(next.requirement) !== JSON.stringify(prior.requirement)) throw new Error('Stage attempt successor differs from its confirmed failed predecessor')
  const verification = transition.previousVerification
  if (verification !== undefined && (verification.experimentId !== prior.experimentId || verification.serverId !== prior.serverId
    || verification.stageId !== prior.stageId || verification.attemptId !== prior.attemptId || verification.sessionId !== prior.sessionId
    || verification.planRevision !== prior.planRevision || verification.ready)) throw new Error('Stage retry cannot replace a successful or foreign verification')
  checkStageRetrySources(prior, next)
  return next
}
/**
 * Publish a fully written registration or successor without replacing a concurrent winner.
 * @param path - private canonical filename on the same filesystem as its staging file.
 * @param value - program-validated registration or transition.
 * @returns whether this call committed the file; an existing winner must be re-read.
 */
export async function publishStageRecord(path: string, value: StageRegistration | StageAttemptTransition): Promise<boolean> {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const pending = path + '.pending-' + randomUUID()
  try {
    await writeFileAtomic(pending, JSON.stringify(value) + '\n', { mode: 0o600 })
    try { linkSync(pending, path); return true }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return false
      throw error
    }
  } finally { if (existsSync(pending)) unlinkSync(pending) }
}
