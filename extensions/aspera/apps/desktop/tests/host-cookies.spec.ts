/** Cookie routing leaves stored sessions intact while bounding each owned Host request. */
import { createHash } from 'node:crypto'
import { createServer, request } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { fromAny } from '@total-typescript/shoehorn'
import type { Session, OnBeforeSendHeadersListenerDetails, BeforeSendResponse } from 'electron'
import { hostCookieHeader, installHostCookieRouting } from '../src/host-cookies.ts'

const origin = 'http://127.0.0.1:12345'
const cookie = 'dsh-auth-' + createHash('sha256').update('127.0.0.1:12345').digest('base64url') + '=signed-session'
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('retains the current signed cookie and unrelated values without forwarding other authorities', () => {
  const header = 'unrelated=a=b; dsh-auth-old=signed-old; ' + cookie + '; dsh-auth-other=signed-other'
  expect(hostCookieHeader(origin + '/api/read', origin, header)).toBe('unrelated=a=b; ' + cookie)
  expect(hostCookieHeader(origin.replace('http:', 'ws:') + '/stream', origin, header)).toBe('unrelated=a=b; ' + cookie)
  expect(hostCookieHeader('http://127.0.0.1:12346/api/read', origin, header)).toBe(header)
  expect(hostCookieHeader('https://example.test/api/read', origin, header)).toBe(header)
  expect(hostCookieHeader(origin, origin, 'dsh-auth-old=old')).toBe('')
})

it('installs on the owned HTTP and WebSocket origin and removes its listener on disposal', () => {
  type Listener = (details: OnBeforeSendHeadersListenerDetails, callback: (response: BeforeSendResponse) => void) => void
  const onBeforeSendHeaders = vi.fn<(filter: { urls: string[] } | Listener | null, listener?: Listener) => void>()
  const session = fromAny<Pick<Session, 'webRequest'>, object>({ webRequest: { onBeforeSendHeaders } })
  const dispose = installHostCookieRouting(session, origin)
  expect(onBeforeSendHeaders.mock.calls[0]?.[0]).toEqual({ urls: [origin + '/*', 'ws://127.0.0.1:12345/*'] })
  const listener = onBeforeSendHeaders.mock.calls[0]?.[1]
  if (listener === undefined || listener === null) throw new Error('Cookie listener was not installed')
  const callback = vi.fn()
  listener(fromAny({ url: origin + '/api/read', requestHeaders: { Cookie: 'dsh-auth-old=old; other=keep', Accept: 'application/json' } }), callback)
  expect(callback).toHaveBeenCalledWith({ requestHeaders: { Cookie: 'other=keep', Accept: 'application/json' } })
  dispose()
  expect(onBeforeSendHeaders).toHaveBeenLastCalledWith(null)
  expect(() => installHostCookieRouting(session, 'https://example.test')).toThrow('owned loopback')
})

it('reproduces native HTTP 431 with accumulated cookies and sends only the current authentication', async () => {
  const server = createServer({ maxHeaderSize: 16384 }, (req, res) => { res.writeHead(req.headers.cookie === cookie ? 200 : 401); res.end() })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  cleanup.push(() => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()) }))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP fixture did not bind')
  const url = 'http://127.0.0.1:' + address.port
  const accumulated = Array.from({ length: 80 }, (_, index) => 'dsh-auth-old-' + index + '=' + 'x'.repeat(220)).concat(cookie).join('; ')
  const read = (value: string) => new Promise<number>((resolve, reject) => {
    const req = request(url, { headers: { cookie: value } }, res => { res.resume(); res.once('end', () => { resolve(res.statusCode!) }) })
    req.once('error', reject); req.end()
  })
  expect(await read(accumulated)).toBe(431)
  expect(await read(hostCookieHeader(origin, origin, accumulated))).toBe(200)
  expect(await read(hostCookieHeader(origin, origin, 'unrelated=value'))).toBe(401)
})
