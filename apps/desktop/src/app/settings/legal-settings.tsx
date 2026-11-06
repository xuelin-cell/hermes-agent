import type { ReactElement } from 'react'

import { useI18n } from '@/i18n'
import { openExternalLink } from '@/lib/external-link'
import { triggerHaptic } from '@/lib/haptics'
import { ExternalLink, FileText } from '@/lib/icons'
import { LEGAL_LINKS } from '@/lib/legalLinks'

import { SectionHeading } from './primitives'
import { SETTING_IDS, settingElementId } from './settings-manifest'

/**
 * The agreements and policies that govern this app, rendered as the lower
 * section of Settings › About. Every row is a link out to the hosted document —
 * the copies are never bundled, so a policy revision reaches installed builds
 * without shipping an update.
 */
export function LegalSettings(): ReactElement {
  const { t } = useI18n()
  const copy = t.settings.legal

  return (
    <section id={settingElementId(SETTING_IDS.about.legal)}>
      <SectionHeading icon={FileText} title={copy.title} />
      <p className="mb-3 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
        {copy.description}
      </p>
      <div className="divide-y divide-border/40 rounded-xl border border-border/50">
        {LEGAL_LINKS.map(link => (
          <button
            className="group flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-(--chrome-action-hover)"
            key={link.id}
            onClick={() => {
              triggerHaptic('selection')
              openExternalLink(link.url)
            }}
            type="button"
          >
            <span className="min-w-0 flex-1 text-[length:var(--conversation-text-font-size)] font-medium text-foreground">
              {copy.items[link.id]}
            </span>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground transition group-hover:text-foreground" />
          </button>
        ))}
      </div>
    </section>
  )
}
