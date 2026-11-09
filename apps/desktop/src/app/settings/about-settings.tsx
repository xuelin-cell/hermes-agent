import { useStore } from '@nanostores/react'
import { type ReactElement, useEffect } from 'react'

import { UpdateStatusCard, VersionHero } from '@/components/update-status'
import { $connection } from '@/store/session'
import { $desktopVersion, checkBackendUpdates, refreshDesktopVersion } from '@/store/updates'

import { LegalSettings } from './legal-settings'
import { SettingsContent } from './primitives'
import { SETTING_IDS, settingElementId } from './settings-manifest'
import { useSettingDeepLink } from './use-setting-deep-link'

interface AboutSettingsProps {
  subpage?: string
}

/**
 * Settings › About is ONE page, like the single-entry pages above it in the nav:
 * version + update state on top, the agreements and policies below. `subpage`
 * no longer swaps pages — `updates` / `legal` survive as in-page anchors, so an
 * old `?page=legal` link or a palette anchor scrolls to the terms section
 * instead of rendering a second page.
 */
export function AboutSettings({ subpage }: AboutSettingsProps = {}): ReactElement {
  const version = useStore($desktopVersion)
  const connection = useStore($connection)
  const remote = connection?.mode === 'remote'

  // Every About row now lives on this page, so a palette hit lands directly.
  useSettingDeepLink('about')

  // Refresh the running version when About opens or the active gateway changes.
  useEffect((): void => {
    void refreshDesktopVersion()

    if (remote) {
      void checkBackendUpdates()
    }
  }, [connection, remote])

  useEffect(() => {
    if (subpage !== 'legal') {
      return
    }

    const element = document.getElementById(settingElementId(SETTING_IDS.about.legal))

    if (!element) {
      return
    }

    element.scrollIntoView({ behavior: 'smooth', block: 'start' })
    element.classList.add('setting-field-highlight')

    const timeout = window.setTimeout(() => element.classList.remove('setting-field-highlight'), 1600)

    return () => window.clearTimeout(timeout)
  }, [subpage])

  return (
    // `flush` makes the pane a full-height column with no bottom pad, so the
    // terms strip can be its footer: pinned to the bottom edge while the pane
    // is taller than the content, and the last thing scrolled to when it isn't.
    <SettingsContent flush>
      {/* About has no brand header: the nav entry and the update card already
          name the app. VersionHero stays for the bundle banner it owns, and
          renders nothing when there is none. */}
      <VersionHero showBrandMark={false} showHeading={false} showVersion={false} version={version} />
      <div className="mx-auto w-full max-w-2xl pt-2">
        <div className="grid gap-3" id={settingElementId(SETTING_IDS.about.updates)}>
          <UpdateStatusCard target="client" variant="about" />
          {/* Client and remote backend updates are independent. Only the client
              card carries the product/website row. */}
          {remote && <UpdateStatusCard showReleaseNotes={false} target="backend" variant="about" />}
        </div>
      </div>
      <div className="mx-auto mt-auto w-full max-w-2xl pt-10 pb-6">
        <div aria-hidden className="mb-5 border-t border-border/50" />
        <LegalSettings />
      </div>
    </SettingsContent>
  )
}
