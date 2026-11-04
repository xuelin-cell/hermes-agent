// updater/windows-client.ts — construct the NSIS electron-updater strategy.

import electronUpdater from 'electron-updater'

import feedContract from '../../update-feed.cjs'

import { channelPublicBase } from './channel-protocol'
import { fetchReleaseNotes, readBakedFeedUrl, resolveReleaseNotesUrl } from './release-notes'
import type { ReleaseNotesByLocale } from './release-notes'
import { WindowsStrategy, type WindowsStrategyDeps } from './windows'

export interface WindowsClientDeps extends Omit<WindowsStrategyDeps, 'updater'> {
  light: boolean
  /** Runtime override from config.yaml; empty keeps the baked app-update.yml. */
  feedBaseUrl: string
  /** The baked generic descriptor electron-updater reads; null in development. */
  appUpdatePath?: string | null
  log: (message: string) => void
}

export function createWindowsStrategy(deps: WindowsClientDeps): WindowsStrategy {
  // The feed tree is keyed on the release channel the packager publishes to,
  // not the install identity: electron-builder normalizes 'latest' and the
  // light variants onto the stable/canary trees. Reading a directory the
  // packager never writes would strand every install on a stale feed.
  const feedChannel = deps.channel === 'canary' || deps.channel === 'light-canary' ? 'canary' : 'stable'
  const feed = feedContract.win32Feed(feedChannel, deps.light)
  const updater = new electronUpdater.NsisUpdater()

  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.autoRunAppAfterInstall = true
  updater.channel = feed.channel
  updater.allowPrerelease = feed.allowPrerelease
  // Setting channel enables downgrades in electron-updater. This app never does.
  updater.allowDowngrade = false
  // electron-updater's own transcript is the only permanent record of the
  // differential verdict ("Differential download: <url>", "File … has N changed
  // blocks", "Full: X, To download: Y (Z%)") and of the fallback reason
  // ("Cannot download differentially, fallback to full download"). Route it
  // into the desktop log so a past update can be judged after the fact.
  // AppUpdater re-logs every 'error' event through this logger (with stack),
  // so a separate 'error' listener would only duplicate each failure.
  // `debug` stays unwired on purpose: DifferentialDownloader guards its whole
  // operation-plan JSON dump on `logger.debug != null`.
  updater.logger = {
    info: (message: string): void => deps.log(`Windows updater: ${message}`),
    warn: (message: string): void => deps.log(`Windows updater: ${message}`),
    error: (message: string): void => deps.log(`Windows updater: ${message}`)
  }

  if (deps.feedBaseUrl) {
    // config.yaml wins over the origin baked into app-update.yml, so a mirror
    // can be swapped without rebuilding the package.
    const base = channelPublicBase(deps.feedBaseUrl)
    updater.setFeedURL({ provider: 'generic', url: `${base}/${feed.directory}/`, channel: feed.channel })
  }

  return new WindowsStrategy({
    ...deps,
    updater,
    releaseNotes: releaseNotesReader(deps, feed.directory)
  })
}

/** Authored copy beside the same feed the updater reads; unset when this install
 *  has no feed (an external or Store build) so the overlay keeps its fallback. */
function releaseNotesReader(
  deps: WindowsClientDeps,
  feedDirectory: string
): ((version: string) => Promise<ReleaseNotesByLocale | null>) | undefined {
  const url: string | null = resolveReleaseNotesUrl({
    configuredBase: deps.feedBaseUrl,
    feedDirectory,
    descriptorUrl: readBakedFeedUrl(deps.appUpdatePath)
  })

  return url ? (version: string) => fetchReleaseNotes(url, version, deps.log) : undefined
}
