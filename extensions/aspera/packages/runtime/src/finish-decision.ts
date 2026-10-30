/** Finalization separates independently observed failures from model explanations. */
import { createHash } from 'node:crypto'
import type { CompletionCheck, ExperimentId, FinishDecision, FinishReason, RequirementEvidence } from '@aspera/experiments'
import type { FinalizationPolicy } from './finalization-policy.ts'

/** Only the runtime's Session observer constructs budget evidence. */
export interface BudgetObservation { seq: number; reason: Exclude<FinishReason, 'requirement' | 'agent-report'>; detail: string }
/** @param detail - legacy free text. @returns a diagnostic classification, never verified budget evidence. */
export function reportedFinishReason(detail: string): FinishReason {
  if (/max.tokens|output.*token|输出.*(?:上限|耗尽)/i.test(detail)) return 'output-token-limit'
  if (/context.*(?:exhaust|budget|limit)|上下文.*(?:耗尽|预算|超限)/i.test(detail)) return 'input-context-limit'
  if (/compaction.*fail|压缩.*失败/i.test(detail)) return 'compaction-failure'
  if (/budget.*(?:exhaust|exceed)|预算.*(?:耗尽|超限)/i.test(detail)) return 'program-budget'
  return 'agent-report'
}
/** @param input - program snapshot and the requested outcome. @returns a durable decision without mutating a Goal or a process. */
export function decideExperimentFinish(input: { experimentId: ExperimentId; sessionId: string; requested: 'completed' | 'blocked';
  detail: string; reason?: FinishReason; evidenceSeqs?: number[]; observations: BudgetObservation[]; check: CompletionCheck;
  activeCommands: string[]; corrections: number; policy: FinalizationPolicy; facts: unknown;
  planRevision?: number; requirementEvidence?: RequirementEvidence[];
}): FinishDecision {
  const reason = input.reason ?? reportedFinishReason(input.detail), budgetReason = !['requirement', 'agent-report'].includes(reason)
  const evidence = input.observations.filter(value => value.reason === reason && (input.evidenceSeqs === undefined || input.evidenceSeqs.includes(value.seq)))
  const requirements = (input.requirementEvidence ?? []).filter(value => value.experimentId === input.experimentId
    && value.sessionId === input.sessionId && value.planRevision === input.planRevision)
  const verified = input.requested === 'completed' ? input.check.ready
    : budgetReason ? evidence.length > 0 : reason === 'requirement' && requirements.length > 0
  let decision: FinishDecision['decision'], detail: string
  if (input.activeCommands.length > 0) {
    decision = 'wait'; detail = 'Original commands have not settled: ' + input.activeCommands.join(', ') + '. Wait for these commands; do not restart them.'
  } else if (input.requested === 'completed') {
    decision = input.check.ready ? 'accepted' : 'supplement'
    detail = input.check.ready ? 'Independent completion checks passed' : input.check.issues.map(value => value.detail + ' ' + value.remedy).join('\n')
  } else if (budgetReason && !verified) {
    decision = input.corrections >= input.policy.reasonCorrections ? 'agent-incomplete' : 'unconfirmed'
    detail = decision === 'agent-incomplete' ? 'Agent did not complete finalization; the claimed budget failure has no program evidence. Original command and result facts are retained.'
      : 'The claimed budget failure is unconfirmed. No matching program event establishes it. Continue finalization using existing results: ' + input.check.issues.map(value => value.detail + ' ' + value.remedy).join('\n')
  } else if (verified) {
    decision = 'accepted'; detail = budgetReason ? evidence.map(value => value.detail).join('\n') : 'Program observations confirm only the following conditions:\n' + requirements.map(value => value.detail).join('\n')
  } else {
    decision = input.corrections >= input.policy.reasonCorrections ? 'agent-incomplete' : 'unconfirmed'
    detail = decision === 'agent-incomplete'
      ? 'Agent did not complete investigation or finalization after bounded corrections. Its reported blocker remains unverified; original command and result facts are retained. Agent report: ' + input.detail
      : 'The reported blocker is unconfirmed. Read the existing operation diagnostics, choose an available recovery or repair, or supply matching program evidence before requesting blocked. Do not repeat settled training to fill records. Remaining checks: '
        + input.check.issues.map(value => value.detail + ' ' + value.remedy).join('\n')
  }
  return { version: 1, experimentId: input.experimentId, sessionId: input.sessionId, requested: input.requested, decision, reason,
    verified, checkedAt: Date.now(), detail, evidenceSeqs: evidence.map(value => value.seq),
    factsHash: createHash('sha256').update(JSON.stringify(input.facts)).digest('hex'), corrections: input.corrections,
    ...(requirements.length === 0 ? {} : { requirementEvidence: requirements }) }
}
