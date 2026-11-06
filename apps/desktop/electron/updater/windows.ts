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
  updater: Pick<AppUpdater, 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on' | 'removeListener'>
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
  /** Live only while apply() is transferring bytes. */
  private cancellation: DownloadCancellation | null = null

  constructor(private readonly deps: WindowsStrategyDeps) {}

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

    try {
      const status = await this.checkRelease()

      if (!status.updateAvailable) {
        return { ready: false, version: null }
      }

      await this.deps.updater.downloadUpdate()
      this.preparedVersion = status.latestTag?.replace(/^v/, '') ?? null

      return { ready: true, version: this.preparedVersion }
    } finally {
      this.preparing = false
    }
  }

  async apply(): Promise<UpdaterApplyResultWire> {
    if (this.applying) {
      throw new Error('An update is already in progress.')
    }

    this.applying = true

    const cancellation = new DownloadCancellation()

    this.cancellation = cancellation

    const progress = ({ percent }: { percent: number }): void => {
      this.deps.emitProgress({ stage: 'fetch', message: 'Downloading the Hermes update.', percent })
    }

    this.deps.updater.on('download-progress', progress)

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

          // The transfer is done; the token no longer governs this run, so a
          // later cancel reports "nothing to abort" instead of pretending it
          // stopped the NSIS install.
          if (this.cancellation === cancellation) {
            this.cancellation = null
          }

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
      this.cancellation = null
      this.deps.updater.removeListener('download-progress', progress)
      this.applying = false
    }
  }

  cancel(): boolean {
    return this.cancellation?.cancel() ?? false
  }
}
