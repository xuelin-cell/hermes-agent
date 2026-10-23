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

import { applyPackagedHandoff } from './packaged-handoff'

import type { UpdaterApplyResultWire, UpdaterStatusWire, UpdaterStrategy } from './index'

export interface WindowsStrategyDeps {
  updater: Pick<AppUpdater, 'checkForUpdates' | 'downloadUpdate' | 'quitAndInstall' | 'on' | 'removeListener'>
  channel: string
  appVersion: string
  beforeInstall: () => Promise<void>
  onInstallFailure: () => Promise<void>
  emitProgress: (payload: { stage: string; message: string; percent: number | null }) => void
}

export class WindowsStrategy implements UpdaterStrategy {
  readonly mechanism = 'electron-updater' as const
  private applying = false

  constructor(private readonly deps: WindowsStrategyDeps) {}

  async check(): Promise<UpdaterStatusWire> {
    if (this.applying) {
      throw new Error('An update is already in progress.')
    }

    return this.checkRelease()
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

  async apply(): Promise<UpdaterApplyResultWire> {
    if (this.applying) {
      throw new Error('An update is already in progress.')
    }

    this.applying = true

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

          await this.deps.updater.downloadUpdate()
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
      this.deps.updater.removeListener('download-progress', progress)
      this.applying = false
    }
  }
}
