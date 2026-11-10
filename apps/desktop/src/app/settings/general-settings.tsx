import { useStore } from '@nanostores/react'

import { LanguageSwitcher } from '@/components/language-switcher'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import { $keepAwake, setKeepAwake } from '@/store/keep-awake'
import { useTheme } from '@/themes/context'

import { ListRow, SettingsContent, ToggleRow } from './primitives'
import { PrivacySettings } from './privacy-settings'
import { useSettingsRedesignCopy } from './redesign-copy'
import { DefaultProjectDirSetting } from './sessions-settings'
import { useSettingDeepLink } from './use-setting-deep-link'

export function GeneralSettings() {
  useSettingDeepLink('general')
  const copy = useSettingsRedesignCopy()
  const { t } = useI18n()
  const { mode, setMode } = useTheme()
  const awake = useStore($keepAwake)

  return (
    <SettingsContent>
      <h2 className="settings-section-label">{copy('regular')}</h2>
      <div className="settings-card">
        <ListRow action={<LanguageSwitcher />} description={t.language.description} title={t.language.label} />
        <ListRow
          action={
            <SegmentedControl
              onChange={setMode}
              options={(['light', 'dark', 'system'] as const).map(id => ({ id, label: copy(id) }))}
              value={mode}
            />
          }
          description={copy('themeDesc')}
          title={copy('theme')}
        />
      </div>
      <h2 className="settings-section-label">{copy('permissions')}</h2>
      <div className="settings-card">
        <ToggleRow checked={awake} description={copy('awakeDesc')} label={copy('awake')} onChange={setKeepAwake} />
      </div>
      <h2 className="settings-section-label">{copy('storage')}</h2>
      <div className="settings-card">
        <DefaultProjectDirSetting />
      </div>
      <h2 className="settings-section-label">{copy('privacy')}</h2>
      <div className="settings-card">
        <PrivacySettings />
      </div>
    </SettingsContent>
  )
}
