import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopUpdateStatus } from '@/global'

vi.mock('@/store/updates', async (): Promise<Record<string, unknown>> => {
  const { atom } = await import('nanostores')

  return {
    $desktopVersion: atom(null),
    $updateChecking: atom<boolean>(false),
    $updateOverlayTarget: atom<'client' | 'backend'>('client'),
    $updateStatus: atom<DesktopUpdateStatus | null>(null),
    checkUpdates: vi.fn<() => Promise<DesktopUpdateStatus | null>>(),
    isClientUpdateRunning: vi.fn<() => boolean>().mockReturnValue(false),
    refreshDesktopVersion: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
    setUpdateOverlayOpen: vi.fn(),
    startClientUpdateDownload: vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
  }
})

import {
  $updateChecking,
  $updateOverlayTarget,
  $updateStatus,
  checkUpdates,
  isClientUpdateRunning,
  setUpdateOverlayOpen,
  startClientUpdateDownload
} from '@/store/updates'

import { $updateCheckDialog, closeUpdateCheckDialog, requestUpdateCheck } from './update-check'

const LATEST: DesktopUpdateStatus = { supported: true, behind: 0, updateAvailable: false }

describe('requestUpdateCheck', (): void => {
  beforeEach((): void => {
    vi.clearAllMocks()
    vi.mocked(isClientUpdateRunning).mockReturnValue(false)
    vi.mocked(startClientUpdateDownload).mockResolvedValue(undefined)
    closeUpdateCheckDialog()
    $updateChecking.set(false)
    $updateOverlayTarget.set('client')
    $updateStatus.set(null)
  })

  it('opens the dialog on "already latest" and leaves the update overlay alone', async (): Promise<void> => {
    vi.mocked(checkUpdates).mockResolvedValue(LATEST)

    await requestUpdateCheck()

    expect(checkUpdates).toHaveBeenCalledWith({ force: true })
    expect($updateCheckDialog.get()).toEqual({ open: true, phase: 'latest', message: null })
    expect(setUpdateOverlayOpen).not.toHaveBeenCalled()
    expect(startClientUpdateDownload).not.toHaveBeenCalled()
  })

  it('hands an available update to the download dialog, not the check dialog', async (): Promise<void> => {
    vi.mocked(checkUpdates).mockResolvedValue({ supported: true, behind: 3 })

    await requestUpdateCheck()

    expect($updateCheckDialog.get().open).toBe(false)
    expect($updateOverlayTarget.get()).toBe('client')
    // One shared entry into the overlay's download step — the same call the
    // About page reaches through the account card.
    expect(startClientUpdateDownload).toHaveBeenCalledTimes(1)
  })

  it('reopens the download dialog instead of checking again while a transfer runs', async (): Promise<void> => {
    vi.mocked(isClientUpdateRunning).mockReturnValue(true)

    await requestUpdateCheck()

    expect(checkUpdates).not.toHaveBeenCalled()
    expect(startClientUpdateDownload).not.toHaveBeenCalled()
    expect(setUpdateOverlayOpen).toHaveBeenCalledWith(true)
  })

  it('reports a failed check with the reason it carries', async (): Promise<void> => {
    vi.mocked(checkUpdates).mockResolvedValue({ supported: true, error: 'check-failed', message: 'Rate limited' })

    await requestUpdateCheck()

    expect($updateCheckDialog.get()).toEqual({ open: true, phase: 'error', message: 'Rate limited' })
    expect(setUpdateOverlayOpen).not.toHaveBeenCalled()
    expect(startClientUpdateDownload).not.toHaveBeenCalled()
  })

  it('waits for an in-flight passive check before asking again', async (): Promise<void> => {
    $updateChecking.set(true)
    vi.mocked(checkUpdates).mockResolvedValue(LATEST)

    const pending = requestUpdateCheck()

    expect(checkUpdates).not.toHaveBeenCalled()

    $updateChecking.set(false)
    await pending

    expect(checkUpdates).toHaveBeenCalledTimes(1)
    expect($updateCheckDialog.get().phase).toBe('latest')
  })
})
