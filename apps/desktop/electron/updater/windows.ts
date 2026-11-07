// updater/windows.ts — the self-managed NSIS update arm.
//
// An NSIS package has no OS-level update owner: no App Installer descriptor,
// no Store. When its stamp declares 'electron-updater' this strategy owns the
// whole loop — read the generic feed, download the blockmap diff, stop the
// backend, then let the NSIS installer swap the tree silently.
//
// The App Installer arm lives in app-updater.ts + app-installer.ts; macOS
// lives in mac.ts. This arm shares their handoff contract.

import type { AppUpdater } from 'electron-updater'

import { DownloadCancellation } from './download-cancellation'
import { applyPackagedHandoff } from './packaged-handoff'
import type { ReleaseNotesByLocale } from './release-notes'

import type { UpdaterApplyResultWire, UpdaterPrepareResult, UpdaterStatusWire, UpdaterStrategy } from './index'

export interface WindowsStrategyDeps {
  updater: Pick<AppUpdater, 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on'>
  channel: string
  appVersion: string
  beforeInstall: () => Promise<void>
  onInstallFailure: () => Promise<void>
  emitProgress: (payload: { stage: string; message: string; percent: number | null }) => void
  /** Authored notes for the offered version. A failure is never a failed check. */
  releaseNotes?: (version: string) => Promise<ReleaseNotesByLocale | null>
}

export class WindowsStrategy implements UpdaterStrategy {
  readonly mechanism = 'electron-updater' as const
  private applying = false
  private preparedVersion: string | null = null
  private preparing = false
  /** The transfer this strategy owns. `prepare()` starts it and an `apply()`
   *  that lands mid-prefetch joins the same one, because electron-updater keeps
   *  a single downloadPromise: a second `downloadUpdate` answers "Downloading
   *  update (already in progress)" and ignores the token it was given. A token
   *  minted per call therefore governed nothing, and "Cancel" only closed the
   *  dialog while the bytes kept coming. */
  private transfer: DownloadCancellation | null = null

  constructor(private readonly deps: WindowsStrategyDeps) {
    // electron-updater only builds its cancellation-aware progress stream when
    // a `download-progress` listener exists as the download starts, so this one
    // lives for the strategy's lifetime — the silent ambient prefetch must be
    // abortable too. Forwarding is gated on apply(), so a prefetch still never
    // reports progress to the renderer.
    this.deps.updater.on('download-progress', ({ percent }: { percent: number }): void => {
      if (this.applying) {
        this.deps.emitProgress({ stage: 'fetch', message: 'Downloading the Hermes update.', percent })
      }
    })
  }

  private startTransfer(): DownloadCancellation {
    this.transfer ??= new DownloadCancellation()

    return this.transfer
  }

  private finishTransfer(cancellation: DownloadCancellation): void {
    if (this.transfer === cancellation) {
      this.transfer = null
    }
  }

  async check(): Promise<UpdaterStatusWire> {
    if (this.applying) {
      throw new Error('An update is already in progress.')
    }

    const status: UpdaterStatusWire = await this.checkRelease()

    if (!status.updateAvailable || !status.latestTag || !this.deps.releaseNotes) {
      return status
    }

    const notes: ReleaseNotesByLocale | null = await this.deps
      .releaseNotes(status.latestTag.replace(/^v/, ''))
      .catch((): null => null)

    return notes ? { ...status, releaseNotes: notes } : status
  }

  private async checkRelease(): Promise<UpdaterStatusWire> {
    const result = await this.deps.updater.checkForUpdates()

    if (!result) {
      throw new Error('The Windows updater is not active for this app.')
    }

    return {
      supported: true,
      mechanism: this.mechanism,
      currentVersion: this.deps.appVersion,
      channel: this.deps.channel,
      latestTag: `v${result.updateInfo.version}`,
      updateAvailable: result.isUpdateAvailable,
      fetchedAt: Date.now()
    }
  }

  /**
   * Fetch the offered NSIS payload without touching the backend or installing.
   * Silent by design: the ambient "new version ready" prompt must not interrupt
   * whatever the user is doing, so no download-progress reaches the renderer.
   */
  async prepare(): Promise<UpdaterPrepareResult> {
    if (this.applying) {
      throw new Error('An update is already in progress.')
    }

    if (this.preparedVersion) {
      return { ready: true, version: this.preparedVersion }
    }

    if (this.preparing) {
      return { ready: false, version: null }
    }

    this.preparing = true

    // The prefetch owns the token: whoever downloads these bytes first also has
    // to be the one that can stop them.
    const cancellation: DownloadCancellation = this.startTransfer()

    try {
      const status = await this.checkRelease()

      if (!status.updateAvailable) {
        return { ready: false, version: null }
      }

      await this.deps.updater.downloadUpdate(cancellation.token)

      // A cancel that landed as the transfer settled is still not a "new
      // version ready" prompt: the user asked for it to stop.
      if (cancellation.cancelled) {
        return { ready: false, version: null }
      }

      this.preparedVersion = status.latestTag?.replace(/^v/, '') ?? null

      return { ready: true, version: this.preparedVersion }
    } catch (error) {
      // An aborted prefetch is the user's decision, not a download failure:
      // report "nothing ready" so no failure dialog is raised for a cancel.
      if (cancellation.cancelled) {
        return { ready: false, version: null }
      }

      throw error
    } finally {
      this.finishTransfer(cancellation)
      this.preparing = false
    }
  }

  async apply(): Promise<UpdaterApplyResultWire> {
    if (this.applying) {
      throw new Error('An update is already in progress.')
    }

    this.applying = true

    // Join the live transfer rather than minting a second token: when apply()
    // arrives mid-prefetch electron-updater hands us that promise, and only the
    // token that started it can abort it.
    const cancellation: DownloadCancellation = this.startTransfer()

    try {
      return await applyPackagedHandoff(
        {
          teardown: this.deps.beforeInstall,
          restore: this.deps.onInstallFailure,
          emitProgress: this.deps.emitProgress
        },
        async (stop: () => Promise<void>): Promise<UpdaterApplyResultWire> => {
          const status = await this.checkRelease()

          if (!status.updateAvailable) {
            return { ok: true, mechanism: this.mechanism }
          }

          try {
            await this.deps.updater.downloadUpdate(cancellation.token)
          } catch (error) {
            // A cancelled transfer is a user decision, not a failed update.
            // Nothing has been torn down yet, so the app simply stays as-is.
            if (cancellation.cancelled) {
              return { ok: false, cancelled: true, mechanism: this.mechanism }
            }

            throw error
          }

          // A cancel that lands while the last chunks are written cannot abort
          // the transfer, but it must still not install: the user asked for it
          // to stop.
          if (cancellation.cancelled) {
            return { ok: false, cancelled: true, mechanism: this.mechanism }
          }

          // The transfer is done; the token no longer governs this run, so a
          // later cancel reports "nothing to abort" instead of pretending it
          // stopped the NSIS install.
          this.finishTransfer(cancellation)

          await stop()
          this.deps.emitProgress({
            stage: 'restart',
            message: 'Restarting Hermes to install the update.',
            percent: 100
          })
          // Silent: this is a per-machine install (Program Files), so an
          // unattended upgrade can never answer the NSIS wizard. The second
          // flag relaunches into the new build after the swap.
          this.deps.updater.quitAndInstall(true, true)

          return { ok: true, bundled: true, handedOff: true, mechanism: this.mechanism }
        }
      )
    } finally {
      this.finishTransfer(cancellation)
      this.applying = false
    }
  }

  /** Only a transfer this strategy started is abortable. */
  cancel(): boolean {
    return this.transfer?.cancel() ?? false
  }
}
