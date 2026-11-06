import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { en } from '@/i18n/en'
import {
  $updateApply,
  $updateOverlayOpen,
  $updateOverlayTarget,
  $updateStatus,
  resetUpdateApplyState,
  type UpdateApplyState
} from '@/store/updates'

import { UpdatesOverlay } from './updates-overlay'

function applyState(patch: Partial<UpdateApplyState>): UpdateApplyState {
  return {
    applying: true,
    stage: 'fetch',
    message: '',
    percent: 42,
    error: null,
    command: null,
    log: [],
    ...patch
  }
}

async function renderOverlay(): Promise<void> {
  $updateOverlayTarget.set('client')
  $updateStatus.set({ supported: true, updateAvailable: true } as never)
  $updateOverlayOpen.set(true)

  await act(async (): Promise<void> => {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <UpdatesOverlay />
      </I18nProvider>
    )
  })
}

afterEach((): void => {
  cleanup()
  $updateOverlayOpen.set(false)
  $updateStatus.set(null)
  resetUpdateApplyState()
  Reflect.deleteProperty(window, 'hermesDesktop')
  vi.restoreAllMocks()
})

// The reference dialog puts one dismissible action on the download state.
// Cancel really stops the transfer: it asks the main process to abort the
// download and only clears the dialog once that abort is confirmed.
it('cancels the download through the main process and clears the dialog', async (): Promise<void> => {
  const cancel = vi.fn(async (): Promise<{ cancelled: boolean }> => ({ cancelled: true }))
  window.hermesDesktop = { updates: { cancel } } as unknown as Window['hermesDesktop']
  $updateApply.set(applyState({ stage: 'fetch', percent: 42 }))

  await renderOverlay()

  expect(screen.getByText(en.updates.updateDialogTitle)).toBeTruthy()
  expect(screen.getByText(en.updates.downloadingUpdate)).toBeTruthy()
  expect(screen.getByRole('button', { name: en.common.close })).toBeTruthy()

  await act(async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: en.common.cancel }))
  })

  expect(cancel).toHaveBeenCalledTimes(1)
  expect($updateOverlayOpen.get()).toBe(false)
  expect($updateApply.get().applying).toBe(false)
})

// Once the installer owns the window there is nothing to cancel — the footer
// carries the close warning instead of an action, and the X is gone too.
it('locks the dialog once the installer takes over', async (): Promise<void> => {
  $updateApply.set(applyState({ stage: 'restart', percent: null }))

  await renderOverlay()

  expect(screen.getByText(en.updates.applyingClose)).toBeTruthy()
  expect(screen.queryByRole('button', { name: en.common.cancel })).toBeNull()
  expect(screen.queryByRole('button', { name: en.common.close })).toBeNull()
})
