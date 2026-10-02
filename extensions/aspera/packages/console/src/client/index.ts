import { cssText } from './ExperimentsPage.module.css'
/** Register the experiment list and detail panel in the shipped Web composition. */
import type { Context } from '@deepseek-ai/cordis'
import { TYPERT_REMOTE } from '@aspera/dispatch/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { Config } from '../config.ts'
import { ExperimentsController } from './controller.ts'
import { ExperimentsIcon, ExperimentsPage } from './ExperimentsPage.tsx'
import { en, zh } from './locales.ts'
import { experimentAttentionCount } from './attention.ts'
export { Config } from '../config.ts'

export const inject = ['slots', 'locale', 'remote']

/**
 * @param ctx - browser plugin context.
 * @param config - refresh and retained-output settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const unmount = await ctx.remote.$mount(TYPERT_REMOTE)
  ctx.effect(() => unmount, 'Aspera: Remote descriptors')
  ctx.inject(['remote.aspera', 'slots', 'locale', 'remote'], (scope) => {
    scope.effect(() => { const tag = document.createElement('style'); tag.dataset.aspera = 'console'; tag.textContent = cssText; document.head.appendChild(tag); return () => { tag.remove() } }, 'Aspera: styles')
    const controller = new ExperimentsController(scope.remote.aspera, config)
    scope.effect(() => scope.locale.register('experiments', { en, zh }), 'experiments: dictionaries')
    const t = scope.locale.bind('experiments')
    scope.effect(() => {
      let previous: number | undefined
      const update = () => {
        const count = experimentAttentionCount(controller.store.getSnapshot().experiments)
        if (previous === count) return
        previous = count
        void window.asperaDesktop?.setAttentionCount(count).catch((error: unknown) => { controller.report(error) })
      }
      const dispose = controller.store.subscribe(update)
      update()
      return dispose
    }, 'Aspera: desktop attention count')
    scope.effect(() => {
      const timer = setInterval(() => { controller.tick() }, config.pollIntervalMs)
      return () => { clearInterval(timer); controller.dispose() }
    }, 'experiments: refresh lifecycle')
    scope.on('connection/reset', () => { controller.tick() })
    scope.effect(() => {
      const stream = scope.remote.$stream({ name: 'aspera-watch', open: signal => scope.remote.aspera.watch(signal),
        ended: accepted => new Error(accepted ? 'Aspera watch disconnected' : 'Aspera watch ended before the initial snapshot') })
      const watch = (async () => { for await (const item of stream) { controller.receive(item.value); item.accept(); controller.tick() } })()
      void watch.catch((error: unknown) => { controller.report(error) })
      return async () => { await stream.dispose(); await watch }
    }, 'Aspera: reconnecting state stream')
    const panel = 'experiments' as MainPanelId
    scope.slots.inject('main', () => scope.slots.register({ name: 'main', key: panel, locale: 'experiments',
      inject: () => ({ controller, hooks: { experiments: controller.store } }),
    }, ExperimentsPage))
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({ name: 'sidebar.panellist', id: panel, order: 5,
      label: () => t('title'), locale: 'experiments',
      inject: () => ({ controller, hooks: { experiments: controller.store } }),
    }, ExperimentsIcon))
  })
}

declare global {
  interface Window { asperaDesktop?: { setAttentionCount(count: number): Promise<void> } }
}
