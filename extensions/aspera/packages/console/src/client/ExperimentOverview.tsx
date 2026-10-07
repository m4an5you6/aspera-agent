/** Experiment pipeline, current work and compact saved configuration. */
import { useRef, type ReactNode } from 'react'
import { StateDot, Tag, IconCheckOutlineRegular, IconWarningOutlineRegular, IconClockOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FleetExperiment, InstallationProgress } from '@aspera/dispatch/types'
import { ExperimentStage } from './ExperimentStage.tsx'
import { ExperimentDiagnostics } from './ExperimentDiagnostics.tsx'
import { InstallationProgress as InstallationRecords } from './InstallationProgress.tsx'
import type { ExecutionProgressView } from './controller.ts'
import { experimentPhases, experimentProgress } from './experiment-progress.ts'
import css from './ExperimentsPage.module.css'

type Props = { row: FleetExperiment; t: TranslateNS<'experiments'> }

/**
 * Keep experiment navigation separate from lifecycle ownership on the Host.
 * @param props - saved experiment, pending operation and real detail-page destinations.
 * @returns an overview with four phases and responsive work/information columns.
 */
export function ExperimentOverview({ row, t, retrying, onRetry, onView, children, installations, execution }: Props & {
  installations: InstallationProgress[]
  execution: ExecutionProgressView | undefined
  retrying: boolean; onRetry: () => void; onView: (tab: 'agentRecords' | 'monitoring' | 'files' | 'services') => void; children: ReactNode
}) {
  const plan = useRef<HTMLDivElement>(null)
  const diagnostics = useRef<HTMLDivElement>(null)
  const { phase, status, local, busy, attention } = experimentProgress(row)
  const showPlan = () => {
    const disclosure = plan.current?.querySelector<HTMLDetailsElement>('details[data-execution-plan]')
    if (disclosure !== null && disclosure !== undefined) disclosure.open = true
    plan.current?.scrollIntoView({ block: 'nearest' })
    plan.current?.focus({ preventScroll: true })
  }
  const showDiagnostics = () => {
    const details = diagnostics.current?.querySelectorAll<HTMLDetailsElement>('details')
    details?.forEach(detail => { detail.open = true })
    diagnostics.current?.scrollIntoView({ block: 'nearest' })
    diagnostics.current?.focus({ preventScroll: true })
  }
  return <div className={css.overview}>
    <section className={css.pipelineSection} aria-label={t('experimentProgress')}>
      <h3 className={css.pipelineLabel}>{t('experimentProgress')}</h3>
      <ol className={css.pipeline}>{experimentPhases.map((label, index) => {
        const complete = index < phase || status === 'completed'
        const current = index === phase
        const active = current && (busy || retrying)
        const needsAttention = current && attention && !retrying
        const state = complete ? 'complete' : current ? needsAttention ? 'attention' : active ? 'active' : 'waiting' : 'pending'
        return <li key={label} aria-current={current ? 'step' : undefined} data-state={state}>
          <span className={css.stepCircle} aria-hidden="true">{complete ? <IconCheckOutlineRegular size={18} /> : active ? <StateDot state="ongoing" size={19} /> : needsAttention ? <IconWarningOutlineRegular size={18} /> : current ? <IconClockOutlineRegular size={18} /> : index + 1}</span>
          <span className={css.stepCopy}><span>{t(label)}</span><small>{t(complete ? 'completed' : current ? retrying ? 'retrying' : status : 'notStarted')}</small></span>
        </li>
      })}</ol>
    </section>
    <div className={css.overviewColumns}>
      <div className={css.workColumn}>
        <ExperimentStage row={row} t={t} retrying={retrying} installations={installations} onRetry={onRetry} onRecords={() => { onView('agentRecords') }} onMonitor={() => { onView('monitoring') }}
          onFiles={() => { onView('files') }} onServices={() => { onView('services') }} onPlan={showPlan} onDiagnostics={showDiagnostics} />
        <div className={css.planArea} ref={plan} tabIndex={-1}>{children}</div>
        <div ref={diagnostics} className={css.diagnosticsArea} tabIndex={-1}><ExperimentDiagnostics row={row} t={t} readError={execution?.error} /></div>
      </div>
      <aside className={css.infoColumn} aria-label={t('experimentInformation')}><PreparationNodes row={row} t={t} />
        {!local && installations.length > 0 && <details className={css.infoSection}><summary>{t('installationRecovery')}</summary><InstallationRecords row={row} installations={installations} t={t} onLogs={() => { onView('monitoring') }} /></details>}
        <ExperimentInformation row={row} t={t} /></aside>
    </div>
    <p className={css.overviewFooter}>{row.receipt !== undefined ? row.receipt.handover : local && busy ? t('keepOpenForPreparation') : t('recordsRetained')}</p>
  </div>
}

function PreparationNodes({ row, t }: Props) {
  const { local, busy } = experimentProgress(row)
  const nodes = [...new Map([row.coordinator, ...row.servers].map(server => [server.id, server])).values()]
  const environments = row.preparation?.environments ?? []
  const ready = nodes.filter(server => environments.some(environment => environment.serverId === server.id && environment.phase === 'environment-ready')).length
  return <section className={css.stageNodes} aria-label={t('nodeProgress')}>
    <div className={css.sectionHeading}><h3>{t('executionResources')}</h3></div>
    <p className={css.hint}>{t('environmentCount', { ready, total: nodes.length })}</p>
    {nodes.map(server => {
      const environment = environments.find(value => value.serverId === server.id)
      const pending = environment?.pendingCommand !== undefined
      const passed = environment?.phase === 'environment-ready'
      const phase = pending ? t('commandUnconfirmed') : environment === undefined ? t('environmentUnrecorded') : passed || local && busy ? t(environment.phase) : t('lastRecordedStage', { stage: t(environment.phase) })
      const diagnostics = environment?.detail ?? environment?.observation?.diagnostics
      const placement = row.preparation?.placements.find(value => value.serverId === server.id)
      const acceptance = row.submission?.nodes.find(value => value.server.id === server.id)
      return <article className={css.stageNode} key={server.id}>
        <div className={css.nodeHeader}><div><h4>{server.name}</h4><span className={css.hint}>{t(server.id === row.coordinator.id ? row.servers.some(node => node.id === server.id) ? 'coordinatorAndExecutionNode' : 'coordinator' : 'executionNode')}</span></div></div>
        {row.servers.some(node => node.id === server.id) && <div className={css.nodeGpu}><span>{t('savedGpuObservation')}</span><p>{acceptance?.gpuInfo ?? t('gpuObservationMissing')}</p></div>}
        <span className={css.nodeStatus}><StateDot state={pending ? 'warning' : passed ? 'done' : 'idle'} /><span>{phase}</span></span>
        <details className={css.nodeRecords} key={`${server.id}/${local}`} open={local}>
          <summary>{t('environmentRecords')}</summary>
          <div className={css.nodeChecks}>
            <span data-passed={passed}><StateDot state={passed ? 'done' : 'idle'} />{t('prepareEnvironment')}</span>
            <span data-passed={placement !== undefined}><StateDot state={placement !== undefined ? 'done' : 'idle'} />{t('storageSelected')}</span>
            <span data-passed={acceptance !== undefined}><StateDot state={acceptance !== undefined ? 'done' : 'idle'} />{t('sandboxGpuChecks')}</span>
            <span data-passed={row.receipt !== undefined}><StateDot state={row.receipt !== undefined ? 'done' : 'idle'} />{t('remoteHandover')}</span>
          </div>
          {environment?.observation !== undefined && <details className={css.nodeDiagnostics}><summary>{t('programPaths')}</summary><dl className={css.programFacts}>{environment.observation.programs.map(program => <div key={program.name}>
            <dt>{program.name}</dt><dd><span>{program.version || '—'}</span>{program.path && <code>{program.path}</code>}</dd>
          </div>)}</dl></details>}
          {acceptance !== undefined && <details className={css.nodeDiagnostics}><summary>{t('acceptanceRecords')}</summary><pre className={css.log}>{[acceptance.backendPath, ...acceptance.devicePaths, acceptance.gpuInfo].join('\n')}</pre></details>}
          {diagnostics && <details className={css.nodeDiagnostics}><summary>{t('environmentDiagnostics')}</summary><pre className={css.log}>{diagnostics}</pre></details>}
        </details>
      </article>
    })}
    <p className={css.hint}>{t('acceptanceSeparateHint')}</p>
  </section>
}

function ExperimentInformation({ row, t }: Props) {
  const { local, remote } = experimentProgress(row)
  const modelGroups = new Map<string, { model: NonNullable<FleetExperiment['models']>['preparation']; phases: ('preparation' | 'planning' | 'execution')[] }>()
  for (const phase of ['preparation', 'planning', 'execution'] as const) {
    const model = row.models?.[phase]
    if (model === undefined) continue
    const key = JSON.stringify(model)
    const group = modelGroups.get(key)
    if (group !== undefined) group.phases.push(phase)
    else modelGroups.set(key, { model, phases: [phase] })
  }
  return <>
    <section className={css.infoSection}><h3>{t('experimentInformation')}</h3><dl className={css.infoFacts}>
      <div><dt>{t('executionLocation')}</dt><dd>{t(local ? 'localPreparation' : 'remoteExecution')}</dd></div>
      <div><dt>{t('automation')}</dt><dd>{t(row.request.mode)}</dd></div>
      <div><dt>{t(remote === undefined ? 'submittedAt' : 'updated')}</dt><dd><time dateTime={new Date(remote?.updatedAt ?? row.createdAt).toISOString()}>{new Date(remote?.updatedAt ?? row.createdAt).toLocaleString()}</time></dd></div>
    </dl><details className={css.infoDisclosure}><summary>{t('technicalDetails')}</summary><dl className={css.infoFacts}>
      <div><dt>{t('experimentId')}</dt><dd><code>{row.request.experimentId}</code></dd></div><div><dt>{t('dispatchSession')}</dt><dd><code>{row.sessionId}</code></dd></div>
      <div><dt>{t('planning')}</dt><dd><code>{remote?.planningSessionId ?? '—'}</code></dd></div><div><dt>{t('executionSession')}</dt><dd><code>{remote?.sessionId ?? t('sessionEmpty')}</code></dd></div>
      <div><dt>{t('sourceVersion')}</dt><dd><code>{row.submission?.deploymentId ?? '—'}</code></dd></div>
    </dl>{row.receipt !== undefined && <details><summary>{t('receipt')}</summary><pre className={css.log}>{JSON.stringify(row.receipt, null, 2)}</pre></details>}
      {(remote?.executions.length ?? 0) > 0 && <details><summary>{t('actualVersions')}</summary><pre className={css.log}>{JSON.stringify(remote?.executions, null, 2)}</pre></details>}
      {row.submission?.protocol === 1 && <details><summary>{t('legacyLimits')}</summary><pre className={css.log}>{JSON.stringify(row.submission.strategy.budget, null, 2)}</pre></details>}
    </details></section>
    {modelGroups.size > 0 && <section className={css.infoSection}><h3>{t('agentModels')}</h3>{[...modelGroups.entries()].map(([key, group]) => <div className={css.infoModel} key={key}>
      <div className={css.sectionHeading}><span className={css.hint}>{group.phases.map(phase => t(`${phase}Model`)).join(' · ')}</span><Tag>{group.model.provider}</Tag></div><p>{group.model.model}</p>
    </div>)}</section>}
    {(row.preparation?.placements.length ?? 0) > 0 && <section className={css.infoSection} aria-label={t('resolvedStorage')}><h3>{t('resolvedStorage')}</h3>{row.preparation?.placements.map(placement => {
      const server = [row.coordinator, ...row.servers].find(value => value.id === placement.serverId)
      return <div className={css.infoStorage} key={placement.serverId}><span className={css.hint}>{server?.name}</span><code className={css.storagePath}>{placement.candidate.directory}</code>
        <p className={css.hint}>{t('availableGiB', { size: (placement.candidate.availableBytes / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 }) })} · {t(placement.candidate.persistence)}</p>
        <details className={css.infoDisclosure}><summary>{t('storageDetails')}</summary><dl className={css.infoFacts}>
          <div><dt>{t('workspaceDirectory')}</dt><dd><code>{placement.workspaceRoot}</code></dd></div><div><dt>{t('selectionReason')}</dt><dd>{placement.reason}</dd></div>
          <div><dt>{t('trainingAddress')}</dt><dd>{server?.trainingAddress ?? (row.servers.length === 1 ? t('networkUnused') : t('noNetworkAddress'))}</dd></div>
        </dl></details>
      </div>
    })}</section>}
    <details className={css.infoSection}><summary>{t('fullGoal')}</summary><div className={css.prewrap}>{row.request.objective}</div></details>
  </>
}
