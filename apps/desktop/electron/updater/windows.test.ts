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
      on: emitter.on.bind(emitter) as WindowsStrategyDeps['updater']['on']
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

/** The strategy hands its own DownloadCancellation to downloadUpdate; the
 *  EventEmitter typing on electron-updater's token is wider than the listener
 *  contract the download path actually uses. */
function onCancelLatch(
  received: Parameters<WindowsStrategyDeps['updater']['downloadUpdate']>[0],
  abort: () => void
): void {
  ;(received as unknown as { addListener(listener: () => void): void } | undefined)?.addListener(abort)
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
    // The progress listener lives for the strategy's lifetime: electron-updater
    // only builds its cancellation-aware progress stream when one exists as the
    // download starts, and the prefetch download must be abortable too.
    expect(emitter.listenerCount('download-progress')).toBe(1)
  })

  it('prefetches the package without stopping the backend, and reuses it for apply', async () => {
    const { deps, strategy, events } = fixture()

    expect(await strategy.prepare()).toEqual({ ready: true, version: '1.1.0' })
    expect(events).toEqual(['check', 'download'])
    // A prefetch must never tear the backend down or show progress: the user is
    // still working while the bytes land.
    expect(deps.beforeInstall).not.toHaveBeenCalled()
    expect(deps.emitProgress).not.toHaveBeenCalled()

    events.length = 0
    expect(await strategy.prepare()).toEqual({ ready: true, version: '1.1.0' })
    expect(events).toEqual([])
  })

  it('reports not-ready without downloading when the feed has nothing newer', async () => {
    const { deps, strategy } = fixture()
    const info = { version: '1.0.0', files: [], releaseDate: '', path: '', sha512: '' }
    vi.mocked(deps.updater.checkForUpdates).mockResolvedValueOnce({
      isUpdateAvailable: false,
      updateInfo: info,
      versionInfo: info
    } as never)

    expect(await strategy.prepare()).toEqual({ ready: false, version: null })
    expect(deps.updater.downloadUpdate).not.toHaveBeenCalled()
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
    expect(emitter.listenerCount('download-progress')).toBe(1)
  })

  it('restores the backend if the installer handoff throws', async () => {
    const { deps, strategy, events } = fixture()
    vi.mocked(deps.updater.quitAndInstall).mockImplementation(() => {
      throw new Error('handoff failed')
    })

    await expect(strategy.apply()).rejects.toThrow('handoff failed')
    expect(events.slice(-2)).toEqual(['stop', 'restore'])
  })

  it('aborts an in-flight download on cancel and leaves the backend running', async () => {
    const { deps, strategy, events } = fixture()
    vi.mocked(deps.updater.downloadUpdate).mockImplementation(received => {
      const transfer = new Promise<string[]>((_resolve, reject) => {
        // electron-updater aborts the request from this listener, so the token
        // has to be live before cancel() is called.
        onCancelLatch(received, () => reject(new Error('cancelled')))
      })

      expect(strategy.cancel()).toBe(true)

      return transfer
    })

    const result = await strategy.apply()

    expect(result).toMatchObject({ ok: false, cancelled: true, mechanism: 'electron-updater' })
    expect(events).not.toContain('stop')
    expect(deps.updater.quitAndInstall).not.toHaveBeenCalled()
    // Once the transfer settled there is nothing left to abort.
    expect(strategy.cancel()).toBe(false)
  })

  // Regression: electron-updater keeps ONE downloadPromise, so an apply that
  // lands mid-prefetch receives that transfer ("Downloading update (already in
  // progress)") and ignores the token it was handed. Cancel used to flip that
  // inert token: the dialog closed, the bytes kept arriving, and the next
  // attempt failed with "An update is already in progress".
  it('aborts the transfer the prefetch started when apply is cancelled', async () => {
    const { deps, events, strategy } = fixture()

    let abort: () => void = (): void => {}
    let shared: Promise<string[]> | null = null

    vi.mocked(deps.updater.downloadUpdate).mockImplementation(received => {
      onCancelLatch(received, () => abort())
      shared ??= new Promise<string[]>((_resolve, reject) => {
        abort = (): void => reject(new Error('cancelled'))
      })

      return shared
    })

    const prefetch = strategy.prepare()
    await vi.waitFor(() => expect(deps.updater.downloadUpdate).toHaveBeenCalledOnce())

    const applying = strategy.apply()
    await vi.waitFor(() => expect(deps.updater.downloadUpdate).toHaveBeenCalledTimes(2))
    expect(strategy.cancel()).toBe(true)

    expect(await applying).toMatchObject({ ok: false, cancelled: true })
    // A cancelled prefetch reports "nothing ready" — never a download failure.
    expect(await prefetch).toEqual({ ready: false, version: null })
    expect(events).not.toContain('stop')
    expect(events).not.toContain('install')
    expect(deps.updater.quitAndInstall).not.toHaveBeenCalled()
    // Once the transfer settled there is nothing left to abort.
    expect(strategy.cancel()).toBe(false)
  })

  // A passive check can land mid-apply. That is not a download failure: the
  // prefetch reports "nothing ready" instead of surfacing the internal gate.
  it('reports nothing ready for a prefetch that lands mid-apply', async () => {
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

    expect(await strategy.prepare()).toEqual({ ready: false, version: null })
    expect(deps.updater.downloadUpdate).toHaveBeenCalledOnce()

    release()
    await applying
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
