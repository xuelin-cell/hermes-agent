import { useStore } from '@nanostores/react'
import type { ReactElement } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle, preventCloseButtonAutoFocus } from '@/components/ui/dialog'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n'
import { AlertCircle } from '@/lib/icons'
import { shortVersion } from '@/lib/version-label'
import { $desktopVersion } from '@/store/updates'
import { $updateCheckDialog, closeUpdateCheckDialog, requestUpdateCheck } from '@/store/update-check'

/**
 * The lightweight answer a manual "check for updates" owes the user: either
 * "you're current" or the reason the check failed. An available update never
 * lands here — store/update-check hands those to the updates overlay.
 */
export function UpdateCheckDialog(): ReactElement {
  const { t } = useI18n()
  const u = t.updates
  const state = useStore($updateCheckDialog)
  const version = useStore($desktopVersion)

  const title = version?.appVersion ? `${u.appName} ${shortVersion(version.appVersion)}` : u.appName

  return (
    <Dialog
      onOpenChange={open => {
        if (!open) {
          closeUpdateCheckDialog()
        }
      }}
      open={state.open}
    >
      {/* No inputs: Radix's default autofocus would land on the close button. */}
      <DialogContent bodyClassName="gap-5 p-6" className="max-w-sm" onOpenAutoFocus={preventCloseButtonAutoFocus}>
        <DialogTitle className="text-center text-sm font-medium text-muted-foreground">
          {u.updateDialogTitle}
        </DialogTitle>

        {state.phase === 'checking' && (
          <div className="flex flex-col items-center gap-3 text-center">
            <Loader className="size-10" label={u.checking} type="lemniscate-bloom" />
            <p className="text-sm text-muted-foreground">{u.checking}</p>
          </div>
        )}

        {state.phase === 'latest' && (
          <div className="flex items-center gap-3">
            <BrandMark className="size-14 rounded-xl" />
            <p className="min-w-0 text-sm leading-6 text-foreground">
              {title}
              <strong className="ml-1 font-semibold">{u.upToDate}</strong>
            </p>
          </div>
        )}

        {state.phase === 'error' && (
          <div className="flex items-center gap-3">
            <AlertCircle className="size-10 shrink-0 text-muted-foreground" />
            <p className="min-w-0 text-sm leading-6 text-foreground">{state.message ?? u.updateCheckFailed}</p>
          </div>
        )}

        {state.phase !== 'checking' && (
          <div className="flex justify-end gap-2">
            {state.phase === 'error' && (
              <Button onClick={() => void requestUpdateCheck()} size="sm" type="button" variant="secondary">
                {u.tryAgain}
              </Button>
            )}
            <Button onClick={closeUpdateCheckDialog} size="sm" type="button">
              {u.gotIt}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
