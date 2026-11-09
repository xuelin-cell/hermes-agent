import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { DesktopVersionInfo } from '@/global'
import { I18nProvider } from '@/i18n'

vi.mock('@/store/updates', async (): Promise<Record<string, unknown>> => {
  const { atom } = await import('nanostores')

  return {
    $desktopVersion: atom<DesktopVersionInfo | null>(null),
    $updateChecking: atom(false),
    $updateOverlayTarget: atom('client'),
    $updateStatus: atom(null),
    checkUpdates: vi.fn(),
    refreshDesktopVersion: vi.fn().mockResolvedValue(null),
    setUpdateOverlayOpen: vi.fn()
  }
})

import { $desktopVersion } from '@/store/updates'
import { $updateCheckDialog, closeUpdateCheckDialog } from '@/store/update-check'

import { UpdateCheckDialog } from './update-check-dialog'

function renderDialog(): void {
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <UpdateCheckDialog />
    </I18nProvider>
  )
}

describe('UpdateCheckDialog', (): void => {
  beforeEach((): void => {
    closeUpdateCheckDialog()
    $desktopVersion.set({
      appVersion: 'v5.9.3',
      electronVersion: '40',
      nodeVersion: '26',
      platform: 'win32',
      hermesRoot: '/test/hermes'
    })
  })

  afterEach((): void => {
    cleanup()
  })

  it('names the running version and the "already latest" verdict', (): void => {
    $updateCheckDialog.set({ open: true, phase: 'latest', message: null })
    renderDialog()

    expect(screen.getByText('软件更新')).toBeTruthy()
    expect(screen.getByText(/UniWork 5\.9\.3/).textContent).toContain('已是最高版本')
    expect(screen.getByRole('button', { name: '我知道啦' })).toBeTruthy()
  })

  it('closes from the "got it" button', (): void => {
    $updateCheckDialog.set({ open: true, phase: 'latest', message: null })
    renderDialog()

    fireEvent.click(screen.getByRole('button', { name: '我知道啦' }))

    expect($updateCheckDialog.get().open).toBe(false)
  })

  it('shows the failure reason with a retry action', (): void => {
    $updateCheckDialog.set({ open: true, phase: 'error', message: '网络不可用' })
    renderDialog()

    expect(screen.getByText('网络不可用')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy()
  })

  it('shows only progress while the check is running', (): void => {
    $updateCheckDialog.set({ open: true, phase: 'checking', message: null })
    renderDialog()

    expect(screen.getByText('正在检查更新…')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '我知道啦' })).toBeNull()
  })
})
