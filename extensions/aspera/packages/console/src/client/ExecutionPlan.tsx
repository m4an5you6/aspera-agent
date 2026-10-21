/** Plan text and Agent step reports share a version; program acceptance remains separate. */
import { useEffect, useRef, useState } from 'react'
import { Button, Input, StateDot, IconCheckOutlineRegular, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment } from '@aspera/dispatch/types'
import type { ExecutionProgressView } from './controller.ts'
import { experimentProgress } from './experiment-progress.ts'
import { stepTitle, stepExcerpt, displayedStepReports } from './execution-step-view.ts'
import css from './ExperimentsPage.module.css'

/** @param props - saved plan, bound reports and the existing approval action. @returns actual plan steps, never inferred from old metrics. */
export function ExecutionPlan(props: {
  activityConfirmed?: boolean; approvalDisabled?: boolean
  row: FleetExperiment; t: TranslateNS<'experiments'>; execution: ExecutionProgressView | undefined; approving: boolean; onApprove: () => void
  onRecords?: () => void
}) {
  const plan = experimentProgress(props.row).remote?.plan
  if (plan === undefined) return null
  return <PlanSteps key={`${props.row.request.experimentId}/${plan.revision}/${experimentProgress(props.row).remote?.sessionId ?? ''}`} {...props} />
}

type Reading = { search: string; all: boolean; completed: boolean; pending: boolean; expanded: number[]; anchor?: number }
function readPosition(key: string): Reading {
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
    if (raw !== null && typeof raw === 'object' && 'search' in raw && typeof raw.search === 'string' && 'all' in raw && typeof raw.all === 'boolean'
      && 'completed' in raw && typeof raw.completed === 'boolean' && 'pending' in raw && typeof raw.pending === 'boolean'
      && 'expanded' in raw && Array.isArray(raw.expanded) && raw.expanded.every(value => Number.isSafeInteger(value) && value >= 0)) {
      return { search: raw.search, all: raw.all, completed: raw.completed, pending: raw.pending, expanded: raw.expanded,
        ...('anchor' in raw && typeof raw.anchor === 'number' && Number.isSafeInteger(raw.anchor) && raw.anchor >= 0 ? { anchor: raw.anchor } : {}) }
    }
  } catch (_error) { /* A missing or inaccessible UI preference does not hide experiment records. */ }
  return { search: '', all: false, completed: false, pending: false, expanded: [] }
}

function PlanSteps({ row, t, execution, approving, onApprove, activityConfirmed, approvalDisabled, onRecords }: Parameters<typeof ExecutionPlan>[0]) {
  const { remote, busy, status } = experimentProgress(row)
  const plan = remote!.plan!
  const storageKey = `aspera:step-reading:${row.request.experimentId}:${plan.revision}:${remote?.sessionId ?? ''}`
  const [reading, setReading] = useState(() => readPosition(storageKey))
  const list = useRef<HTMLDivElement>(null)
  const restored = useRef(false)
  useEffect(() => {
    try { sessionStorage.setItem(storageKey, JSON.stringify(reading)) }
    catch (_error) { /* Sandboxed storage may be unavailable; in-memory reading state remains usable. */ }
  }, [reading, storageKey])
  useEffect(() => {
    if (restored.current || execution?.value === undefined) return
    restored.current = true
    if (reading.anchor === undefined) return
    const target = list.current?.querySelector<HTMLElement>(`[data-step-index="${reading.anchor}"]`)
    if (target !== undefined && target !== null && target.getClientRects().length > 0) target.scrollIntoView({ block: 'nearest' })
  }, [execution?.value, reading.anchor])
  useEffect(() => {
    let frame: number | undefined
    let scroller = list.current?.parentElement
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    const target = scroller ?? document
    const save = () => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        const top = scroller?.getBoundingClientRect().top ?? 0
        const item = [...(list.current?.querySelectorAll<HTMLElement>('[data-step-index]') ?? [])].find(element => {
          const rect = element.getBoundingClientRect(); return rect.height > 0 && rect.bottom > top && rect.top < innerHeight
        })
        if (item !== undefined) { const anchor = Number(item.dataset.stepIndex); setReading(value => value.anchor === anchor ? value : { ...value, anchor }) }
      })
    }
    target.addEventListener('scroll', save, { passive: true })
    return () => { target.removeEventListener('scroll', save); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [])
  const saved = execution?.value?.progress
  const originalProgress = saved?.experimentId === row.request.experimentId && saved.planRevision === plan.revision && saved.sessionId === (remote?.sessionId ?? `aspera-execution-${row.request.experimentId}`) ? saved : undefined
  const assessment = row.completionAssessment?.planRevision === plan.revision && row.completionAssessment.executionSessionId === remote?.sessionId
    && row.completionAssessment.originalRevision === remote?.revision ? row.completionAssessment : undefined
  const supplements = new Map(assessment?.steps.map(step => [step.step, step]) ?? [])
  const reports = displayedStepReports(originalProgress?.steps ?? [], plan.steps.length, assessment?.steps ?? [])
  const reported = (originalProgress?.revision ?? 0) > 0 || supplements.size > 0
  const complete = [...reports.values()].filter(step => step.state === 'completed').length
  const waiting = remote?.startedAt === undefined && remote?.sessionId === undefined && ['queued', 'awaiting-approval'].includes(status)
  const exitConfirmed = remote?.resourcesReleased === true && remote.services.every(service => service.released)
    && ['completed', 'failed', 'blocked', 'cancelled', 'interrupted'].includes(status)
  const items = plan.steps.map((text, index) => ({ text, index, report: reports.get(index + 1) }))
  const current = items.filter(item => item.report?.state === 'running' || item.report?.state === 'blocked')
  const finished = items.filter(item => item.report?.state === 'completed')
  const pending = items.filter(item => !current.includes(item) && !finished.includes(item))
  const query = reading.search.trim().toLocaleLowerCase()
  const renderStep = ({ text, index, report }: typeof items[number]) => {
      const state = report?.state ?? 'pending'
      const active = state === 'running' && busy && activityConfirmed !== false
      const key = state === 'running' && !active ? exitConfirmed ? 'stepStopped' : 'stepActivityUnconfirmed'
        : report === undefined && !waiting ? 'stepUnreported' : `step-${state}` as const
      const expanded = reading.expanded.includes(index)
      return <li key={index} data-step-index={index} data-step-state={state} data-current-step={current.some(item => item.index === index) || undefined} aria-busy={active} tabIndex={-1}>
        <span className={css.executionStepIcon} aria-hidden="true">{state === 'completed' ? <IconCheckOutlineRegular size={17} /> : active ? <StateDot state="ongoing" size={17} /> : state === 'blocked' ? <IconWarningOutlineRegular size={17} /> : index + 1}</span>
        <div className={css.executionStepCopy}>
          <button type="button" className={css.stepToggle} aria-expanded={expanded} onClick={() => { setReading(value => ({ ...value, expanded: expanded ? value.expanded.filter(item => item !== index) : [...value.expanded, index] })) }}>
            <span className={css.executionStepHeading}><span>{index + 1}. {stepTitle(text)}</span><small>{t(key)}</small></span>
            {report?.detail && <span className={css.stepExcerpt}>{stepExcerpt(report.detail)}</span>}
          </button>
          {expanded && <div className={css.stepDetails}><h4>{t('stepRequirement')}</h4><p>{text}</p>
            {report?.detail && <><h4>{t('stepResult')}</h4><p>{report.detail}</p></>}
            {report?.updatedAt !== undefined && <time dateTime={new Date(report.updatedAt).toISOString()}>{t(supplements.has(index + 1) ? 'reviewSupplementReportedAt' : 'agentReportedAt', { time: new Date(report.updatedAt).toLocaleString() })}</time>}
            {supplements.has(index + 1) && <p className={css.hint}>{t('reviewOriginalStepState', { state: t(`step-${originalProgress?.steps.find(step => step.step === index + 1)?.state ?? 'pending'}`) })}</p>}
            {onRecords !== undefined && <Button variant="ghost" size="sm" onClick={onRecords}>{t('viewAgentRecords')}</Button>}
          </div>}
        </div>
      </li>
  }
  const group = (kind: 'completed' | 'pending', rows: typeof items) => rows.length === 0 ? null : <details className={css.stepGroup} open={reading[kind]}
    onToggle={event => { const open = event.currentTarget.open; if (open !== reading[kind]) setReading(value => ({ ...value, [kind]: open })) }}>
    <summary>{t(kind === 'completed' ? 'stepCompletedGroup' : 'stepRemainingGroup', { count: rows.length })}</summary><ol className={css.executionSteps}>{rows.map(renderStep)}</ol>
  </details>
  return <section className={css.executionPlan} aria-label={t('executionProgress')}>
    <div className={css.sectionHeading}><h3>{t('executionProgress')}</h3><span className={css.hint}>{reported ? t('completedSteps', { complete, total: plan.steps.length }) : t('planStepCount', { total: plan.steps.length })}</span></div>
    <p className={css.stepSource}>{t(reported ? 'stepReportsHint' : waiting ? 'planNotStarted' : 'stepsUnrecorded')}</p>
    {execution?.error !== undefined && <p className={css.progressReadNotice} aria-live="polite">{t(execution.receivedAt === undefined ? 'stepInitialReadFailed' : 'stepRefreshFailed')}{execution.receivedAt !== undefined && <span> · {t('lastReadAt', { time: new Date(execution.receivedAt).toLocaleString() })}</span>}</p>}
    <div className={css.stepToolbar}><Input aria-label={t('searchSteps')} placeholder={t('searchSteps')} value={reading.search} onChange={event => { setReading(value => ({ ...value, search: event.target.value })) }} />
      <Button variant="ghost" size="sm" aria-pressed={reading.all} onClick={() => { setReading(value => ({ ...value, all: !value.all })) }}>{t(reading.all ? 'groupSteps' : 'allSteps')}</Button>
      <Button variant="ghost" size="sm" disabled={current.length === 0} onClick={() => { setReading(value => ({ ...value, search: '' })); requestAnimationFrame(() => { const target = list.current?.querySelector<HTMLElement>('[data-current-step]'); target?.scrollIntoView({ block: 'nearest' }); target?.focus({ preventScroll: true }) }) }}>{t('locateCurrentStep')}</Button></div>
    <div ref={list}>{query || reading.all ? <ol className={css.executionSteps}>{items.filter(item => !query || `${item.index + 1} ${item.text} ${item.report?.detail ?? ''}`.toLocaleLowerCase().includes(query)).map(renderStep)}</ol>
      : <>{group('completed', finished)}{current.length > 0 && <ol className={css.executionSteps}>{current.map(renderStep)}</ol>}{group('pending', pending)}</>}</div>
    <details className={css.planContents} data-execution-plan open={status === 'awaiting-approval'}><summary>{t('plan')} · #{plan.revision}</summary>
      <p className={css.prewrap}>{plan.summary}</p>{plan.frameworks.map(framework => <p key={framework.name}><a href={framework.documentation} target="_blank" rel="noreferrer">{framework.name} {framework.version}</a></p>)}
      {plan.stages?.map(stage => <div key={stage.stageId}><h4>{stage.title}</h4>
        <p>{t('stageOptimizerCounts', { start: stage.startStep, additional: stage.additionalSteps, end: stage.endStep })}</p>
        <details><summary>{t('reviewDiagnostics')}</summary><pre className={css.log}>{JSON.stringify(stage, null, 2)}</pre></details>
      </div>)}
      {status === 'awaiting-approval' && <div className={css.planApproval}><p className={css.hint}>{t('todoResourceHint')}</p><Button variant="primary" size="sm" disabled={approving || approvalDisabled} icon={approving ? <StateDot state="ongoing" /> : undefined} onClick={onApprove}>{t(approving ? 'approvingPlan' : 'approve')}</Button></div>}
    </details>
  </section>
}
