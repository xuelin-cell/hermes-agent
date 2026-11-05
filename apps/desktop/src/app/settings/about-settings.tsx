import { useStore } from '@nanostores/react'
import { type ReactElement, useEffect } from 'react'

import { Button } from '@/components/ui/button'
import { UpdateStatusCard, VersionHero } from '@/components/update-status'
import { useI18n } from '@/i18n'
import { RefreshCw } from '@/lib/icons'
import { $connection } from '@/store/session'
import { $updateCheckDialog, requestUpdateCheck } from '@/store/update-check'
import { $desktopVersion, checkBackendUpdates, refreshDesktopVersion } from '@/store/updates'

import { LegalSettings } from './legal-settings'
import { SectionHeading, SettingsContent } from './primitives'
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
  const { t } = useI18n()
  const u = t.updates
  const version = useStore($desktopVersion)
  const connection = useStore($connection)
  const check = useStore($updateCheckDialog)
  const remote = connection?.mode === 'remote'
  const checking = check.open && check.phase === 'checking'

  // Refresh the running version when About opens or the active gateway changes.
  useEffect((): void => {
    void refreshDesktopVersion()

    if (remote) {
      void checkBackendUpdates()
    }
  }, [connection, remote])

  return (
    <SettingsContent>
      <VersionHero showBrandMark={false} version={version} />
      <div className="mx-auto mt-4 w-full max-w-2xl">
        <SectionHeading
          aside={
            <Button
              disabled={checking}
              onClick={() => void requestUpdateCheck()}
              size="sm"
              type="button"
              variant="secondary"
            >
              {checking ? u.checkingShort : u.checkForUpdates}
            </Button>
          }
          icon={RefreshCw}
          title={t.settings.about.updates}
        />
        <div className="grid gap-3" id={settingElementId(SETTING_IDS.about.updates)}>
          <UpdateStatusCard target="client" />
          {/* Client and remote backend updates are independent. Only the client has release notes. */}
          {remote && <UpdateStatusCard showReleaseNotes={false} target="backend" />}
        </div>
      </div>
    </SettingsContent>
  )
}
