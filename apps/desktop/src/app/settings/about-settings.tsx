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

export function AboutSettings({ subpage }: AboutSettingsProps = {}): ReactElement {
  useSettingDeepLink('about', page => subpage === undefined || page === subpage)

  if (subpage === 'legal') {
    return <LegalSettings />
  }

  return <AppUpdatesSettings />
}

function AppUpdatesSettings(): ReactElement {
  const version = useStore($desktopVersion)
  const connection = useStore($connection)
  const remote = connection?.mode === 'remote'

  // Refresh the running version when About opens or the active gateway changes.
  useEffect((): void => {
    void refreshDesktopVersion()

    if (remote) {
      void checkBackendUpdates()
    }
  }, [connection, remote])

  return (
    <SettingsContent>
      <VersionHero showVersion={false} version={version} />
      <div className="mx-auto mt-4 w-full max-w-2xl">
        <div className="grid gap-3" id={settingElementId(SETTING_IDS.about.updates)}>
          <UpdateStatusCard target="client" variant="about" />
          {/* Client and remote backend updates are independent. Only the client
              card carries the product/website row. */}
          {remote && <UpdateStatusCard showReleaseNotes={false} target="backend" variant="about" />}
        </div>
      </div>
    </SettingsContent>
  )
}
