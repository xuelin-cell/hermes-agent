import { persistString, persistStringRecord, storedString, storedStringRecord } from '@/lib/storage'

const MIGRATION_KEY = 'uniwork-design-theme-v1'

/** 一次性迁移旧默认主题，保留其他主题、各档案设置和之后主动选择的 Nous。 */
export function migrateDefaultTheme(): void {
  if (storedString(MIGRATION_KEY)) return
  const legacyKey = 'hermes-desktop-theme-v2'
  const profilesKey = 'hermes-desktop-profile-themes-v1'
  if (storedString(legacyKey) === 'nous') persistString(legacyKey, 'uniwork')
  const profiles = storedStringRecord(profilesKey)
  for (const key of Object.keys(profiles)) {
    if (profiles[key] === 'nous') profiles[key] = 'uniwork'
  }
  persistStringRecord(profilesKey, profiles)
  persistString(MIGRATION_KEY, 'done')
}
