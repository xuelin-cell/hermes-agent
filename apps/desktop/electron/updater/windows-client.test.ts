import { afterEach, describe, expect, it, vi } from 'vitest'

const { client } = vi.hoisted(() => ({
  client: {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    autoRunAppAfterInstall: false,
    channel: '',
    allowPrerelease: false,
    allowDowngrade: true,
    on: vi.fn(),
    removeListener: vi.fn(),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn(async () => null),
    downloadUpdate: vi.fn(async () => []),
    quitAndInstall: vi.fn()
  }
}))

vi.mock('electron-updater', () => ({
  default: {
    NsisUpdater: class {
      constructor() {
        return client
      }
    }
  }
}))

import { createWindowsStrategy } from './windows-client'

afterEach((): void => {
  vi.clearAllMocks()
})

function deps(feedBaseUrl = '', light = false, channel = 'stable'): Parameters<typeof createWindowsStrategy>[0] {
  return {
    channel,
    light,
    feedBaseUrl,
    appVersion: '1.0.0',
    log: vi.fn(),
    emitProgress: vi.fn(),
    beforeInstall: vi.fn(),
    onInstallFailure: vi.fn()
  }
}

describe('Windows client wiring', () => {
  it('keeps the baked feed by default and forbids implicit installs or downgrades', async () => {
    const strategy = createWindowsStrategy(deps())

    expect(client.setFeedURL).not.toHaveBeenCalled()
    await expect(strategy.check()).rejects.toThrow('not active')
    expect(client.autoDownload).toBe(false)
    expect(client.autoInstallOnAppQuit).toBe(false)
    expect(client.autoRunAppAfterInstall).toBe(true)
    expect(client.allowDowngrade).toBe(false)
    expect(client.channel).toBe('stable')
    expect(client.allowPrerelease).toBe(false)
  })

  it('lets a runtime override replace the origin with the published feed dir', () => {
    createWindowsStrategy(deps('https://updates.example/'))

    expect(client.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'https://updates.example/releases/win32/stable/',
      channel: 'stable'
    })
    expect(() => createWindowsStrategy(deps('http://untrusted.example'))).toThrow('HTTPS')
  })

  it('reads the tree the packager publishes, including the light canary layout', () => {
    // electron-builder normalizes 'latest' and 'light' onto the stable tree, so
    // the client must not interpolate the install channel verbatim.
    createWindowsStrategy(deps('https://updates.example', false, 'latest'))
    expect(client.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://updates.example/releases/win32/stable/',
      channel: 'stable'
    })

    createWindowsStrategy(deps('https://updates.example', true, 'light-canary'))
    expect(client.setFeedURL).toHaveBeenLastCalledWith({
      provider: 'generic',
      url: 'https://updates.example/releases/win32/light/canary/',
      channel: 'canary'
    })
    expect(client.allowPrerelease).toBe(true)
  })
})
