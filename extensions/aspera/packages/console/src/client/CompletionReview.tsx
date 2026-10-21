/** Supplementary acceptance remains distinct from the retained original outcome. */
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useState } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { ExperimentsController } from './controller.ts'
import css from './ExperimentsPage.module.css'

/** @param props - original task and separate review receipt. @returns constrained review actions, saved sources and original failure time. */
export function CompletionReview({ row, controller, t, onRecords }: { row: FleetExperiment; controller: ExperimentsController;
  t: TranslateNS<'experiments'>; onRecords: () => void }) {
  const review = row.completionReview
  const [requesting, setRequesting] = useState(false)
  if (!row.completionReviewAvailable && review === undefined) return null
  const busy = review?.phase === 'collecting' || review?.phase === 'verifying'
  const invoke = (operation: () => Promise<void>) => {
    setRequesting(true)
    void operation().catch(error => { controller.report(error, { experimentId: row.request.experimentId, operation: 'completion-review' }) }).finally(() => { setRequesting(false) })
  }
  return <section className={css.stageCard} aria-label={t('completionReview')} data-completion-review={review?.phase ?? 'available'} aria-busy={busy} data-tone={review?.phase === 'passed' ? 'complete' : review?.phase === 'blocked' ? 'attention' : busy ? 'active' : 'idle'}>
    <div className={css.workBody}>
    <div className={css.sectionHeading}><h3 className={css.pipelineLabel}>{t('completionReview')}</h3>{busy && <StateDot state="ongoing" />}</div>
    <p className={css.hint}>{t('reviewReadOnlyHint')}</p>
    <p>{t((row.latest ?? row.receipt)?.state === 'blocked' ? 'reviewOriginalBlocked' : 'reviewOriginalFailure', { time: new Date(review?.originalUpdatedAt ?? (row.latest ?? row.receipt)!.updatedAt).toLocaleString() })}</p>
    {review !== undefined && <>
      <p role="status">{t(review.phase === 'collecting' ? 'reviewCollecting' : review.phase === 'verifying' ? 'reviewVerifying' : review.phase === 'passed' ? 'revalidated' : review.phase === 'cancelled' ? 'reviewCancelled' : 'review-blocked')}</p>
      {busy && review.currentServerId !== undefined && <p>{row.servers.find(server => server.id === review.currentServerId)?.name}</p>}
      <p className={css.hint}>{t('reviewNodeCount', { ready: review.entries.length, total: row.servers.length })}</p>
      {review.verifiedAt === undefined && <time>{t('stageUpdatedAt', { time: new Date(review.updatedAt).toLocaleString() })}</time>}
      {review.verifiedAt !== undefined && <time>{t('reviewVerifiedAt', { time: new Date(review.verifiedAt).toLocaleString() })}</time>}
      {row.completionAssessment !== undefined && <>
        <p className={css.hint}>{t('reviewSupplementSteps', { count: row.completionAssessment.steps.length })}</p>
        {row.completionAssessment.verifications.map(stage => <div key={`${stage.serverId}/${stage.stageId}`}>
          <p>{stage.stageId} · {t(stage.ready ? 'reviewStagePassed' : 'reviewStagePending')}</p>
          <p className={css.hint}>{t('stageOptimizerCounts', { start: stage.startStep, additional: stage.additionalSteps, end: stage.endStep })}</p>
          {!stage.ready && <details><summary>{t('reviewDiagnostics')}</summary>{stage.checks.filter(check => !check.passed).map((check, index) => <p key={index}>{check.detail}</p>)}</details>}
        </div>)}
      </>}
      {(review.detail !== undefined || review.check !== undefined || review.entries.length > 0) && <details><summary>{t('reviewDiagnostics')}</summary>
        {review.detail !== undefined && <pre className={css.log}>{review.detail}</pre>}
        {review.check?.issues.map((issue, index) => <div key={index}><p>{row.servers.find(server => server.id === issue.serverId)?.name} {issue.detail}</p><p className={css.hint}>{issue.remedy}</p></div>)}
        {review.entries.length > 0 && <pre className={css.log}>{JSON.stringify(review.entries, null, 2)}</pre>}
      </details>}
    </>}
    <div className={css.workActions}>
      {!busy && review?.phase !== 'passed' && row.completionReviewAvailable && <Button size="sm" variant="primary" disabled={requesting} icon={requesting ? <StateDot state="ongoing" /> : undefined} onClick={() => { invoke(() => controller.reviewCompletion(row.request.experimentId)) }}>{t(review === undefined ? 'startCompletionReview' : 'retryCompletionReview')}</Button>}
      {busy && <Button size="sm" variant="outline" disabled={requesting} icon={requesting ? <StateDot state="ongoing" /> : undefined} onClick={() => { invoke(() => controller.cancelCompletionReview(row.request.experimentId)) }}>{t('cancelCompletionReview')}</Button>}
      {review !== undefined && <Button size="sm" variant="ghost" onClick={onRecords}>{t('reviewTrace')}</Button>}
    </div>
    </div>
  </section>
}
