/** Clipboard policy keeps permission scope independent from whether the browser API exists. */
import { expect, it } from 'vitest'
import { allowClipboardWrite } from '../src/protocol.ts'

const request = { permission: 'clipboard-sanitized-write', owned: true, focused: true, mainFrame: true,
  origin: 'http://127.0.0.1:32145', currentUrl: 'http://127.0.0.1:32145/', requestingUrl: 'http://127.0.0.1:32145/',
  requestingOrigin: 'http://127.0.0.1:32145' }

it('allows an explicit copy from the focused owned application frame', () => {
  expect(allowClipboardWrite(request)).toBe(true)
  expect(allowClipboardWrite({ ...request, requestingOrigin: undefined })).toBe(true)
})

it.each(['clipboard-read', 'deprecated-sync-clipboard-read', 'geolocation', 'media', 'unknown'])('keeps %s denied', permission => {
  expect(allowClipboardWrite({ ...request, permission })).toBe(false)
})

it.each([
  { owned: false }, { focused: false }, { mainFrame: false }, { origin: undefined }, { requestingUrl: undefined },
  { currentUrl: 'https://example.test/' }, { requestingUrl: 'http://127.0.0.1:32146/' },
  { requestingUrl: 'http://someone@127.0.0.1:32145/' }, { requestingOrigin: 'https://example.test' },
  { requestingUrl: 'invalid-url' },
])('rejects unconfirmed or foreign clipboard callers: %j', changed => {
  expect(allowClipboardWrite({ ...request, ...changed })).toBe(false)
})
