import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { installClientEvents, noteLinkState, reloadFor, resetClientEventsForTests } from './client-events-mt'

const originalLocation = window.location
let sent: { body: Record<string, unknown>; url: string }[]
let reloaded: number

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  sent = []
  reloaded = 0
  sessionStorage.clear()
  resetClientEventsForTests()
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { reload: () => void (reloaded += 1), replace: () => undefined }
  })
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: (url: string, data: Blob) => {
      void data.text().then(text => sent.push({ body: JSON.parse(text) as Record<string, unknown>, url }))

      return true
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetClientEventsForTests()
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation })
})

describe('client events', () => {
  it('says why before the page reloads itself, and the next page reports the reason with its start-up', async () => {
    reloadFor('developer-mode') // not installed (the desktop app): reloads, tells nobody
    await flush()
    expect([reloaded, sent]).toEqual([1, []])

    installClientEvents('/agents/api/')
    reloadFor('sid-changed', { from: 'personal/abc123', to: 'enterprise/def456' })
    await flush()
    expect(reloaded).toBe(2)
    expect(sent).toHaveLength(1)
    expect(sent[0].url).toBe('/agents/api/__entry/client-event')
    expect(sent[0].body).toMatchObject({ from: 'personal/abc123', reason: 'sid-changed', to: 'enterprise/def456', type: 'reload' })

    // The page that comes back: its start-up report names why the last one went away.
    resetClientEventsForTests()
    installClientEvents('/agents/api/')
    noteLinkState('open')
    noteLinkState('open')
    await flush()
    expect(sent.filter(event => event.body.type === 'boot')).toEqual([
      expect.objectContaining({ body: expect.objectContaining({ outcome: 'open', prev: 'sid-changed' }) })
    ])

    // A reload nobody recorded is the user's own.
    resetClientEventsForTests()
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { domContentLoadedEventEnd: 420, type: 'reload' } as unknown as PerformanceEntry
    ])
    installClientEvents('/agents/api/')
    noteLinkState('open')
    await flush()
    expect(sent.at(-1)?.body).toMatchObject({ prev: 'user-reload', type: 'boot' })
  })

  it('reports a dropped instance link only when it lasts, then how long it stayed down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] })
    installClientEvents('/agents/api/')
    noteLinkState('open')

    noteLinkState('closed') // switching experts swaps the link for a moment
    vi.advanceTimersByTime(1_000)
    noteLinkState('open')
    vi.advanceTimersByTime(5_000)

    noteLinkState('closed')
    noteLinkState('connecting')
    vi.advanceTimersByTime(10_000)
    noteLinkState('open')
    vi.useRealTimers()
    await flush()

    expect(sent.filter(event => event.body.type === 'link').map(event => event.body)).toEqual([
      expect.objectContaining({ state: 'closed' }),
      expect.objectContaining({ down_s: 10, state: 'restored' })
    ])
  })
})
