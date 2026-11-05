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
    refreshDesktopVersion: vi.fn<() => Promise<unknown>>().mockResolvedValue(null),
    setUpdateOverlayOpen: vi.fn()
  }
})

import {
  $updateChecking,
  $updateOverlayTarget,
  $updateStatus,
  checkUpdates,
  setUpdateOverlayOpen
} from '@/store/updates'

import { $updateCheckDialog, closeUpdateCheckDialog, requestUpdateCheck } from './update-check'

const LATEST: DesktopUpdateStatus = { supported: true, behind: 0, updateAvailable: false }

describe('requestUpdateCheck', (): void => {
  beforeEach((): void => {
    vi.clearAllMocks()
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
  })

  it('hands an available update to the updates overlay instead of the dialog', async (): Promise<void> => {
    vi.mocked(checkUpdates).mockResolvedValue({ supported: true, behind: 3 })

    await requestUpdateCheck()

    expect($updateCheckDialog.get().open).toBe(false)
    expect($updateOverlayTarget.get()).toBe('client')
    expect(setUpdateOverlayOpen).toHaveBeenCalledWith(true)
  })

  it('reports a failed check with the reason it carries', async (): Promise<void> => {
    vi.mocked(checkUpdates).mockResolvedValue({ supported: true, error: 'check-failed', message: 'Rate limited' })

    await requestUpdateCheck()

    expect($updateCheckDialog.get()).toEqual({ open: true, phase: 'error', message: 'Rate limited' })
    expect(setUpdateOverlayOpen).not.toHaveBeenCalled()
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
