/** Validated private IPC messages and window navigation policy. */
import z from 'zod'

/** Only the owned loopback application can become the desktop document. */
export const launchUrlSchema = z.string().url().refine(value => {
  const url = new URL(value)
  return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== ''
    && !url.username && !url.password && url.pathname === '/' && Boolean(url.searchParams.get('token'))
}, 'Desktop Host must provide an authenticated loopback URL')

/** Host readiness is carried privately, outside model and browser interfaces. */
export const hostEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('aspera-desktop-ready'), url: launchUrlSchema }).strict(),
  z.object({ type: z.literal('aspera-desktop-fatal'), detail: z.string() }).strict(),
])

/** Renderer processes cannot send these parent-to-Host messages. */
export const hostControlSchema = z.object({ type: z.literal('aspera-desktop-shutdown') }).strict()

/**
 * Decide whether navigation stays inside the owned application.
 * @param candidate - destination URL.
 * @param origin - running Host origin.
 * @returns whether the document may navigate to this destination.
 */
export function isOwnedNavigation(candidate: string, origin: string): boolean {
  try { const url = new URL(candidate); return url.origin === origin && !url.username && !url.password }
  catch (error) { void error; return false }
}

/**
 * Permit ordinary documentation links in the system browser.
 * @param candidate - destination supplied by a link.
 * @returns whether the link is HTTPS and contains no URL credentials.
 */
export function isExternalLink(candidate: string): boolean {
  try { const url = new URL(candidate); return url.protocol === 'https:' && !url.username && !url.password }
  catch (error) { void error; return false }
}
