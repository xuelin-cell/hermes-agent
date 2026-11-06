import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    openUpdateOverlayFor: vi.fn(),
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
  openUpdateOverlayFor,
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
  it('names the downloaded version and offers notes, restart, and close', (): void => {
    $updateReady.set({ version: '5.9.3' })

    renderDialog()

    expect(screen.getByText(en.updates.newVersionReadyBody('v5.9.3'))).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: en.updates.updateLog }))
    expect(dismissUpdateReady).toHaveBeenCalledTimes(1)
    expect(openUpdateOverlayFor).toHaveBeenCalledWith('client')

    fireEvent.click(screen.getByRole('button', { name: en.updates.restartToUpdate }))
    expect(dismissUpdateReady).toHaveBeenCalledTimes(2)
    expect(startActiveUpdate).toHaveBeenCalledWith('client')

    fireEvent.click(screen.getByRole('button', { name: en.common.close }))
    expect(dismissUpdateReady).toHaveBeenCalledTimes(3)
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
