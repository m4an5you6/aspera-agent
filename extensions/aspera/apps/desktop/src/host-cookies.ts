/** Route the owned Host's authentication cookie without changing Chromium's stored cookies. */
import { createHash } from 'node:crypto'
import type { Session } from 'electron'

/**
 * Filter authority-specific cookies issued by the pinned DSH browser authentication implementation.
 * @param requestUrl - HTTP or WebSocket destination.
 * @param ownedOrigin - Loopback origin returned by the owned Host.
 * @param header - Original Cookie header, including unrelated application cookies.
 * @returns Only the matching DSH authority cookie and unchanged unrelated cookies.
 */
export function hostCookieHeader(requestUrl: string, ownedOrigin: string, header: string): string {
  const owned = new URL(ownedOrigin), requested = new URL(requestUrl)
  if (requested.host !== owned.host || !['http:', 'ws:'].includes(requested.protocol)) return header
  const name = 'dsh-auth-' + createHash('sha256').update(owned.host).digest('base64url')
  return header.split(';').map(value => value.trim()).filter(value => {
    const key = value.slice(0, value.indexOf('='))
    return !key.startsWith('dsh-auth-') || key === name
  }).join('; ')
}

/**
 * Limit authentication headers to the private Host before Chromium sends its first navigation.
 * @param session - The application's private Chromium session.
 * @param ownedOrigin - Validated loopback Host origin.
 * @returns Disposal of the application's request listener.
 */
export function installHostCookieRouting(session: Pick<Session, 'webRequest'>, ownedOrigin: string): () => void {
  const owned = new URL(ownedOrigin)
  if (owned.protocol !== 'http:' || owned.hostname !== '127.0.0.1' || owned.username || owned.password
    || owned.pathname !== '/' || owned.search || owned.hash) throw new Error('Cookie routing requires the owned loopback Host origin')
  session.webRequest.onBeforeSendHeaders({ urls: [owned.origin + '/*', owned.origin.replace('http:', 'ws:') + '/*'] }, (details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() !== 'cookie') continue
      const value = hostCookieHeader(details.url, ownedOrigin, headers[key]!)
      if (value) headers[key] = value
      else delete headers[key]
    }
    callback({ requestHeaders: headers })
  })
  return () => { session.webRequest.onBeforeSendHeaders(null) }
}
