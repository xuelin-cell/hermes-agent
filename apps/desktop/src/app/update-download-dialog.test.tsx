import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DialogModule from '@/components/ui/dialog'

vi.mock('@/store/updates', async (): Promise<Record<string, unknown>> => {
  const { atom } = await import('nanostores')

  return {
    $updateApply: atom({
      applying: false,
      stage: 'idle',
      message: '',
      percent: null,
      error: null,
      command: null,
      log: []
    }),
    $updateDownloadFailure: atom<{ message: string | null; source: 'prepare' | 'apply' } | null>(null),
    $updateDownloadRetrying: atom(false),
    $updateOverlayOpen: atom(false),
    $updateReady: atom<{ version: string | null } | null>(null),
    dismissUpdateDownloadFailure: vi.fn(),
    dismissUpdateReady: vi.fn(),
    retryUpdateDownload: vi.fn(),
    startActiveUpdate: vi.fn()
  }
})

vi.mock('@/store/update-check', async (): Promise<Record<string, unknown>> => {
  const { atom } = await import('nanostores')

  return {
    $updateCheckDialog: atom<{ open: boolean; phase: 'checking'; message: string | null }>({
      open: false,
      phase: 'checking',
      message: null
    })
  }
})

// The dismissal guards are props on the dialog content, so the contract is
// asserted where it is declared. Driving Radix's real outside-interaction path
// in jsdom proves nothing: it never reaches the handler, so a "stays open"
// assertion would pass even with the guard removed.
const dialogProps = vi.hoisted((): { current: Record<string, unknown> | null } => ({ current: null }))

vi.mock('@/components/ui/dialog', async (importOriginal) => {
  const actual = await importOriginal<typeof DialogModule>()
  const ActualDialogContent = actual.DialogContent

  return {
    ...actual,
    DialogContent: (props: Parameters<typeof ActualDialogContent>[0]) => {
      dialogProps.current = props as unknown as Record<string, unknown>

      return <ActualDialogContent {...props} />
    }
  }
})

import { I18nProvider } from '@/i18n'
import { en } from '@/i18n/en'
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

import { UpdateDownloadDialog } from './update-download-dialog'

const idle = {
  applying: false,
  stage: 'idle' as const,
  message: '',
  percent: null,
  error: null,
  command: null,
  log: []
}

function renderDialog(): void {
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <UpdateDownloadDialog />
    </I18nProvider>
  )
}

beforeEach((): void => {
  dialogProps.current = null
  $updateApply.set(idle)
  $updateDownloadFailure.set(null)
  $updateDownloadRetrying.set(false)
  $updateOverlayOpen.set(false)
  $updateReady.set(null)
})

afterEach((): void => {
  cleanup()
  vi.clearAllMocks()
})

describe('download failure', (): void => {
  it('shows the reason and retries the transfer from the reference dialog', (): void => {
    $updateDownloadFailure.set({ message: 'blockmap mismatch', source: 'prepare' })

    renderDialog()

    expect(screen.getByText(en.updates.updateDialogTitle)).toBeTruthy()
    expect(screen.getByText(en.updates.downloadFailedTitle)).toBeTruthy()
    expect(screen.getByText('blockmap mismatch')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.updates.tryAgain }))

    expect(retryUpdateDownload).toHaveBeenCalledTimes(1)
  })

  it('closes through the dialog close button without retrying', (): void => {
    $updateDownloadFailure.set({ message: null, source: 'apply' })

    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: en.common.close }))

    expect(dismissUpdateDownloadFailure).toHaveBeenCalledTimes(1)
    expect(retryUpdateDownload).not.toHaveBeenCalled()
  })

  // Counterpart to the ready state's guard: a failure keeps the default
  // dismissal props, so "only an explicit close" is per-state, not global.
  it('leaves a failure dismissible from outside the dialog', (): void => {
    $updateDownloadFailure.set({ message: null, source: 'apply' })

    renderDialog()

    expect(dialogProps.current?.onEscapeKeyDown).toBeUndefined()
    expect(dialogProps.current?.onPointerDownOutside).toBeUndefined()
  })

  it('swaps to a downloading state while the retry is in flight', (): void => {
    $updateDownloadFailure.set({ message: 'boom', source: 'prepare' })
    $updateDownloadRetrying.set(true)

    renderDialog()

    expect(screen.getByText(en.updates.downloadingUpdate)).toBeTruthy()
    expect(screen.queryByText(en.updates.downloadFailedTitle)).toBeNull()
    expect(screen.queryByRole('button', { name: en.updates.tryAgain })).toBeNull()
    expect(screen.queryByRole('button', { name: en.common.close })).toBeNull()
  })
})

describe('version ready', (): void => {
  it('names the downloaded version and restarts straight into the install', (): void => {
    $updateReady.set({ version: '5.9.3' })

    renderDialog()

    expect(screen.getByText(en.updates.newVersionReadyBody('v5.9.3'))).toBeTruthy()
    // No release-notes detour: a downloaded package has exactly one action, and
    // it hands the swap to the installer.
    expect(screen.queryByRole('button', { name: en.updates.updateLog })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: en.updates.restartToUpdate }))
    expect(dismissUpdateReady).toHaveBeenCalledTimes(1)
    expect(startActiveUpdate).toHaveBeenCalledWith('client')

    fireEvent.click(screen.getByRole('button', { name: en.common.close }))
    expect(dismissUpdateReady).toHaveBeenCalledTimes(2)
  })

  // The decision is the user's, so the two reflexive dismissals are inert:
  // neither discards the verified package, but both look like "cancelled".
  it('blocks the scrim and Esc so the decision stays explicit', (): void => {
    $updateReady.set({ version: '5.9.3' })

    renderDialog()

    // Radix's own events are cancelable; without that flag preventDefault is a
    // no-op and the assertion would prove nothing.
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    const outside = new Event('pointerdown', { cancelable: true })
    const escapeHandler = dialogProps.current?.onEscapeKeyDown as ((event: Event) => void) | undefined
    const outsideHandler = dialogProps.current?.onPointerDownOutside as ((event: Event) => void) | undefined

    expect(typeof escapeHandler).toBe('function')
    expect(typeof outsideHandler).toBe('function')

    escapeHandler?.(escape)
    outsideHandler?.(outside)

    expect(escape.defaultPrevented).toBe(true)
    expect(outside.defaultPrevented).toBe(true)
  })

  it('closes through the explicit later action without installing', (): void => {
    $updateReady.set({ version: '5.9.3' })

    renderDialog()
    fireEvent.click(screen.getByRole('button', { name: en.updates.maybeLater }))

    expect(dismissUpdateReady).toHaveBeenCalledTimes(1)
    expect(startActiveUpdate).not.toHaveBeenCalled()
  })

  it('never shows a ready prompt while an install or the overlay is active', (): void => {
    $updateReady.set({ version: '5.9.3' })
    $updateApply.set({ ...idle, applying: true, stage: 'fetch' })

    const { unmount } = render(
      <I18nProvider configClient={null} initialLocale="en">
        <UpdateDownloadDialog />
      </I18nProvider>
    )

    expect(screen.queryByText(en.updates.newVersionReadyBody('v5.9.3'))).toBeNull()
    unmount()

    $updateApply.set(idle)
    $updateOverlayOpen.set(true)
    renderDialog()
    expect(screen.queryByText(en.updates.newVersionReadyBody('v5.9.3'))).toBeNull()
  })

  it('a failure always wins over a stale ready value', (): void => {
    $updateReady.set({ version: '5.9.3' })
    $updateDownloadFailure.set({ message: 'boom', source: 'apply' })

    renderDialog()

    expect(screen.getByText(en.updates.downloadFailedTitle)).toBeTruthy()
    expect(screen.queryByText(en.updates.newVersionReadyBody('v5.9.3'))).toBeNull()
  })
})
