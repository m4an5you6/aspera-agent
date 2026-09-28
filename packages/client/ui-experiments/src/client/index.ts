/** Register the experiment list and detail panel in the shipped Web composition. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { Config } from '../config.ts'
import { ExperimentsController } from './controller.ts'
import { ExperimentsIcon, ExperimentsPage } from './ExperimentsPage.tsx'
import { en, zh } from './locales.ts'
export { Config } from '../config.ts'

export const inject = ['slots', 'locale', 'remote', 'remote.experimentDispatch']

/**
 * @param ctx - browser plugin context.
 * @param config - refresh and retained-output settings.
 */
export function apply(ctx: Context, config: Config): void {
  const controller = new ExperimentsController(ctx.remote.experimentDispatch, config)
  ctx.effect(() => ctx.locale.register('experiments', { en, zh }), 'experiments: dictionaries')
  const t = ctx.locale.bind('experiments')
  ctx.effect(() => {
    const timer = setInterval(() => { controller.tick() }, config.pollIntervalMs)
    return () => { clearInterval(timer); controller.dispose() }
  }, 'experiments: refresh lifecycle')
  ctx.on('connection/reset', () => { controller.tick() })
  ctx.effect(() => ctx.remote.$on('experiment-fleet/changed', () => { controller.tick() }), 'experiments: record subscriptions')
  const panel = 'experiments' as MainPanelId
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: panel, locale: 'experiments',
    inject: () => ({ controller, hooks: { experiments: controller.store } }),
  }, ExperimentsPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: panel, order: 5,
    label: () => t('title'), locale: 'experiments',
  }, ExperimentsIcon))
}
