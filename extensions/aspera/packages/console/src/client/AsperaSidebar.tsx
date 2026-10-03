/** A grouped contribution inside the official DSH sidebar. */
import { Button, Modal, Tag, IconGoalOutlineRegular, IconSettingsOutlineMedium, IconFlatListOutlineRegular, IconDataOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ExperimentsPageProps } from './ExperimentsPage.tsx'
import { experimentAttentionCount, attentionLabel } from './attention.ts'
import css from './ExperimentsPage.module.css'

/** @param props - official shell geometry and Aspera navigation. @returns collapsible group and private model-settings summary. */
export function AsperaSidebar({ wide, expandSidebar, controller, useExperiments, usePanelInfo, t, navigate, manageModels }: PropsRuntime<'sidebar.sections'> & ExperimentsPageProps & {
  navigate: (view: 'list' | 'servers' | 'services') => void; manageModels: () => void
}) {
  const state = useExperiments(value => value)
  const active = usePanelInfo(value => value.activePanelId === 'experiments')
  const count = experimentAttentionCount(state.experiments)
  return <>
    <section className={`${css.sidebarGroup} ${wide ? '' : css.sidebarRail}`}>
      <div className={css.sidebarGroupHeader}>
        <button className={css.sidebarGroupButton} title={t('title')} aria-label={t('title')} aria-expanded={wide && !state.preferences.collapsed}
          onClick={() => { if (!wide) expandSidebar(); else controller.toggleGroup() }}>
          <IconGoalOutlineRegular size={18} />{wide && <span>{t('title')}</span>}
          {count > 0 && <span className={css.count} aria-label={t('pendingCount', { count })}>{attentionLabel(count)}</span>}
        </button>
        {wide && <><small className={css.sidebarVersion}>0.1.1</small><button className={css.sidebarGear} aria-label={t('modelSettings')} title={t('modelSettings')} onClick={() => { controller.modelSettings(true) }}><IconSettingsOutlineMedium size={14} /></button></>}
      </div>
      {wide && !state.preferences.collapsed && <nav aria-label={t('title')} className={css.sidebarChildren}>
        {(['list', 'servers', 'services'] as const).map(view => <button key={view} className={css.sidebarChild}
          aria-current={active && state.view === view ? 'page' : undefined} onClick={() => { navigate(view) }}>
          {view === 'list' ? <IconFlatListOutlineRegular /> : view === 'servers' ? <IconDataOutlineMedium /> : <IconGoalOutlineRegular />}
          <span>{t(view === 'list' ? 'experiments' : view)}</span>
        </button>)}
      </nav>}
    </section>
    <Modal open={state.settingsOpen} onClose={() => { controller.modelSettings(false) }} title={t('modelSettings')} closeLabel={t('close')}
      className={css.serverModal} contentClassName={css.serverModalContent} backdropBlur={false}>
      <div className={css.list}><p className={css.hint}>{t('modelSettingsHint')}</p>
        {state.modelsLoading && <p role="status">{t('loading')}</p>}
        {state.modelsError !== null && <p role="alert">{state.modelsError}</p>}
        {state.modelDirectory?.models.length === 0 && <p>{t('chooseModelsHint')}</p>}
        {state.modelDirectory?.models.map(row => <div className={css.modelSettingRow} key={`${row.provider}/${row.model}`}>
          <div><span>{row.name}</span><small>{row.providerName}</small></div>
          <Tag tone={row.configured && row.transferable ? 'success' : 'warning'}>{t(row.configured && row.transferable ? 'modelConfigured' : 'modelUnavailable')}</Tag>
        </div>)}
        <div className={css.actions}><Button variant="primary" onClick={() => { controller.modelSettings(false); manageModels() }}>{t('manageModels')}</Button>
          <Button variant="ghost" onClick={() => { void controller.loadModels() }}>{t('refresh')}</Button></div>
      </div>
    </Modal>
  </>
}
