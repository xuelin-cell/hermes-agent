import { Button } from '@/components/ui/button'
import { DESKTOP_DOCS_URL } from '@/lib/docs'
import { openExternalLink } from '@/lib/external-link'

import { ListRow, SettingsContent } from './primitives'
import { useSettingsRedesignCopy } from './redesign-copy'

/** Reorganizes existing help actions without collecting or uploading data. */
export function HelpSettings() {
  const copy = useSettingsRedesignCopy()

  return (
    <SettingsContent>
      <div className="settings-card">
        <ListRow
          action={
            <Button
              disabled={!window.hermesDesktop?.revealLogs}
              onClick={() => void window.hermesDesktop?.revealLogs()}
              size="sm"
            >
              {copy('logs')}
            </Button>
          }
          title={copy('logs')}
        />
        <ListRow
          action={
            <Button onClick={() => void openExternalLink(DESKTOP_DOCS_URL)} size="sm">
              {copy('docs')}
            </Button>
          }
          title={copy('docs')}
        />
      </div>
    </SettingsContent>
  )
}
