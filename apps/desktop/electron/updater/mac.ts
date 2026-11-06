import type { AppUpdater } from 'electron-updater'

import { DownloadCancellation } from './download-cancellation'
import { applyPackagedHandoff } from './packaged-handoff'
import type { ReleaseNotesByLocale } from './release-notes'

import type { UpdaterApplyResultWire, UpdaterPrepareResult, UpdaterStatusWire, UpdaterStrategy } from './index'

export interface MacStrategyDeps {
  updater: Pick<AppUpdater, 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on' | 'removeListener'>
  channel: string
  expectedVersion?: string
  verifyDownload?: (files: string[]) => Promise<void>
  appVersion: string
  /** Squirrel verifies the signed app before any backend is stopped. */
  prepareInstall: () => Promise<void>
  beforeInstall: () => Promise<void>
  onInstallFailure: () => Promise<void>
  emitProgress: (payload: { stage: string; message: string; percent: number | null }) => void
  /** Authored notes for the offered version. A failure is never a failed check. */
  releaseNotes?: (version: string) => Promise<ReleaseNotesByLocale | null>
}

export class MacStrategy implements UpdaterStrategy {
  readonly mechanism = 'electron-updater' as const
  private applying = false
  private preparedVersion: string | null = null
  private preparing = false
  /** Live only while apply() is transferring bytes. */
  private cancellation: DownloadCancellation | null = null

  constructor(private readonly deps: MacStrategyDeps) {}

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
      throw new Error('The macOS updater is not active for this app.')
    }

    if (this.deps.expectedVersion && result.updateInfo.version !== this.deps.expectedVersion) {
      throw new Error('Native macOS feed does not match the pinned channel version')
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
   * Fetch and verify the Squirrel payload without installing. Squirrel's own
   * signature acceptance (prepareInstall) stays in apply(), right before the
   * swap; a download that keeps failing its channel digest never becomes a
   * "ready" prompt. Silent by design — no progress reaches the renderer.
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

      const files = await this.deps.updater.downloadUpdate()
      await this.deps.verifyDownload?.(files)
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

          const files = await this.downloadVerified(cancellation)

          if (files === null) {
            return { ok: false, cancelled: true, mechanism: this.mechanism }
          }

          this.deps.emitProgress({ stage: 'prepare', message: 'Verifying the signed macOS update.', percent: null })
          await this.deps.prepareInstall()
          await stop()
          this.deps.emitProgress({
            stage: 'restart',
            message: 'Restarting Hermes to install the update.',
            percent: 100
          })
          this.deps.updater.quitAndInstall()

          return { ok: true, bundled: true, handedOff: true, mechanism: this.mechanism }
        }
      )
    } finally {
      this.cancellation = null
      this.deps.updater.removeListener('download-progress', progress)
      this.applying = false
    }
  }

  /** `null` means the user aborted the transfer before it settled. */
  private async downloadVerified(cancellation: DownloadCancellation): Promise<string[] | null> {
    let files: string[]

    try {
      files = await this.deps.updater.downloadUpdate(cancellation.token)
    } catch (error) {
      // A cancelled transfer is a user decision, not a failed update. Nothing
      // has been torn down yet, so the app simply stays as-is.
      if (cancellation.cancelled) {
        return null
      }

      throw error
    }

    // The transfer is done: the token no longer governs this run, so a later
    // cancel reports "nothing to abort" instead of pretending it stopped the
    // verification and Squirrel install that follow.
    if (this.cancellation === cancellation) {
      this.cancellation = null
    }

    await this.deps.verifyDownload?.(files)

    return files
  }

  cancel(): boolean {
    return this.cancellation?.cancel() ?? false
  }
}

export interface NativeMacUpdater {
  once(event: 'update-downloaded', listener: () => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  removeListener(event: 'update-downloaded', listener: () => void): unknown
  removeListener(event: 'error', listener: (error: Error) => void): unknown
  checkForUpdates(): void
}

/** Download completion alone does not mean Squirrel accepted the signature. */
export function prepareMacInstall(native: NativeMacUpdater, timeoutMs: number = 120_000): Promise<void> {
  return new Promise<void>((resolve: () => void, reject: (error: Error) => void): void => {
    const cleanup = (): void => {
      clearTimeout(timer)
      native.removeListener('error', failed)
      native.removeListener('update-downloaded', ready)
    }

    const failed = (error: Error): void => {
      cleanup()
      reject(error)
    }

    const ready = (): void => {
      cleanup()
      resolve()
    }

    const timer = setTimeout((): void => failed(new Error('macOS update verification timed out.')), timeoutMs)
    native.once('error', failed)
    native.once('update-downloaded', ready)

    try {
      native.checkForUpdates()
    } catch (error) {
      failed(error as Error)
    }
  })
}
