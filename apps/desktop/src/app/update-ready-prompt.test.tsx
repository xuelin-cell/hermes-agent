import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

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
    $updateReady: atom<{ version: string | null } | null>(null),
    dismissUpdateReady: vi.fn(),
    openUpdateOverlayFor: vi.fn(),
    startActiveUpdate: vi.fn()
  }
})

import { $updateApply, $updateReady, dismissUpdateReady, openUpdateOverlayFor, startActiveUpdate } from '@/store/updates'

import { UpdateReadyPrompt } from './update-ready-prompt'

function renderPrompt(): void {
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <UpdateReadyPrompt />
    </I18nProvider>
  )
}

describe('UpdateReadyPrompt', (): void => {
  beforeEach((): void => {
    $updateReady.set(null)
    $updateApply.set({
      applying: false,
      stage: 'idle',
      message: '',
      percent: null,
      error: null,
      command: null,
      log: []
    })
  })

  afterEach((): void => {
    cleanup()
    vi.clearAllMocks()
  })

  it('stays hidden until the download finished', (): void => {
    renderPrompt()

    expect(screen.queryByText('新版本就绪')).toBeNull()
  })

  it('shows the three operations once the update is ready', (): void => {
    $updateReady.set({ version: '1.2.4' })
    renderPrompt()

    expect(screen.getByText('新版本就绪')).toBeTruthy()
    expect(screen.getByRole('button', { name: '更新日志' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '重启升级' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '关闭' })).toBeTruthy()
  })

  it('hides itself while an install is running', (): void => {
    $updateReady.set({ version: '1.2.4' })
    $updateApply.set({
      applying: true,
      stage: 'fetch',
      message: '',
      percent: 30,
      error: null,
      command: null,
      log: []
    })
    renderPrompt()

    expect(screen.queryByText('新版本就绪')).toBeNull()
  })

  it('opens the release notes for the log action', (): void => {
    $updateReady.set({ version: '1.2.4' })
    renderPrompt()

    fireEvent.click(screen.getByRole('button', { name: '更新日志' }))

    expect(openUpdateOverlayFor).toHaveBeenCalledWith('client')
    expect(dismissUpdateReady).not.toHaveBeenCalled()
  })

  it('dismisses and starts the existing apply flow from the restart action', (): void => {
    $updateReady.set({ version: '1.2.4' })
    renderPrompt()

    fireEvent.click(screen.getByRole('button', { name: '重启升级' }))

    expect(dismissUpdateReady).toHaveBeenCalledTimes(1)
    expect(startActiveUpdate).toHaveBeenCalledWith('client')
  })

  it('only dismisses from the close button', (): void => {
    $updateReady.set({ version: '1.2.4' })
    renderPrompt()

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    expect(dismissUpdateReady).toHaveBeenCalledTimes(1)
    expect(startActiveUpdate).not.toHaveBeenCalled()
    expect(openUpdateOverlayFor).not.toHaveBeenCalled()
  })
})
