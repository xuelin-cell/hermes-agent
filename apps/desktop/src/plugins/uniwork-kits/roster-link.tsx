import { usePluginI18n } from '@hermes/plugin-sdk'

import { openKitsPage } from './navigation'

/** Kits entry on the Bots header. That pane is the layout this window shows. */
export function KitsRosterLink() {
  const t = usePluginI18n('uniwork-kits')

  return (
    <button
      className="text-[0.6875rem] font-medium text-(--ui-text-secondary) underline-offset-2 hover:underline"
      onClick={() => openKitsPage()}
      type="button"
    >
      {t('title')}
    </button>
  )
}
