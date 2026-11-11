import { useStore } from '@nanostores/react'
import { type ReactElement, type ReactNode, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import type { DesktopUpdateStatus, DesktopVersionInfo } from '@/global'
import { type Translations, useI18n } from '@/i18n'
import { AlertTriangle, CheckCircle2, ExternalLink, Loader2, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { shortVersion } from '@/lib/version-label'
import { requestUpdateCheck } from '@/store/update-check'
import {
  $backendUpdateApply,
  $backendUpdateChecking,
  $backendUpdateStatus,
  $desktopVersion,
  $updateApply,
  $updateChecking,
  $updateReady,
  $updateStatus,
  checkBackendUpdates,
  checkUpdates,
  openUpdateOverlayFor,
  startActiveUpdate,
  type UpdateApplyState,
  type UpdateTarget
} from '@/store/updates'

// UniWork publishes its release notes on the product documentation site, not on
// the upstream GitHub releases page; About's release-notes row points there.
const RELEASE_NOTES_URL = 'https://www.yjworker.10010.com/app/documents/uniwork/doc/98'
const INSTALLER_URL = 'https://hermes-agent.nousresearch.com/'
// Product home page (same site as the release notes), opened from About's
// "visit website" row.
const WEBSITE_URL = 'https://www.yjworker.10010.com/'

export type UpdateStatusTone = 'idle' | 'available' | 'error' | 'unsupported'

export interface UpdateStatusView {
  line: string
  tone: UpdateStatusTone
  error?: string
  updateAvailable: boolean
  applying: boolean
  supported: boolean
}

function retirementStatus(
  retirement: NonNullable<DesktopUpdateStatus['retirement']>,
  applying: boolean,
  supported: boolean,
  u: Translations['updates']
): UpdateStatusView {
  // Suffixed-identity build: nothing to download or migrate — just the notice.
  return {
    applying,
    supported,
    updateAvailable: false,
    tone: 'error',
    line: u.discontinuedTitle,
    error: u.discontinuedBody
  }
}

/**
 * One status derivation for every "am I up to date?" surface (About page,
 * updates overlay). Pure so the tone/copy contract is unit-testable.
 */
interface UpdateStatusInput {
  apply: UpdateApplyState
  checking: boolean
  status: DesktopUpdateStatus | null
  target: UpdateTarget
  u: Translations['updates']
}

export function deriveUpdateStatus(input: UpdateStatusInput): UpdateStatusView {
  const { apply, status, target, u } = input

  if (target === 'client' && status?.retirement) {
    return retirementStatus(
      status.retirement,
      apply.applying || apply.stage === 'restart',
      status.supported !== false,
      u
    )
  }

  return ordinaryUpdateStatus(input)
}

function ordinaryUpdateStatus({ apply, checking, status, target, u }: UpdateStatusInput): UpdateStatusView {
  const behind = status?.behind ?? 0
  // behind is null when the exact count is unknowable (shallow clone): the
  // backend flags that case via updateAvailable instead of a number.
  const updateAvailable = behind > 0 || Boolean(status?.updateAvailable)
  const supported = status?.supported !== false
  const applying = apply.applying || apply.stage === 'restart'

  if (!supported) {
    return { applying, line: status?.message ?? u.unsupportedMessage, supported, tone: 'unsupported', updateAvailable }
  }

  if (status?.error) {
    return {
      applying,
      error: [status.message, status.error].filter(l => !!l).join('\n'),
      line: u.cantReach,
      supported,
      tone: 'error',
      updateAvailable
    }
  }

  if (applying) {
    return { applying, line: u.installing, supported, tone: 'available', updateAvailable }
  }

  if (updateAvailable) {
    return {
      applying,
      line: behind > 0 ? u.updateReady(behind) : u.updateReadyUnknown,
      supported,
      tone: 'available',
      updateAvailable
    }
  }

  if (status) {
    return {
      applying,
      line: target === 'backend' ? u.latestBodyBackend : u.latestBody,
      supported,
      tone: 'idle',
      updateAvailable
    }
  }

  return { applying, line: checking ? u.checking : u.tapCheck, supported, tone: 'idle', updateAvailable }
}

function relativeTime(ms: number | undefined, u: Translations['updates']): string {
  if (!ms) {
    return u.never
  }

  const diff = Date.now() - ms

  if (diff < 60_000) {
    return u.justNow
  }

  if (diff < 3_600_000) {
    return u.minAgo(Math.round(diff / 60_000))
  }

  if (diff < 86_400_000) {
    return u.hoursAgo(Math.round(diff / 3_600_000))
  }

  return u.daysAgo(Math.round(diff / 86_400_000))
}

/**
 * The "Hermes Desktop / version / brand mark" hero shared by the About page
 * and the updates overlay, including the bundle-out-of-sync warning. The
 * heading render is injectable so a dialog surface can emit a DialogTitle
 * for its accessible name while About keeps a plain h2. `showBrandMark`,
 * `showHeading` and `showVersion` are independent: About turns the whole brand
 * header (mark + product name) off — the nav entry and the update card already
 * name the app — and keeps only the warning, if any. Every part off renders
 * nothing, so the host page does not start with an empty hero's padding.
 */
export function VersionHero({
  renderHeading,
  showBrandMark = true,
  showHeading = true,
  showVersion = true,
  version
}: {
  renderHeading?: (heading: string) => ReactNode
  showBrandMark?: boolean
  showHeading?: boolean
  showVersion?: boolean
  version: DesktopVersionInfo | null
}): ReactElement | null {
  const { t } = useI18n()
  const u = t.updates
  const hasBanner: boolean = Boolean(version?.bundleSwapPending || version?.bundleOutOfSync)
  const hasHeadingBlock: boolean = showHeading || showVersion

  if (!showBrandMark && !hasHeadingBlock && !hasBanner) {
    return null
  }

  return (
    <div className="flex flex-col items-center gap-3 pt-6 pb-2 text-center">
      {showBrandMark && <BrandMark className="size-16" />}
      {hasHeadingBlock && (
        <div>
          {showHeading &&
            (renderHeading ? (
              renderHeading(u.appName)
            ) : (
              <h2 className="text-lg font-semibold tracking-tight">{u.appName}</h2>
            ))}
          {showVersion && (
            <p className="mt-1 text-xs text-muted-foreground">
              {version?.appVersion ? u.version(shortVersion(version.appVersion)) : u.versionUnavailable}
              {version?.channel
                ? ` · ${Object.entries(u.channels).find(([name]: [string, string]): boolean => name === version.channel)?.[1] ?? version.channel}`
                : ''}
            </p>
          )}
        </div>
      )}
      {(version?.bundleSwapPending || version?.bundleOutOfSync) && (
        <div className="mx-auto w-full max-w-2xl rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-left text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <div className="min-w-0">
              <p className="font-medium">{version.bundleSwapPending ? u.bundleSwapPending : u.bundleOutOfSync}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {version.bundleSwapPending ? u.bundleSwapPendingDesc : u.bundleOutOfSyncDesc}
              </p>
              {version.bundleSwapPending ? (
                <Button
                  className="mt-2"
                  onClick={() => void window.hermesDesktop?.relaunchApp?.()}
                  size="sm"
                  variant="textStrong"
                >
                  <RefreshCw className="size-3" />
                  {u.bundleSwapPendingAction}
                </Button>
              ) : (
                <Button asChild className="mt-2" size="sm" variant="textStrong">
                  <a
                    href={INSTALLER_URL}
                    onClick={event => {
                      event.preventDefault()
                      void window.hermesDesktop?.openExternal?.(INSTALLER_URL)
                    }}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <ExternalLink className="size-3" />
                    {u.bundleOutOfSyncAction}
                  </a>
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

interface UpdateActionsProps {
  target: UpdateTarget
  u: Translations['updates']
  view: UpdateStatusView
}

function UpdateActions({ target, u, view }: UpdateActionsProps): ReactElement | null {
  // Once the package is on disk the primary action installs it directly; the
  // release-notes detour lands on the same handoff, so it is not offered.
  const ready = useStore($updateReady)

  if (view.applying) {
    return null
  }

  if (!view.updateAvailable || !view.supported) {
    return null
  }

  return (
    <>
      <Button onClick={() => startActiveUpdate(target)} size="sm">
        {u.updateNow}
      </Button>
      {target === 'backend' || !ready ? (
        <Button onClick={() => openUpdateOverlayFor(target)} size="sm" variant="textStrong">
          {u.seeWhatsNew}
        </Button>
      ) : null}
    </>
  )
}

/**
 * The bordered update-state card (status line, last-checked age, check /
 * update / release-notes actions) in the About page's visual language.
 * Target-aware: 'client' reads the desktop self-update atoms, 'backend' the
 * remote backend's. The actual apply flow stays in the updates overlay —
 * "Update now" opens it and starts the install there.
 *
 * `variant="about"` is the reference two-row layout used by Settings › About:
 * current version + primary action, then about-the-product + website. The
 * updates overlay keeps the default card, so its visuals stay unchanged.
 */
export function UpdateStatusCard({
  showReleaseNotes = true,
  target,
  variant = 'card'
}: {
  showReleaseNotes?: boolean
  target: UpdateTarget
  variant?: 'about' | 'card'
}): ReactElement {
  const { t } = useI18n()
  const u = t.updates
  const isBackend = target === 'backend'
  const status = useStore(isBackend ? $backendUpdateStatus : $updateStatus)
  const checking = useStore(isBackend ? $backendUpdateChecking : $updateChecking)
  const apply = useStore(isBackend ? $backendUpdateApply : $updateApply)
  const desktopVersion = useStore($desktopVersion)
  const [justChecked, setJustChecked] = useState<boolean>(false)

  const view = deriveUpdateStatus({ apply, checking, status, target, u })

  const handleCheck = async (): Promise<void> => {
    setJustChecked(false)
    const next = await (isBackend ? checkBackendUpdates({ force: true }) : checkUpdates({ force: true }))
    setJustChecked(Boolean(next))
  }

  if (variant === 'about') {
    return (
      <AboutUpdateCard
        channel={isBackend ? null : (desktopVersion?.channel ?? null)}
        checking={checking}
        currentVersion={isBackend ? (status?.currentVersion ?? null) : (desktopVersion?.appVersion ?? null)}
        onCheck={() => void (isBackend ? handleCheck() : requestUpdateCheck())}
        showWebsite={showReleaseNotes}
        target={target}
        u={u}
        view={view}
      />
    )
  }

  return (
    <div
      className={cn(
        'rounded-xl border px-4 py-3 text-sm',
        view.tone === 'available' && 'border-primary/30 bg-primary/5 text-foreground',
        view.tone === 'error' && 'border-destructive/35 bg-destructive/5 text-destructive',
        (view.tone === 'idle' || view.tone === 'unsupported') && 'border-border/70 bg-muted/20 text-foreground'
      )}
    >
      <div className="flex items-start gap-2">
        {view.tone === 'available' ? (
          <Codicon className="mt-0.5 size-4 shrink-0 text-primary" name="cloud-download" size="1rem" />
        ) : view.tone === 'error' || view.tone === 'unsupported' ? null : (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        )}
        <div className="min-w-0">
          <p className="font-medium">{view.line}</p>
          {view.error && <p className="mt-1 text-xs text-muted-foreground">{view.error}</p>}
          {view.tone !== 'unsupported' && (
            <p className="mt-1 text-xs text-muted-foreground">
              {u.lastChecked(relativeTime(status?.fetchedAt, u))}
              {justChecked && !checking ? u.justNowSuffix : ''}
            </p>
          )}
        </div>
      </div>

      {view.tone !== 'unsupported' && (
        <div className="mt-3 flex flex-wrap items-center gap-4">
          <Button
            disabled={checking || view.applying}
            onClick={() => void handleCheck()}
            size="sm"
            variant="textStrong"
          >
            {checking ? <Loader2 className="size-3 animate-spin" /> : <RefreshCw className="size-3" />}
            {checking ? u.checkingShort : u.checkNow}
          </Button>

          <UpdateActions target={target} u={u} view={view} />

          {showReleaseNotes && (
            <Button asChild className="ml-auto" size="sm" variant="text">
              <a
                href={RELEASE_NOTES_URL}
                onClick={event => {
                  event.preventDefault()
                  void window.hermesDesktop?.openExternal?.(RELEASE_NOTES_URL)
                }}
                rel="noreferrer"
                target="_blank"
              >
                <ExternalLink className="size-3" />
                {u.releaseNotes}
              </a>
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

interface AboutUpdateCardProps {
  channel: string | null
  checking: boolean
  currentVersion: string | null
  onCheck: () => void
  showWebsite: boolean
  target: UpdateTarget
  u: Translations['updates']
  view: UpdateStatusView
}

/**
 * Settings › About's two-row update card: the running version with its primary
 * action, then the product/website row. An available update keeps the single
 * primary button and switches it to "update now", but a CLIENT build still
 * runs the manual-check flow on click — the same entry every other "check for
 * updates" affordance uses — so About and the sidebar account card cannot
 * diverge. The backend can't: it has no in-app download or ready step, so its
 * "update now" applies directly.
 */
function AboutUpdateCard({
  channel,
  checking,
  currentVersion,
  onCheck,
  showWebsite,
  target,
  u,
  view
}: AboutUpdateCardProps): ReactElement {
  const busy = checking || view.applying
  const canUpdate = view.updateAvailable && view.supported && !busy
  const channelLabel = channel ? ((u.channels as Record<string, string>)[channel] ?? channel) : null
  const statusLine = [view.error ?? view.line, channelLabel].filter(Boolean).join(' · ')

  const primaryLabel = checking
    ? u.checkingShort
    : canUpdate
      ? u.updateNow
      : view.applying
        ? u.installing
        : u.checkForUpdates

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-6 font-sans text-[length:var(--conversation-text-font-size)]">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[length:var(--conversation-text-font-size)] leading-(--conversation-line-height) font-medium text-foreground">
            {u.currentVersion}
            <span className="ml-1.5 text-[length:var(--conversation-caption-font-size)] font-normal text-muted-foreground">
              {currentVersion ? `v${shortVersion(currentVersion)}` : u.versionUnavailable}
            </span>
          </p>
          <p
            className={cn(
              'mt-1 whitespace-pre-line text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height)',
              view.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {statusLine}
          </p>
        </div>
        <Button
          className="min-w-24 shrink-0 rounded-[0.625rem] text-[length:var(--conversation-text-font-size)]"
          disabled={busy}
          // One path for a client build, whatever the label says: check → download
          // dialog → ready → "launch". Only the backend keeps its direct apply.
          onClick={() => (canUpdate && target === 'backend' ? startActiveUpdate(target) : onCheck())}
          size="lg"
          type="button"
          variant="outline"
        >
          {primaryLabel}
        </Button>
      </div>

      {showWebsite && (
        <div className="mt-6 flex items-center justify-between gap-4">
          {/* `aboutApp` + `aboutAppName`: the CJK pair needs no separator, so
              the space lives in the English prefix only. */}
          <p className="text-[length:var(--conversation-text-font-size)] leading-(--conversation-line-height) font-medium text-foreground">
            {u.aboutApp}
            <span className="text-muted-foreground">{u.aboutAppName}</span>
          </p>
          <Button asChild className="min-w-24 shrink-0 rounded-[0.625rem] text-[length:var(--conversation-text-font-size)]" size="lg" variant="outline">
            <a
              href={WEBSITE_URL}
              onClick={event => {
                event.preventDefault()
                void window.hermesDesktop?.openExternal?.(WEBSITE_URL)
              }}
              rel="noreferrer"
              target="_blank"
            >
              {u.goToWebsite}
              <ExternalLink className="size-3" />
            </a>
          </Button>
        </div>
      )}
    </div>
  )
}
