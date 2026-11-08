import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { SyncStatusCard } from '@/components/sync-status-card'
import { Button } from '@/components/ui/button'
import { writeClipboardText } from '@/components/ui/copy-button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  preventCloseButtonAutoFocus
} from '@/components/ui/dialog'
import { ErrorIcon, ErrorState } from '@/components/ui/error-state'
import { Loader } from '@/components/ui/loader'
import { Progress } from '@/components/ui/progress'
import { UpdateStatusCard, VersionHero } from '@/components/update-status'
import { VersionDetails } from '@/components/version-details'
import type { DesktopUpdateCommit, DesktopUpdateStage, DesktopUpdateStatus, DesktopVersionInfo } from '@/global'
import { useI18n } from '@/i18n'
import { buildCommitChangelog } from '@/lib/commit-changelog'
import { AlertCircle, Check, Copy, Terminal } from '@/lib/icons'
import { type ReleaseNoteGroup, selectReleaseNotes } from '@/lib/release-notes'
import { resolveUpdateCopy, type UpdateTarget } from '@/lib/update-copy'
import { cn } from '@/lib/utils'
import {
  $backendUpdateApply,
  $backendUpdateChecking,
  $backendUpdateStatus,
  $desktopVersion,
  $updateApply,
  $updateChecking,
  $updateOverlayOpen,
  $updateOverlayTarget,
  $updateReady,
  $updateStatus,
  applyBackendUpdate,
  applyUpdates,
  cancelActiveUpdate,
  checkBackendUpdates,
  checkUpdates,
  dismissDiscontinuedNotice,
  resetUpdateApplyState,
  setUpdateOverlayOpen,
  type UpdateApplyState
} from '@/store/updates'

import { DiscontinuedNotice } from './retirement-view'

function totalItems(groups: readonly ReleaseNoteGroup[]) {
  return groups.reduce((sum, g) => sum + g.items.length, 0)
}

// Stages that are still moving bytes. apply() keeps running after "Cancel" —
// only the surface that reports it is gone.
const DOWNLOAD_STAGES: ReadonlySet<DesktopUpdateStage> = new Set<DesktopUpdateStage>(['prepare', 'fetch'])

function isDownloadStage(stage: DesktopUpdateStage): boolean {
  return DOWNLOAD_STAGES.has(stage)
}

export function UpdatesOverlay() {
  const open = useStore($updateOverlayOpen)
  const target = useStore($updateOverlayTarget)

  const clientStatus = useStore($updateStatus)
  const clientChecking = useStore($updateChecking)
  const clientApply = useStore($updateApply)
  const backendStatus = useStore($backendUpdateStatus)
  const backendChecking = useStore($backendUpdateChecking)
  const backendApply = useStore($backendUpdateApply)
  const desktopVersion = useStore($desktopVersion)
  const ready = useStore($updateReady)

  const isBackend = target === 'backend'
  const status = isBackend ? backendStatus : clientStatus
  const checking = isBackend ? backendChecking : clientChecking
  const apply = isBackend ? backendApply : clientApply
  const check = isBackend ? checkBackendUpdates : checkUpdates
  const install = isBackend ? applyBackendUpdate : applyUpdates

  useEffect(() => {
    if (open && !status && !checking) {
      void check()
    }
  }, [check, checking, open, status])

  const behind = status?.behind ?? 0
  const updateAvailable = status?.updateAvailable || behind > 0

  const phase: 'idle' | 'applying' | 'manual' | 'guiSkew' | 'error' =
    apply.stage === 'manual'
      ? 'manual'
      : apply.stage === 'guiSkew'
        ? 'guiSkew'
        : apply.applying || apply.stage === 'restart'
          ? 'applying'
          : apply.stage === 'error'
            ? 'error'
            : 'idle'

  const downloadInProgress = !isBackend && phase === 'applying' && isDownloadStage(apply.stage)

  // A package already on disk is not installed by opening this overlay: the
  // ready view's "launch" IS the start of the install, and it stays a user
  // decision. Packages still in flight render their transfer instead.
  const launchReady = !isBackend && phase === 'idle' && Boolean(ready) && updateAvailable && !status?.retirement

  const handleClose = (next: boolean) => {
    // Only the transfer is interruptible: abort it for real so the remaining
    // bytes stop arriving. Once the installer owns the window there is nothing
    // left to cancel, and closing it would hide the restart.
    if (phase === 'applying') {
      if (downloadInProgress) {
        void cancelActiveUpdate()
      }

      return
    }

    setUpdateOverlayOpen(next)

    if (
      !next &&
      (apply.stage === 'error' || apply.stage === 'restart' || apply.stage === 'manual' || apply.stage === 'guiSkew')
    ) {
      resetUpdateApplyState()
    }
  }

  const handleInstall = () => {
    void install()
  }

  return (
    <Dialog onOpenChange={handleClose} open={open}>
      {/* This dialog has no inputs, so Radix's default autofocus would land on
          the close button and trigger its tooltip immediately on open. */}
      <DialogContent
        bodyClassName="overflow-hidden p-0 gap-0"
        className={cn('max-w-sm', phase === 'applying' && 'max-w-lg')}
        onOpenAutoFocus={preventCloseButtonAutoFocus}
        showCloseButton={phase !== 'applying' || downloadInProgress}
      >
        {phase === 'applying' && (
          <ApplyingView apply={apply} onCancel={isBackend ? undefined : () => handleClose(false)} />
        )}

        {phase === 'idle' && launchReady && (
          <ReadyView onLater={() => handleClose(false)} onLaunch={handleInstall} version={ready?.version ?? null} />
        )}

        {phase === 'manual' && (
          <ManualView
            command={apply.command ?? null}
            isBackend={isBackend}
            message={apply.message}
            onDone={() => handleClose(false)}
          />
        )}

        {phase === 'guiSkew' && <GuiSkewView message={apply.message} onDone={() => handleClose(false)} />}

        {phase === 'error' ? (
          <ErrorView message={apply.message} onDismiss={() => handleClose(false)} onRetry={handleInstall} />
        ) : null}

        {phase === 'idle' && !isBackend && status?.retirement?.state === 'discontinued' && (
          <DiscontinuedNotice
            onDismiss={() => {
              dismissDiscontinuedNotice(status.retirement!)
              handleClose(false)
            }}
            retirement={status.retirement}
          />
        )}
        {phase === 'idle' && (isBackend || !status?.retirement) && !launchReady && (
          <IdleView
            behind={behind}
            checking={checking}
            commits={status?.commits ?? []}
            onInstall={handleInstall}
            onLater={() => handleClose(false)}
            onRetryCheck={() => void check()}
            status={status}
            target={target}
            updateAvailable={updateAvailable}
            version={desktopVersion}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

// The verified package is on disk and nothing else is moving: name that state
// and put the only install action on it. Nothing here installs, quits or
// restarts on its own — the click is the whole hand-off.
function ReadyView({
  onLater,
  onLaunch,
  version
}: {
  onLater: () => void
  onLaunch: () => void
  version: string | null
}) {
  const { t } = useI18n()
  const u = t.updates
  const label = version ? `v${version}` : null

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <BrandMark className="size-16" />

        <DialogTitle className="text-center text-xl">{u.newVersionReady}</DialogTitle>
        <DialogDescription className="text-center text-sm">
          {label ? u.newVersionReadyBody(label) : u.newVersionReady}
        </DialogDescription>
      </div>

      <div className="grid gap-2">
        <Button className="font-semibold" onClick={onLaunch} size="lg">
          {u.launchNow}
        </Button>
        <Button className="font-medium" onClick={onLater} type="button" variant="text">
          {u.maybeLater}
        </Button>
      </div>
    </div>
  )
}

function IdleView({
  behind,
  checking,
  commits,
  onInstall,
  onLater,
  onRetryCheck,
  status,
  target,
  updateAvailable,
  version
}: {
  behind: number
  checking: boolean
  commits: readonly DesktopUpdateCommit[]
  onInstall: () => void
  onLater: () => void
  onRetryCheck: () => void
  status: DesktopUpdateStatus | null
  target: UpdateTarget
  updateAvailable: boolean
  version: DesktopVersionInfo | null
}) {
  const { t, locale } = useI18n()
  const u = t.updates

  if (!status && checking) {
    return (
      <CenteredStatus
        icon={<Loader className="size-12" label={u.checking} type="lemniscate-bloom" />}
        title={u.checking}
      />
    )
  }

  if (!status) {
    return (
      <CenteredStatus
        action={
          <Button onClick={onRetryCheck} size="sm">
            {u.tryAgain}
          </Button>
        }
        icon={<ErrorIcon />}
        title={u.checkFailedTitle}
      />
    )
  }

  const details = version ? <VersionDetails version={version} /> : null

  // App-installer check-unknown (OS checker unavailable): NOT "no updates"
  // and NOT a generic error — the OS also installs updates automatically on
  // restart (it re-reads the .appinstaller feed on every launch), so the
  // honest view names that path. Only this mechanism gets it.
  if (status.mechanism === 'app-installer' && status.error && !status.updateAvailable) {
    return (
      <div className="grid gap-4 px-6 pb-6 pt-1 pr-8">
        <VersionHero
          renderHeading={heading => (
            <DialogTitle className="text-lg font-semibold tracking-tight">{heading}</DialogTitle>
          )}
          version={version}
        />
        <div className="flex flex-col items-center gap-2 text-center">
          <AlertCircle className="size-6 text-muted-foreground" />
          <p className="text-sm font-medium">{u.checkUnknownTitleAppInstaller}</p>
          <p className="max-w-prose text-sm leading-5 text-muted-foreground">{u.checkUnknownBodyAppInstaller}</p>
        </div>
        <Button onClick={onRetryCheck} size="sm">
          {u.tryAgain}
        </Button>
        {details}
      </div>
    )
  }

  // Everything that is NOT the install pitch — unsupported, check error, and
  // already-latest — is exactly the About page's state: render the shared
  // hero + status card so the two surfaces cannot drift. The card owns the
  // check/retry actions (its "Check now" covers the old Try-again button).
  if (!status.supported || status.error || !updateAvailable) {
    return (
      <div className="grid gap-4 px-6 pb-6 pt-1 pr-8">
        <VersionHero
          renderHeading={heading => (
            <DialogTitle className="text-lg font-semibold tracking-tight">{heading}</DialogTitle>
          )}
          version={version}
        />
        <UpdateStatusCard target={target} />
        <SyncStatusCard />
        {details}
      </div>
    )
  }

  // Authored copy published beside the feed wins: the publisher decides the
  // wording, and the row-by-row commit changelog stays the source-install and
  // fallback path.
  const groups: readonly ReleaseNoteGroup[] =
    selectReleaseNotes(status?.releaseNotes, locale) ??
    buildCommitChangelog(commits, {
      labels: {
        new: u.changeLogNew,
        fixed: u.changeLogFixed,
        faster: u.changeLogFaster,
        improved: u.changeLogImproved,
        other: u.changeLogOther
      },
      fallback: { label: u.changeLogFallbackLabel, item: u.changeLogFallbackItem }
    })

  const shownItems = totalItems(groups)
  const remaining = Math.max(0, behind - shownItems)

  // Name what's being updated. In remote mode the overlay acts on the connected
  // backend, not the local client — say so. When there are no commit rows to
  // show (e.g. pip/non-git backend), degrade to honest "no release notes" copy
  // instead of generic filler. On a release-feed channel (stable), name the
  // release tag instead of commit vocabulary.
  const { title, body } = resolveUpdateCopy({
    target,
    shownItems,
    channel: status?.channel === 'stable' ? 'stable' : 'main',
    latestTag: status?.latestTag ?? null,
    mechanism: status?.mechanism,
    copy: u
  })

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <BrandMark className="size-16" />

        <DialogTitle className="text-center text-xl">{title}</DialogTitle>
        <DialogDescription className="text-center text-sm">{body}</DialogDescription>
      </div>

      <div className="grid gap-3">
        {groups.map(group => (
          <div key={group.id}>
            <p className="text-[0.625rem] font-semibold text-muted-foreground">{group.label}</p>
            <ul className="mt-1.5 grid gap-1.5 text-xs text-foreground">
              {group.items.map((item, index) => (
                <li className="flex items-start gap-2" key={`${group.id}-${index}`}>
                  <span aria-hidden className="mt-1.5 inline-block size-1 shrink-0 rounded-full bg-primary" />
                  <span className="leading-snug">{item}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="grid gap-2">
        <Button className="font-semibold" onClick={onInstall} size="lg">
          {u.updateNow}
        </Button>
        <Button className="font-medium" onClick={onLater} type="button" variant="text">
          {u.maybeLater}
        </Button>
      </div>

      {remaining > 0 && <p className="text-center text-xs text-muted-foreground">{u.moreChanges(remaining)}</p>}

      <SyncStatusCard />
    </div>
  )
}

function ManualView({
  command,
  isBackend,
  message,
  onDone
}: {
  command: string | null
  isBackend: boolean
  message?: string
  onDone: () => void
}) {
  const { t } = useI18n()
  const u = t.updates
  const [copied, setCopied] = useState(false)
  const guidance: string | undefined = message && message !== command ? message : undefined

  const handleCopy = () => {
    if (!command) {
      return
    }

    void writeClipboardText(command).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    })
  }

  // No command (e.g. the Linux sandbox-blocked relaunch): render the explanatory
  // message + a Done button, not a copy-a-command box.
  if (!command) {
    return (
      <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <Terminal className="size-8 text-primary" />

          <DialogTitle className="text-center text-xl">
            {isBackend ? u.manualUnavailableTitle : u.manualTitle}
          </DialogTitle>
          <DialogDescription className="text-center text-sm">{message || u.manualPickedUp}</DialogDescription>
        </div>

        <Button className="font-semibold" onClick={onDone} size="lg" variant="secondary">
          {u.done}
        </Button>
      </div>
    )
  }

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <Terminal className="size-8 text-primary" />

        <DialogTitle className="text-center text-xl">{u.manualTitle}</DialogTitle>
        <DialogDescription className="text-center text-sm">
          {guidance ?? (isBackend ? u.manualBodyBackend : u.manualBody)}
        </DialogDescription>
      </div>

      <button
        className={cn(
          'group flex w-full items-center justify-between gap-3 rounded-md border px-4 py-3 text-left transition-colors',
          copied ? 'border-primary/50' : 'border-(--stroke-nous) hover:border-(--ui-stroke-secondary)'
        )}
        onClick={handleCopy}
        type="button"
      >
        <code className="min-w-0 flex-1 truncate select-all font-mono text-sm text-foreground">
          <span className="select-none text-muted-foreground">$ </span>
          {command}
        </code>
        <span
          className={cn(
            'flex shrink-0 items-center gap-1 text-xs font-medium transition-colors',
            copied ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
          )}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? u.copied : u.copy}
        </span>
      </button>

      {!guidance && (
        <p className="text-center text-xs text-muted-foreground">
          {isBackend ? u.manualPickedUpBackend : u.manualPickedUp}
        </p>
      )}

      <Button className="font-semibold" onClick={onDone} size="lg" variant="secondary">
        {u.done}
      </Button>
    </div>
  )
}

// Linux GUI/backend skew (#45205): backend updated, but the running desktop app
// package (AppImage/.deb/.rpm) was NOT changed. Closeable terminal state that
// tells the user to update/reinstall the desktop app — never claims the GUI was
// updated.
function GuiSkewView({ message, onDone }: { message?: string; onDone: () => void }) {
  const { t } = useI18n()
  const u = t.updates

  return (
    <div className="grid gap-5 px-6 pb-6 pt-7 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <AlertCircle className="size-8 text-amber-500" />

        <DialogTitle className="text-center text-xl">{u.guiSkewTitle}</DialogTitle>
        <DialogDescription className="max-w-prose text-center text-sm leading-5 text-muted-foreground">
          {message || u.guiSkewBody}
        </DialogDescription>
      </div>

      <Button className="font-semibold" onClick={onDone} size="lg" variant="secondary">
        {u.done}
      </Button>
    </div>
  )
}

// The reference "Software Update" dialog: a centered title, the brand tile on
// the left of a single progress line, and one trailing action. The download is
// the only stage that can be aborted ("Cancel" asks the main process to stop
// the transfer); once the installer owns the window the footer switches to the
// close-warning copy instead of a button.
function ApplyingView({ apply, onCancel }: { apply: UpdateApplyState; onCancel?: () => void }) {
  const { t } = useI18n()
  const u = t.updates
  const label = u.stages[apply.stage] ?? u.stages.idle
  const downloading = isDownloadStage(apply.stage)
  const headline = downloading ? u.downloadingUpdate : label
  const message = apply.message.trim()

  const percent =
    typeof apply.percent === 'number' && Number.isFinite(apply.percent)
      ? Math.max(2, Math.min(100, Math.round(apply.percent)))
      : null

  return (
    <div className="grid gap-5 p-6">
      <DialogTitle className="text-center text-sm font-medium text-muted-foreground">{u.updateDialogTitle}</DialogTitle>

      <div className="flex items-center gap-4">
        <BrandMark className="size-16 rounded-2xl" />

        <div className="grid min-w-0 flex-1 gap-2.5">
          {/* Doubles as the dialog's accessible description. */}
          <DialogDescription className="text-sm font-semibold leading-5 text-foreground">{headline}</DialogDescription>

          <Progress
            aria-label={headline}
            indeterminate={percent === null}
            size="sm"
            value={percent === null ? 0 : percent / 100}
          />

          {!downloading && message ? <p className="text-xs leading-5 text-muted-foreground">{message}</p> : null}
        </div>
      </div>

      <div className="flex min-h-8 items-center justify-end">
        {downloading && onCancel ? (
          <Button className="min-w-20" onClick={onCancel} size="sm" type="button" variant="outline">
            {t.common.cancel}
          </Button>
        ) : (
          <p className="text-xs text-muted-foreground">{u.applyingClose}</p>
        )}
      </div>
    </div>
  )
}

function ErrorView({ message, onDismiss, onRetry }: { message: string; onDismiss: () => void; onRetry: () => void }) {
  const { t } = useI18n()
  const u = t.updates

  return (
    <ErrorState
      className="px-6 pb-6 pt-7 pr-8"
      description={
        <DialogDescription className="max-w-prose text-center text-sm leading-5 text-muted-foreground">
          {message || u.errorBody}
        </DialogDescription>
      }
      title={<DialogTitle className="text-center text-xl font-semibold tracking-tight">{u.errorTitle}</DialogTitle>}
    >
      <Button className="font-semibold" onClick={onRetry} size="lg">
        {u.tryAgain}
      </Button>
      <Button onClick={onDismiss} variant="text">
        {u.notNow}
      </Button>
    </ErrorState>
  )
}

function CenteredStatus({
  action,
  body,
  icon,
  title
}: {
  action?: React.ReactNode
  body?: string
  icon: React.ReactNode
  title: string
}) {
  return (
    <div className="grid gap-4 px-6 pb-6 pt-8 pr-8">
      <div className="flex flex-col items-center gap-3 text-center">
        {icon}

        <DialogTitle className="text-center text-lg">{title}</DialogTitle>
        {body && <DialogDescription className="text-center text-sm">{body}</DialogDescription>}
      </div>

      {action && <div className="flex justify-center">{action}</div>}
    </div>
  )
}
