import { EventEmitter } from 'node:events'

import { describe, expect, it, vi } from 'vitest'

import { WindowsStrategy, type WindowsStrategyDeps } from './windows'

function fixture() {
  const events: string[] = []
  const emitter = new EventEmitter()
  const info = { version: '1.1.0', files: [], releaseDate: '', path: '', sha512: '' }

  const deps: WindowsStrategyDeps = {
    updater: {
      checkForUpdates: vi.fn(async () => {
        events.push('check')

        return { isUpdateAvailable: true, updateInfo: info, versionInfo: info }
      }),
      downloadUpdate: vi.fn(async () => {
        events.push('download')

        return []
      }),
      quitAndInstall: vi.fn(() => {
        events.push('install')
      }),
      on: emitter.on.bind(emitter) as WindowsStrategyDeps['updater']['on'],
      removeListener: emitter.removeListener.bind(emitter) as WindowsStrategyDeps['updater']['removeListener']
    },
    channel: 'stable',
    appVersion: '1.0.0',
    beforeInstall: vi.fn(async () => {
      events.push('stop')
    }),
    onInstallFailure: vi.fn(async () => {
      events.push('restore')
    }),
    emitProgress: vi.fn()
  }

  return { deps, events, emitter, strategy: new WindowsStrategy(deps) }
}

describe('Windows NSIS strategy', () => {
  it('checks, downloads, stops the backend, then installs silently and relaunches', async () => {
    const { deps, strategy, events, emitter } = fixture()
    vi.mocked(deps.updater.downloadUpdate).mockImplementation(async () => {
      events.push('download')
      emitter.emit('download-progress', { percent: 42 })

      return []
    })

    expect(await strategy.check()).toMatchObject({
      supported: true,
      mechanism: 'electron-updater',
      channel: 'stable',
      latestTag: 'v1.1.0',
      updateAvailable: true
    })
    events.length = 0

    expect(await strategy.apply()).toMatchObject({ ok: true, handedOff: true, mechanism: 'electron-updater' })
    expect(events).toEqual(['check', 'download', 'stop', 'install'])
    // Per-machine installs under Program Files cannot answer the NSIS wizard,
    // and the swap must come back up on its own.
    expect(deps.updater.quitAndInstall).toHaveBeenCalledWith(true, true)
    expect(deps.emitProgress).toHaveBeenCalledWith({ stage: 'fetch', message: expect.any(String), percent: 42 })
    expect(emitter.listenerCount('download-progress')).toBe(0)
  })

  // The notes are publisher copy, never a precondition: a feed object that is
  // missing, unreachable or empty must leave the update decision untouched.
  it('attaches authored notes and never fails the check over them', async () => {
    const { deps } = fixture()

    deps.releaseNotes = vi.fn(async () => ({ zh: [{ id: 'new', label: '新增', items: ['导出会话'] }] }))
    expect(await new WindowsStrategy(deps).check()).toMatchObject({
      updateAvailable: true,
      releaseNotes: { zh: [{ id: 'new', label: '新增', items: ['导出会话'] }] }
    })

    deps.releaseNotes = vi.fn(async () => {
      throw new Error('offline')
    })
    const failed = await new WindowsStrategy(deps).check()
    expect(failed).toMatchObject({ updateAvailable: true, latestTag: 'v1.1.0' })
    expect(failed).not.toHaveProperty('releaseNotes')
  })

  it('leaves the backend running when the provider reports no newer release', async () => {
    const { deps, strategy, events } = fixture()
    const info = { version: '1.0.0', files: [], releaseDate: '', path: '', sha512: '' }
    vi.mocked(deps.updater.checkForUpdates).mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: info,
      versionInfo: info
    })

    expect(await strategy.apply()).toEqual({ ok: true, mechanism: 'electron-updater' })
    expect(events).toEqual([])
    expect(deps.updater.downloadUpdate).not.toHaveBeenCalled()
    expect(deps.updater.quitAndInstall).not.toHaveBeenCalled()
  })

  it('keeps the backend alive when the delta download fails', async () => {
    const { deps, strategy, events, emitter } = fixture()
    vi.mocked(deps.updater.downloadUpdate).mockRejectedValueOnce(new Error('blockmap mismatch'))

    await expect(strategy.apply()).rejects.toThrow('blockmap mismatch')
    expect(events).not.toContain('stop')
    expect(events).not.toContain('install')
    expect(emitter.listenerCount('download-progress')).toBe(0)
  })

  it('restores the backend if the installer handoff throws', async () => {
    const { deps, strategy, events } = fixture()
    vi.mocked(deps.updater.quitAndInstall).mockImplementation(() => {
      throw new Error('handoff failed')
    })

    await expect(strategy.apply()).rejects.toThrow('handoff failed')
    expect(events.slice(-2)).toEqual(['stop', 'restore'])
  })

  it('rejects a second apply while one is in flight', async () => {
    const { deps, strategy } = fixture()
    let release!: () => void
    vi.mocked(deps.updater.downloadUpdate).mockImplementation(
      () =>
        new Promise(resolve => {
          release = () => resolve([])
        })
    )

    const applying = strategy.apply()
    await vi.waitFor(() => expect(deps.updater.downloadUpdate).toHaveBeenCalledOnce())
    await expect(strategy.apply()).rejects.toThrow('already in progress')
    await expect(strategy.check()).rejects.toThrow('already in progress')
    release()
    await applying
  })
})
