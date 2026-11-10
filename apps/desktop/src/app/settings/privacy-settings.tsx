import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { getHermesConfigRecord, saveHermesConfig } from '@/hermes'
import { notifyError } from '@/store/notifications'
import { $settingsRequestProfile } from '@/store/settings-scope'
import type { HermesConfigRecord } from '@/types/hermes'

import { ToggleRow } from './primitives'
import { useSettingsRedesignCopy } from './redesign-copy'
import { SETTING_IDS, settingElementId } from './settings-manifest'

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

export function PrivacySettings() {
  const profile = useStore($settingsRequestProfile)
  const copy = useSettingsRedesignCopy()
  const [config, setConfig] = useState<HermesConfigRecord | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    setConfig(null)
    void getHermesConfigRecord(profile)
      .then(value => {
        if (current) {
          setConfig(value)
        }
      })
      .catch(error => notifyError(error, copy('privacy')))

    return () => {
      current = false
    }
  }, [profile, copy])
  const servers = object(config?.mcp_servers)
  const drive = object(servers['UniWork-Drive'])
  const telemetry = object(object(object(object(config?.plugins).entries)['uniwork-telemetry']).settings)

  async function change(kind: 'drive' | 'telemetry', enabled: boolean) {
    setBusy(true)

    try {
      const fresh = await getHermesConfigRecord(profile)

      if (kind === 'drive') {
        const servers = object(fresh.mcp_servers)
        fresh.mcp_servers = { ...servers, 'UniWork-Drive': { ...object(servers['UniWork-Drive']), enabled } }
      } else {
        const plugins = object(fresh.plugins)
        const entries = object(plugins.entries)
        const plugin = object(entries['uniwork-telemetry'])
        fresh.plugins = {
          ...plugins,
          entries: { ...entries, 'uniwork-telemetry': { ...plugin, settings: { ...object(plugin.settings), enabled } } }
        }
      }

      await saveHermesConfig(fresh, profile)

      if ($settingsRequestProfile.get() === profile) {
        setConfig(fresh)
      }
    } catch (error) {
      notifyError(error, copy('privacy'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ToggleRow
        checked={Boolean(config && drive.enabled !== false && drive.uniwork_managed)}
        description={copy('driveDesc')}
        disabled={!config || busy || !drive.uniwork_managed}
        id={settingElementId(SETTING_IDS.general.agentLibraryAccess)}
        label={copy('drive')}
        onChange={on => void change('drive', on)}
      />
      <ToggleRow
        checked={Boolean(config && telemetry.enabled !== false)}
        description={copy('experienceDesc')}
        disabled={!config || busy}
        label={copy('experience')}
        onChange={on => void change('telemetry', on)}
      />
    </>
  )
}
