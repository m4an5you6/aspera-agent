/** GPU experiment target configuration and durable handover records. */

import { useEffect, useRef } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ExperimentDispatchRecord } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { SecretField, ValueField } from './fields.tsx'
import { PluginConfigForm } from './PluginConfigForm.tsx'
import type { ExperimentDispatchCardFace } from './experiment-dispatch-card-controller.ts'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import css from './ExperimentDispatchCard.module.css'

/** Props bound by the Plugins page. */
export type ExperimentDispatchCardProps =
  PropsRuntime<'plugins.item'> & PropsLocale<'settings.plugins'> & InjectFace<ExperimentDispatchCardFace>

const fields = [
  { field: 'host', labelKey: 'experimentHost', hintKey: 'experimentHostHint' },
  { field: 'username', labelKey: 'experimentUsername', hintKey: 'experimentUsernameHint' },
  { field: 'sshPort', labelKey: 'experimentSshPort', hintKey: 'experimentSshPortHint', numeric: true },
  { field: 'remotePort', labelKey: 'experimentRemotePort', hintKey: 'experimentRemotePortHint', numeric: true },
  { field: 'remoteRoot', labelKey: 'experimentRemoteRoot', hintKey: 'experimentRemoteRootHint' },
  { field: 'localRepo', labelKey: 'experimentLocalRepo', hintKey: 'experimentLocalRepoHint' },
  { field: 'identityFile', labelKey: 'experimentIdentityFile', hintKey: 'experimentIdentityFileHint' },
  { field: 'dataRoots', labelKey: 'experimentDataRoots', hintKey: 'experimentDataRootsHint' },
  { field: 'tokenRef', labelKey: 'experimentTokenRef', hintKey: 'experimentTokenRefHint' },
  { field: 'agentCredentialRefs', labelKey: 'experimentAgentCredentialRefs', hintKey: 'experimentAgentCredentialRefsHint' },
  { field: 'toolTimeoutMs', labelKey: 'experimentToolTimeoutMs', hintKey: 'experimentToolTimeoutMsHint', numeric: true },
] as const

const stateLabels: Record<ExperimentDispatchRecord['state'], PluginsSettingsLocaleKey> = {
  reserved: 'experimentReserved', accepted: 'experimentAccepted', complete: 'experimentComplete',
  blocked: 'experimentBlocked', failed: 'experimentFailed', cancelled: 'experimentCancelled',
  interrupted: 'experimentInterrupted',
}

/** Render the GPU target form and saved experiment controls. */
export function ExperimentDispatchCard(props: ExperimentDispatchCardProps) {
  const { t } = props
  const state = props.useExperimentDispatchCard(snapshot => snapshot)
  const load = useRef(props.loadRecords)
  load.current = props.loadRecords
  useEffect(() => {
    if (props.view === 'page') load.current()
  }, [props.view])
  if (props.view === 'summary') return t('experimentDescription')
  return (
    <div className={css.page}>
      <PluginConfigForm t={t} state={state} onSave={props.save} onDiscard={props.discard}>
        <p className={css.intro}>{t('experimentTargetIntro')}</p>
        <div className={css.loginMethod}>
          <label htmlFor="plugin-config-experiment-auth-mode">{t('experimentAuthMode')}</label>
          <select id="plugin-config-experiment-auth-mode" value={state.fields.authMode.text || 'key'} disabled={!state.writable}
            onChange={(event) => { props.edit('authMode', event.target.value) }}>
            <option value="password">{t('experimentPasswordMode')}</option>
            <option value="key">{t('experimentKeyMode')}</option>
          </select>
        </div>
        <p className={css.intro}>{t('experimentAuthModeHint')}</p>
        {fields.filter(({ field }) => field !== 'identityFile' || state.fields.authMode.text !== 'password').map(({ field, labelKey, hintKey, ...options }) => (
          <ValueField
            key={field}
            id={`plugin-config-experiment-${field}`}
            label={t(labelKey)}
            hint={t(hintKey)}
            overriddenLabel={t('overridden')}
            resetLabel={t('reset')}
            invalidLabel={t(field === 'dataRoots' || field === 'agentCredentialRefs'
              ? 'experimentInvalidList' : 'invalidNumber')}
            disabled={!state.writable}
            {...options}
            {...state.fields[field]}
            onEdit={(text) => { props.edit(field, text) }}
            onReset={() => { props.resetField(field) }}
          />
        ))}
        {state.fields.authMode.text === 'password' ? <SecretField
          id="plugin-config-experiment-ssh-password"
          label={t('experimentSshPassword')}
          hint={t('experimentSshPasswordHint')}
          text={state.sshPassword.text}
          configured={state.sshPasswordConfigured}
          stateLabel={t(state.sshPasswordConfigured ? 'experimentPasswordSet' : 'experimentPasswordUnset')}
          disabled={!state.writable || !state.sshPasswordWritable}
          onEdit={(text) => { props.edit('sshPassword', text) }}
        /> : null}
        <SecretField
          id="plugin-config-experiment-receiver-token"
          label={t('experimentReceiverToken')}
          hint={t('experimentReceiverTokenHint')}
          text={state.receiverToken.text}
          configured={state.receiverTokenConfigured}
          stateLabel={t(state.receiverTokenConfigured ? 'experimentTokenSet' : 'experimentTokenUnset')}
          disabled={!state.receiverTokenWritable}
          onEdit={(text) => { props.edit('receiverToken', text) }}
        />
      </PluginConfigForm>
      <p className={css.intro}>{t('experimentUsage')}</p>
      <section aria-label={t('experimentRecordsTitle')} className={css.records}>
        <div className={css.heading}>
          <h3>{t('experimentRecordsTitle')}</h3>
          <button type="button" onClick={props.loadRecords} disabled={state.loading}>
            {t('experimentReload')}
          </button>
        </div>
        {state.recordError !== undefined ? <p role="alert" className={css.error}>{state.recordError}</p> : null}
        {state.loading && !state.loaded ? <p role="status">{t('experimentLoading')}</p> : null}
        {state.loaded && state.records.length === 0 ? <p role="status">{t('experimentEmpty')}</p> : null}
        {state.records.map((entry) => {
          const record = entry.latest ?? entry.receipt
          const terminal = record?.state === 'complete' || record?.state === 'failed'
            || record?.state === 'cancelled' || record?.state === 'interrupted'
          return (
            <article className={css.record} key={entry.submissionId}>
              <div className={css.recordHead}>
                <strong>{record === undefined ? t('experimentUnknown') : t(stateLabels[record.state])}</strong>
                <span>{entry.host ?? t('experimentLegacyTarget')}</span>
              </div>
              {entry.handover === undefined ? null : <p className={css.handover}>{t('experimentHandover')}</p>}
              <dl>
                <dt>{t('experimentSubmissionId')}</dt><dd>{entry.submissionId}</dd>
                {entry.goalId === undefined ? null : <><dt>{t('experimentLocalGoal')}</dt><dd>{entry.goalId} · {entry.goalRevision ?? '?'}</dd></>}
                {record === undefined ? null : <>
                  <dt>{t('experimentRemoteSession')}</dt><dd>{record.sessionId}</dd>
                  {record.goalId === undefined ? null : <><dt>{t('experimentRemoteGoal')}</dt><dd>{record.goalId}</dd></>}
                  <dt>{t('experimentArtifacts')}</dt><dd>{record.artifactPath}</dd>
                  <dt>{t('experimentWorkerLog')}</dt><dd>{record.workerLogPath}</dd>
                  {record.detail === undefined ? null : <><dt>{t('experimentDetail')}</dt><dd>{record.detail}</dd></>}
                </>}
              </dl>
              {record?.artifactFiles?.length ? (
                <ul className={css.artifacts}>
                  {record.artifactFiles.map(file => <li key={file.path}>{file.path} ({file.sizeBytes} {t('experimentBytes')})</li>)}
                </ul>
              ) : null}
              <div className={css.actions}>
                <button type="button" disabled={state.busyId !== undefined || entry.host === undefined}
                  onClick={() => { props.refreshRecord(entry.submissionId) }}>
                  {t('experimentRefresh')}
                </button>
                <button type="button" disabled={state.busyId !== undefined || entry.host === undefined || terminal}
                  onClick={() => { props.cancelRecord(entry.submissionId) }}>
                  {t('experimentCancel')}
                </button>
              </div>
            </article>
          )
        })}
      </section>
    </div>
  )
}
