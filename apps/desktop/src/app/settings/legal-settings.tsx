import { Fragment, type ReactElement } from 'react'

import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { triggerHaptic } from '@/lib/haptics'
import { LEGAL_LINKS } from '@/lib/legalLinks'

import { SETTING_IDS, settingElementId } from './settings-manifest'

/**
 * The agreements and policies that govern this app, as the closing footer strip
 * of Settings › About: one wrapping line of links, `|`-separated, with no
 * heading or copy of its own. Every row is a link out to the hosted document —
 * the copies are never bundled, so a policy revision reaches installed builds
 * without shipping an update.
 *
 * `scroll-mt` keeps the strip clear of the pane's top edge when the old
 * `?page=legal` deep link scrolls it into view.
 */
export function LegalSettings(): ReactElement {
  const { t } = useI18n()
  const copy = t.settings.legal

  return (
    <section className="scroll-mt-4" id={settingElementId(SETTING_IDS.about.legal)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[length:var(--conversation-text-font-size)]">
        {LEGAL_LINKS.map((link, index) => (
          <Fragment key={link.id}>
            {index > 0 && (
              <span aria-hidden className="select-none text-muted-foreground/35">
                |
              </span>
            )}
            <button
              className="text-(--ui-text-tertiary) transition hover:text-foreground"
              onClick={() => {
                triggerHaptic('selection')
                openExternalLink(link.url)
              }}
              type="button"
            >
              {copy.items[link.id]}
            </button>
          </Fragment>
        ))}
      </div>
    </section>
  )
}
