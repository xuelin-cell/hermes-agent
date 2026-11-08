import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

// A downloaded package opens on its ready state — and nothing else. The
// installer must not run until the user clicks, so the dialog renders the
// launch action instead of handing the swap over by itself.
it('waits for the explicit launch click before installing a downloaded package', async (): Promise<void> => {
  const apply = vi.fn(() => new Promise<never>((): void => {}))
  window.hermesDesktop = { updates: { apply } } as unknown as Window['hermesDesktop']
  $updateStatus.set({ supported: true, updateAvailable: true, mechanism: 'electron-updater' } as never)
  $updateReady.set({ version: '0.10.0' })
  $updateOverlayOpen.set(true)

  await renderOverlay()

  expect(apply).not.toHaveBeenCalled()
  expect(screen.getByText(en.updates.newVersionReady)).toBeTruthy()
  expect(screen.getByText(en.updates.newVersionReadyBody('v0.10.0'))).toBeTruthy()
  // The install pitch is gone: the package needs no second confirmation, only
  // the decision to start it.
  expect(screen.queryByRole('button', { name: en.updates.updateNow })).toBeNull()
  expect(screen.getByRole('button', { name: en.updates.launchNow })).toBeTruthy()

  await act(async (): Promise<void> => {
    fireEvent.click(screen.getByRole('button', { name: en.updates.launchNow }))
  })

  expect(apply).toHaveBeenCalledTimes(1)
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
