import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'
import { en } from '@/i18n/en'
import {
  $updateOverlayOpen,
  $updateOverlayTarget,
  $updateReady,
  $updateStatus,
  resetUpdateApplyState
} from '@/store/updates'

import { UpdatesOverlay } from './updates-overlay'

async function renderOverlay(): Promise<void> {
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
  $updateOverlayTarget.set('client')
  $updateStatus.set(null)
  $updateReady.set(null)
  resetUpdateApplyState()
  Reflect.deleteProperty(window, 'hermesDesktop')
  vi.restoreAllMocks()
})

// A package already on disk must not be confirmed twice. The ready prompt's
// "restart" IS the install, so a surface that opens on that state hands the
// swap over instead of rendering "update available / update now / later" again.
it('hands a downloaded package straight to the installer', async (): Promise<void> => {
  const apply = vi.fn(() => new Promise<never>((): void => {}))
  window.hermesDesktop = { updates: { apply } } as unknown as Window['hermesDesktop']
  $updateStatus.set({ supported: true, updateAvailable: true, mechanism: 'electron-updater' } as never)
  $updateReady.set({ version: '0.10.0' })
  $updateOverlayOpen.set(true)

  await renderOverlay()

  expect(apply).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: en.updates.updateNow })).toBeNull()
  expect(screen.queryByRole('button', { name: en.updates.maybeLater })).toBeNull()
  // What remains is the install surface itself, not another confirmation.
  expect(screen.getByText(en.updates.updateDialogTitle)).toBeTruthy()
})

// The pitch is still the only way to start an install that has not finished
// downloading; removing it would make opening the overlay install silently.
it('keeps the explicit start action while the package is still downloading', async (): Promise<void> => {
  const apply = vi.fn()
  window.hermesDesktop = { updates: { apply } } as unknown as Window['hermesDesktop']
  $updateStatus.set({ supported: true, updateAvailable: true, mechanism: 'electron-updater' } as never)
  $updateOverlayOpen.set(true)

  await renderOverlay()

  expect(apply).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: en.updates.updateNow })).toBeTruthy()
})
