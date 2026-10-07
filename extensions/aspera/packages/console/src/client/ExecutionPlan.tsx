/** Plan text and Agent step reports share a version; program acceptance remains separate. */
import { Button, StateDot, IconCheckOutlineRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { ExecutionProgressView } from './controller.ts'
import { experimentProgress } from './experiment-progress.ts'
import css from './ExperimentsPage.module.css'

/** @param props - saved plan, bound reports and the existing approval action. @returns actual plan steps, never inferred from old metrics. */
export function ExecutionPlan({ row, t, execution, approving, onApprove }: {
  row: FleetExperiment; t: TranslateNS<'experiments'>; execution: ExecutionProgressView | undefined; approving: boolean; onApprove: () => void
}) {
  const { remote, busy, status } = experimentProgress(row)
  const plan = remote?.plan
  if (plan === undefined) return null
  const saved = execution?.value?.progress
  const progress = saved?.planRevision === plan.revision && saved.sessionId === (remote?.sessionId ?? `aspera-execution-${row.request.experimentId}`) ? saved : undefined
  const reported = progress !== undefined && progress.revision > 0
  const complete = progress?.steps.filter(step => step.state === 'completed').length ?? 0
  const waiting = remote?.startedAt === undefined && remote?.sessionId === undefined && ['queued', 'awaiting-approval'].includes(status)
  return <section className={css.executionPlan} aria-label={t('executionProgress')}>
    <div className={css.sectionHeading}><h3>{t('executionProgress')}</h3><span className={css.hint}>{reported ? t('completedSteps', { complete, total: plan.steps.length }) : t('planStepCount', { total: plan.steps.length })}</span></div>
    <p className={css.stepSource}>{t(reported ? 'stepReportsHint' : waiting ? 'planNotStarted' : 'stepsUnrecorded')}</p>
    {execution?.error !== undefined && <p className={css.progressReadNotice} aria-live="polite">{t(execution.receivedAt === undefined ? 'stepInitialReadFailed' : 'stepRefreshFailed')}{execution.receivedAt !== undefined && <span> · {t('lastReadAt', { time: new Date(execution.receivedAt).toLocaleString() })}</span>}</p>}
    <ol className={css.executionSteps}>{plan.steps.map((text, index) => {
      const report = progress?.steps[index]
      const state = report?.state ?? 'pending'
      const active = state === 'running' && busy
      const key = state === 'running' && !busy ? 'stepStopped' : state === 'pending' && !waiting && !reported ? 'stepUnreported' : `step-${state}` as const
      return <li key={index} data-step-state={state} aria-busy={active}>
        <span className={css.executionStepIcon} aria-hidden="true">{state === 'completed' ? <IconCheckOutlineRegular size={17} /> : active ? <StateDot state="ongoing" size={17} /> : state === 'blocked' ? <IconWarningOutlineRegular size={17} /> : index + 1}</span>
        <div className={css.executionStepCopy}><div className={css.executionStepHeading}><span>{text}</span><small>{t(key)}</small></div>
          {report?.detail && <p>{report.detail}</p>}{report?.updatedAt !== undefined && <time dateTime={new Date(report.updatedAt).toISOString()}>{t('agentReportedAt', { time: new Date(report.updatedAt).toLocaleString() })}</time>}
        </div>
      </li>
    })}</ol>
    <details className={css.planContents} data-execution-plan open={status === 'awaiting-approval'}><summary>{t('plan')} · #{plan.revision}</summary>
      <p className={css.prewrap}>{plan.summary}</p>{plan.frameworks.map(framework => <p key={framework.name}><a href={framework.documentation} target="_blank" rel="noreferrer">{framework.name} {framework.version}</a></p>)}
      {status === 'awaiting-approval' && <div className={css.planApproval}><p className={css.hint}>{t('todoResourceHint')}</p><Button variant="primary" size="sm" disabled={approving} icon={approving ? <StateDot state="ongoing" /> : undefined} onClick={onApprove}>{t(approving ? 'approvingPlan' : 'approve')}</Button></div>}
    </details>
  </section>
}
