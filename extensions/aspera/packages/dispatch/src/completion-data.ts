/** Original-result review views and credential-safe structured evidence. */
import { redactObservation } from '@aspera/runtime'
import { createHash } from 'node:crypto'
import type { ExperimentServerId, ExecutionProgress, CompletionAssessment, CompletionReview, CompletionCheck, AcceptanceRecovery } from '@aspera/experiments'

/** @param check - fresh complete inspection, including associated serving checks. @param recovery - program-owned association.
 * @returns separate serving and overall conclusions; historical reports and the completion decision are unchanged.
 */
export function reviewCompletionSummary(check: CompletionCheck,
  recovery?: Pick<AcceptanceRecovery, 'experimentId' | 'recoveryExperimentId' | 'evidencePath' | 'evidenceHash'>) {
  return { assessmentScope: 'current retrospective acceptance; original outcome remains unchanged',
    associatedServing: recovery?.evidencePath === undefined ? undefined : { originalExperimentId: recovery.experimentId,
      recoveryExperimentId: recovery.recoveryExperimentId, evidencePath: recovery.evidencePath, evidenceHash: recovery.evidenceHash,
      verified: !check.issues.some(issue => issue.code === 'results'),
      permittedUse: 'Use this independently verified original-checkpoint proof for the current public-serving step assessment. It does not rewrite the old blocked report and does not require another generation.' },
    ...check }
}

/** @param progress - original reports and the separate assessment. @param review - original result identity.
 * @param stepCount - approved original plan length. @returns unresolved effective reports before the retained historical data.
 */
export function reviewProgressSummary(progress: { original?: ExecutionProgress; assessment?: CompletionAssessment },
  review: Pick<CompletionReview, 'experimentId' | 'planRevision' | 'executionSessionId'>, stepCount: number) {
  const original = progress.original, assessment = progress.assessment
  const matches = original !== undefined && original.experimentId === review.experimentId && original.planRevision === review.planRevision
    && original.sessionId === review.executionSessionId
  const states = new Map((matches ? original.steps : []).map(step => [step.step, step.state]))
  if (matches && assessment?.experimentId === review.experimentId && assessment.planRevision === review.planRevision
    && assessment.executionSessionId === review.executionSessionId) {
    for (const step of assessment.steps) if (step.state !== 'blocked') states.set(step.step, 'completed')
  }
  return { progressIdentity: matches ? 'confirmed' : 'unconfirmed',
    unresolvedSteps: Array.from({ length: stepCount }, (_value, index) => index + 1).filter(step => states.get(step) !== 'completed'),
    originalReportsPreserved: true, ...progress }
}

function structured(text: string): { value: unknown } | undefined {
  if (!/^\s*[[{]/.test(text)) return undefined
  try { return { value: JSON.parse(text) } }
  catch (error) { /* Plain text and incomplete file windows retain their original text representation. */ void error; return undefined }
}

/** @param text - evidence text or an embedded JSON/JSONL document. @param secrets - account-owned credentials.
 * @returns redacted text whose complete JSON objects and lines remain parseable.
 */
export function redactCompletionText(text: string, secrets: readonly string[]): string {
  const document = structured(text)
  if (document !== undefined) return JSON.stringify(redactCompletionData(document.value, secrets))
  return text.split('\n').map(line => {
    const parsed = structured(line)
    return parsed === undefined ? redactObservation(line, secrets) : JSON.stringify(redactCompletionData(parsed.value, secrets))
  }).join('\n')
}

/** @param value - parsed evidence, receipt or Session event. @param secrets - account-owned credentials.
 * @returns credential-free data with unchanged non-secret values, field names and JSON structure.
 */
export function redactCompletionData(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactCompletionText(value, secrets)
  if (Array.isArray(value)) return value.map(entry => redactCompletionData(entry, secrets))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key,
    /^(?:extra)?headers$/i.test(key) ? { redacted: true }
      : /(?:authorization|api[_-]?key|password|(?:access[_-]?)?token|secret)$/i.test(key) && entry !== null
        ? '[redacted]' : redactCompletionData(entry, secrets)]))
  return value
}

/** @param file - bounded retained source and its original byte digest. @param secrets - account-owned credentials.
 * @returns masked text, its supplied digest and masking status, with the original file identity retained.
 */
export function redactCompletionScript(file: { serverId: ExperimentServerId; path: string; sha256: string; text: string }, secrets: readonly string[]) {
  const text = redactCompletionText(file.text, secrets)
  return { ...file, path: redactCompletionText(file.path, secrets), text,
    textSha256: createHash('sha256').update(text).digest('hex'), textRedacted: text !== file.text }
}
