import { useStore } from '@nanostores/react'
import type { ReactElement } from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { ArrowUp, X } from '@/lib/icons'
import { $updateApply, $updateReady, dismissUpdateReady, openUpdateOverlayFor, startActiveUpdate } from '@/store/updates'

/**
 * Ambient "new version ready" pill anchored to the bottom-left corner.
 *
 * It renders only after the background download actually finished
 * ($updateReady), so in-flight, failed, and up-to-date checks never interrupt
 * the user. Closing it dismisses the prompt for this session only.
 */
export function UpdateReadyPrompt(): ReactElement | null {
  const ready = useStore($updateReady)
  const apply = useStore($updateApply)
  const { t } = useI18n()
  const u = t.updates

  // Hidden the moment an install starts: the updates overlay owns that state.
  if (!ready || apply.applying) {
    return null
  }

  return (
    <div
      aria-live="polite"
      className="fixed bottom-4 left-4 z-40 flex min-w-[26rem] max-w-[34rem] items-center gap-3 rounded-xl border border-border/70 bg-card px-4 py-3 shadow-lg"
    >
      <ArrowUp aria-hidden className="size-5 shrink-0 text-primary" />
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{u.newVersionReady}</span>
      <Button
        className="shrink-0 px-4 py-1.5"
        onClick={() => openUpdateOverlayFor('client')}
        size="sm"
        type="button"
        variant="outline"
      >
        {u.updateLog}
      </Button>
      <Button
        className="shrink-0 px-4 py-1.5"
        onClick={() => {
          dismissUpdateReady()
          startActiveUpdate('client')
        }}
        size="sm"
        type="button"
      >
        {u.restartToUpdate}
      </Button>
      <button
        aria-label={t.common.close}
        className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-(--chrome-action-hover) hover:text-foreground"
        onClick={dismissUpdateReady}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  )
}
