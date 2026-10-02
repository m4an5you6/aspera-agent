/** Private desktop lifecycle plugin, mounted only by the desktop dsh profile. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { hostControlSchema } from './protocol.ts'

/** Desktop readiness requires the authenticated Web application. */
export const inject = ['webServer', 'connection']

/**
 * Connect the private parent IPC channel to the CLI's owned shutdown path.
 * @param ctx - profile plugin context.
 */
export function apply(ctx: Context): void {
  if (process.send === undefined) throw new Error('The Aspera desktop profile requires its private parent IPC channel')
  let live = true
  ctx.effect(() => {
    const shutdown = (message: unknown): void => {
      if (hostControlSchema.safeParse(message).success) process.emit('SIGTERM')
    }
    const disconnected = (): void => { process.emit('SIGTERM') }
    process.on('message', shutdown)
    process.on('disconnect', disconnected)
    return () => { live = false; process.off('message', shutdown); process.off('disconnect', disconnected) }
  })
  void ctx.loader.await().then(() => {
    if (!live || !process.connected) return
    const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`)
    process.send?.({ type: 'aspera-desktop-ready', url })
  }).catch((error: unknown) => {
    if (live && process.connected) process.send?.({ type: 'aspera-desktop-fatal', detail: error instanceof Error ? error.message : String(error) })
  })
}
