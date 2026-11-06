import { useStore } from '@nanostores/react'
import { type ReactElement, useEffect } from 'react'

import { UpdateStatusCard, VersionHero } from '@/components/update-status'
import { useI18n } from '@/i18n'
import { Download } from '@/lib/icons'
import { $connection } from '@/store/session'
import { $desktopVersion, checkBackendUpdates, refreshDesktopVersion } from '@/store/updates'

import { LegalSettings } from './legal-settings'
import { SectionHeading, SettingsContent } from './primitives'
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
  const { t } = useI18n()
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
    <SettingsContent>
      <VersionHero showVersion={false} version={version} />
      <div className="mx-auto mt-4 w-full max-w-2xl">
        <SectionHeading icon={Download} title={t.settings.subpages.appUpdates} />
        <div className="grid gap-3" id={settingElementId(SETTING_IDS.about.updates)}>
          <UpdateStatusCard target="client" variant="about" />
          {/* Client and remote backend updates are independent. Only the client
              card carries the product/website row. */}
          {remote && <UpdateStatusCard showReleaseNotes={false} target="backend" variant="about" />}
        </div>
        <div aria-hidden className="my-7 border-t border-border/50" />
        <LegalSettings />
      </div>
    </SettingsContent>
  )
}
