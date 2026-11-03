import { afterEach, expect, it, vi } from 'vitest'

import { storeBrowserLogin } from '../../../shared/src/browser-maas-auth.js'
import { browserAccount } from './browser-account'

const login = (owner: string) => storeBrowserLogin('/hermes', { maas_auth: { token: 'login-'+owner, loginId: owner, expiresAt: Date.now()+60000 } })
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); localStorage.clear() })

it('fixed notification routes keep per-tab cursors and discard account-switched events', async () => {
  vi.useFakeTimers()
  login('alice')
  let stale: ((value: Response) => void) | undefined
  let polling = 0
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toContain('/hermes/__entry/account/notify-')
    expect(init.credentials).toBe('same-origin')
    if (url.endsWith('notify-poll')) {
      polling++
      if (polling === 1) return json({ cursor: 1, events: [{ kind: 'announcement', announcement: { id: 'one' } }] })
      expect(JSON.parse(init.body as string).cursor).toBe(1)
      return new Promise<Response>(resolve => { stale=resolve })
    }
    return json({ state: 'online' })
  })
  vi.stubGlobal('fetch', fetcher)
  const bridge=browserAccount('/hermes')
  const listener=vi.fn()
  bridge.ntfy.onEvent(listener)
  await bridge.ntfy.start()
  await vi.advanceTimersByTimeAsync(0)
  expect(listener).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(3000)
  login('bob')
  stale!(json({ cursor: 2, events: [{ kind: 'announcement', announcement: { id: 'stale' } }] }))
  await vi.advanceTimersByTimeAsync(0)
  expect(listener).toHaveBeenCalledTimes(1)
  await bridge.ntfy.stop()
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('notify-stop'))).toHaveLength(0)
})

it('speech sends bounded PCM to fixed routes and cannot reuse a session after account switching', async () => {
  login('alice')
  vi.stubGlobal('isSecureContext', true)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn() } })
  const fetcher=vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toContain('/__entry/account/asr-')
    expect(JSON.stringify(init)).not.toContain('apiKey')
    if (url.endsWith('asr-start')) return json('speech-id')
    if (url.endsWith('asr-audio')) expect(JSON.parse(init.body as string).pcm).toBe('AQACAA==')
    return json({ ok: true })
  })
  vi.stubGlobal('fetch',fetcher)
  const bridge=browserAccount('/hermes')
  const id=await bridge.uniworkAsr.start('zh')
  await bridge.uniworkAsr.audio(id,new Uint8Array([1,0,2,0]))
  await expect(bridge.uniworkAsr.audio(id,new Uint8Array(32770))).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(2)
  login('bob')
  await expect(bridge.uniworkAsr.poll(id)).rejects.toThrow()
  expect(fetcher).toHaveBeenCalledTimes(2)
})
