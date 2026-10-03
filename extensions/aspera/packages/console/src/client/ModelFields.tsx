/** Phase model controls reuse the DSH provider directory and account settings. */
import { useState } from 'react'
import { Button, Menu, IconChevronDownOutlineRegular, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentModels, ExperimentModelDirectory, PhaseModelSelection } from '@aspera/experiments/types'
import css from './ExperimentsPage.module.css'

/** @param props - labeled options. @returns a theme-aware official menu control. */
export function Choice<Value extends string>({ label, value, options, onChange, disabled = false }: {
  label: string; value: Value; options: readonly { value: Value; label: string }[]; onChange: (value: Value) => void; disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  return <Menu open={open && !disabled} portal className={css.selection} selectedId={value}
    items={options.map(option => ({ id: option.value, label: option.label }))} onClose={() => { setOpen(false) }}
    onSelect={id => { const row = options.find(option => option.value === id); if (row !== undefined) onChange(row.value); setOpen(false) }}
    anchor={<Button variant="outline" className={css.selectButton} aria-label={label} aria-haspopup="menu"
      aria-expanded={open && !disabled} disabled={disabled} onClick={() => { setOpen(current => !current) }}>
      <span>{options.find(option => option.value === value)?.label ?? label}</span><IconChevronDownOutlineRegular />
    </Button>} />
}

/** @param models - phase choices. @param directory - live model readiness. @returns whether every phase is explicitly serviceable. */
export function modelsReady(models: ExperimentModels | undefined, directory: ExperimentModelDirectory | null): boolean {
  return models !== undefined && (['preparation', 'planning', 'execution'] as const).every(phase => {
    const selection = models[phase]
    return directory?.models.some(row => row.provider === selection.provider && row.model === selection.model && row.configured && row.transferable
      && (selection.reasoningEffort === undefined || row.reasoning.some(option => option.id === selection.reasoningEffort)))
  })
}

/** @param props - model directory and explicit draft choices. @returns three independent selectors and shared selection action. */
export function ModelFields({ t, models, directory, change, manage, disabled }: {
  t: TranslateNS<'experiments'>; models: ExperimentModels | undefined; directory: ExperimentModelDirectory | null
  change: (models: ExperimentModels) => void; manage: () => void; disabled: boolean
}) {
  const phases = ['preparation', 'planning', 'execution'] as const
  const choose = (phase: typeof phases[number], value: PhaseModelSelection) => {
    const base = models ?? { preparation: value, planning: value, execution: value }
    change({ ...base, [phase]: value })
  }
  return <section className={css.formSection}>
    <div className={css.sectionHeading}><h2>{t('agentModels')}</h2><Button size="sm" variant="ghost" onClick={manage}>{t('modelSettings')}</Button></div>
    <p className={css.hint}>{t('agentModelsHint')}</p>
    <div className={css.modelFields}>{phases.map(phase => {
      const selection = models?.[phase]
      const row = directory?.models.find(item => item.provider === selection?.provider && item.model === selection?.model)
      return <div className={css.modelField} key={phase}><span>{t(`${phase}Model`)}</span>
        <Choice label={t(`${phase}Model`)} disabled={disabled} value={selection === undefined ? '' : JSON.stringify([selection.provider, selection.model])}
          options={(directory?.models ?? []).filter(item => item.model !== '').map(item => ({ value: JSON.stringify([item.provider, item.model]),
            label: `${item.providerName} · ${item.name}${item.configured && item.transferable ? '' : ` · ${t('modelUnavailable')}`}` }))}
          onChange={value => { const item = directory?.models.find(item => JSON.stringify([item.provider, item.model]) === value); if (item !== undefined) choose(phase, { provider: item.provider, model: item.model }) }} />
        {row !== undefined && <div className={css.modelMeta}><Tag tone={row.configured && row.transferable ? 'success' : 'warning'}>{t(row.configured && row.transferable ? 'modelConfigured' : 'modelUnavailable')}</Tag>
          <span title={row.provider}>{row.provider}</span></div>}
        {row !== undefined && row.reasoning.length > 0 && <Choice label={t('reasoning')} value={selection?.reasoningEffort ?? ''}
          disabled={disabled} options={[{ value: '', label: t('providerDefault') }, ...row.reasoning.map(item => ({ value: item.id, label: item.name }))]}
          onChange={effort => { if (selection === undefined) return; const option = row.reasoning.find(item => item.id === effort)
            choose(phase, { provider: selection.provider, model: selection.model, ...(option === undefined ? {} : { reasoningEffort: option.id as NonNullable<PhaseModelSelection['reasoningEffort']> }) }) }} />}
        {row?.detail !== undefined && <details className={css.hint}><summary>{t('configurationDetails')}</summary>{row.detail}</details>}
      </div>
    })}</div>
    <Button size="sm" variant="outline" disabled={disabled || models === undefined} onClick={() => { if (models !== undefined) change({ preparation: models.preparation, planning: models.preparation, execution: models.preparation }) }}>{t('applyAllModels')}</Button>
    {!modelsReady(models, directory) && <p role="status" className={css.hint}>{t('chooseModelsHint')}</p>}
  </section>
}
