import { useStore } from '@nanostores/react'
import type { ReactElement } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  preventCloseButtonAutoFocus
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { useI18n } from '@/i18n'
import { shortVersion } from '@/lib/version-label'
import { $updateCheckDialog } from '@/store/update-check'
import {
  $updateApply,
  $updateDownloadFailure,
  $updateDownloadRetrying,
  $updateOverlayOpen,
  $updateReady,
  dismissUpdateDownloadFailure,
  dismissUpdateReady,
  retryUpdateDownload,
  startActiveUpdate
} from '@/store/updates'

/**
 * The "Software Update" answer for the download stage, in the same shell as the
 * progress dialog:
 *
 * - a failed transfer ($updateDownloadFailure) with its reason and a retry that
 *   re-runs that transfer — never the check;
 * - a finished download ($updateReady) that restarts into the install.
 *
 * The two states are mutually exclusive, and both step aside while an install
 * is running or the updates overlay is open. Nothing here starts an install on
 * its own: `startActiveUpdate` only fires from the user's click.
 */
export function UpdateDownloadDialog(): ReactElement | null {
  const failure = useStore($updateDownloadFailure)
  const retrying = useStore($updateDownloadRetrying)
  const ready = useStore($updateReady)
  const apply = useStore($updateApply)
  const overlayOpen = useStore($updateOverlayOpen)
  const checkDialogOpen = useStore($updateCheckDialog).open
  const { t } = useI18n()
  const u = t.updates

  const failed = Boolean(failure) && !retrying && !overlayOpen
  // A ready prompt never competes with a retry, a failure, a running install,
  // the updates overlay, or the manual-check dialog.
  const succeeded = Boolean(ready) && !failed && !retrying && !apply.applying && !overlayOpen && !checkDialogOpen
  const open = retrying || failed || succeeded

  if (!open) {
    return null
  }

  const version = ready?.version ? `v${shortVersion(ready.version)}` : null

  const handleClose = (): void => {
    if (retrying) {
      return
    }

    if (failed) {
      dismissUpdateDownloadFailure()
    } else {
      dismissUpdateReady()
    }
  }

  return (
    <Dialog
      onOpenChange={next => {
        if (!next) {
          handleClose()
        }
      }}
      open={open}
    >
      {/* No inputs: Radix's default autofocus would land on the close button. */}
      <DialogContent
        bodyClassName="overflow-hidden p-0 gap-0"
        className="max-w-lg"
        onOpenAutoFocus={preventCloseButtonAutoFocus}
        showCloseButton={!retrying}
      >
        <div className="grid gap-5 p-6">
          <DialogTitle className="text-center text-sm font-medium text-muted-foreground">
            {u.updateDialogTitle}
          </DialogTitle>

          <div className="flex items-center gap-4">
            <BrandMark className="size-16 rounded-2xl" />

            <div className="grid min-w-0 flex-1 gap-1">
              <DialogDescription
                className={
                  failed
                    ? 'text-sm font-semibold leading-6 text-destructive'
                    : 'text-sm font-semibold leading-6 text-foreground'
                }
              >
                {retrying
                  ? u.downloadingUpdate
                  : failed
                    ? u.downloadFailedTitle
                    : version
                      ? u.newVersionReadyBody(version)
                      : u.newVersionReady}
              </DialogDescription>

              {retrying ? <Progress aria-label={u.downloadingUpdate} className="mt-1" indeterminate size="sm" /> : null}

              {failed && failure?.message ? (
                <p className="line-clamp-2 break-words text-xs leading-5 text-muted-foreground">{failure.message}</p>
              ) : null}
            </div>
          </div>

          <div className="flex min-h-8 items-center justify-end gap-2">
            {failed ? (
              <Button
                className="min-w-20"
                onClick={() => void retryUpdateDownload()}
                size="sm"
                type="button"
                variant="outline"
              >
                {u.tryAgain}
              </Button>
            ) : retrying ? null : (
              <Button
                className="min-w-20"
                onClick={() => {
                  dismissUpdateReady()
                  startActiveUpdate('client')
                }}
                size="sm"
                type="button"
              >
                {u.restartToUpdate}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
