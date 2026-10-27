import { afterEach, expect, it, vi } from 'vitest'

import { storeBrowserLogin } from '../../../shared/src/browser-maas-auth.js'
import { browserShares } from './browser-shares'

const original = window.hermesDesktop

afterEach(() => {
  localStorage.clear()
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: original })
  delete document.documentElement.dataset.hermesBrowser
  vi.unstubAllGlobals()
})

function transport() {
  storeBrowserLogin('/hermes/', { maas_auth: { token: 'login-token', expiresAt: Date.now() + 60000, loginId: 'login' } })
  const requests: Array<{ path: string; body: Record<string, unknown> }> = []
  const channels: Array<{ onmessage?: (event: { data: string }) => void; postMessage: (key: string) => void }> = []
  vi.stubGlobal('BroadcastChannel', class {
    onmessage?: (event: { data: string }) => void
    constructor() { channels.push(this) }
    postMessage(key: string) { for (const channel of channels) if (channel !== this) channel.onmessage?.({ data: key }) }
  })
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
    expect(new Headers(options.headers).get('Authorization')).toBe('Bearer login-token')
    expect(options.credentials).toBe('same-origin')
    if (new URL(url).pathname.endsWith('/revision')) return new Response('{"revision":1}', { status: 200 })
    requests.push({ path: new URL(url).pathname, body: JSON.parse(options.body as string) })
    return new Response(JSON.stringify({ key: 'artifact', shareId: 'share-id' }), { status: 200 })
  }))
  return requests
}

it('preserves conversation contracts over authenticated entry transport without contacting an instance directly', async () => {
  const requests = transport()
  const { conversationShare } = browserShares('/hermes/')
  const owner = { connectionId: 'local', profile: 'default' }
  const request = { sessionId: 'chat', scope: 'response' as const, responseRowId: 12, includeProcess: false }
  await conversationShare.prepare(owner, request)
  await conversationShare.image('ticket', 'picture.png')
  await conversationShare.publish('ticket', '<html>snapshot</html>')
  await conversationShare.cancel('ticket')
  await conversationShare.list(owner, 'chat')
  await conversationShare.revoke('record-key')
  expect(requests.map(r => r.path)).toEqual(['prepare', 'image', 'publish', 'cancel', 'list', 'revoke'].map(op => `/hermes/__entry/conversation-shares/${op}`))
  expect(requests[0].body).toEqual({ owner, request })
  expect(requests[2].body).toEqual({ ticket: 'ticket', html: '<html>snapshot</html>' })
  expect(requests[4].body).toEqual({ owner, sessionId: 'chat' })
  await browserShares('/hermes/').prepareCloudShareTurn('runtime')
  expect(requests.at(-1)).toEqual({ path: '/hermes/__entry/artifact-shares/grant', body: { sessionId: 'runtime' } })
  localStorage.clear()
  const count = requests.length
  expect(await browserShares('/hermes/').prepareCloudShareTurn('runtime')).toBeNull()
  expect(requests).toHaveLength(count)
})

it('notifies artifact consumers across tabs while preserving source hashes and expected share IDs', async () => {
  const requests = transport()
  const first = browserShares('/hermes/').artifactShare
  const second = browserShares('/hermes/').artifactShare
  const listener = vi.fn()
  const unsubscribe = second.onChanged(listener)
  const source = { sessionId: 'chat', path: '/workspace/report.html', hash: 'source-hash' }
  await first.eligibility(source)
  await first.publish({ key: 'artifact', source, html: '<html>report</html>', title: 'report', ttlDays: 3 })
  expect(listener).toHaveBeenCalledWith('artifact')
  await first.setExpiration('artifact', 'share-id', 7)
  await first.revoke('artifact', 'share-id')
  expect(requests[1].body.source).toEqual(source)
  expect(requests[2].body).toEqual({ key: 'artifact', shareId: 'share-id', ttlDays: 7 })
  expect(requests[3].body).toEqual({ key: 'artifact', shareId: 'share-id' })
  unsubscribe()
  listener.mockClear()
  await first.markUploaded('chat')
  expect(listener).not.toHaveBeenCalled()
})
