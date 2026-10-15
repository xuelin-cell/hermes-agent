import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as BrowserShell from '@/lib/browser-shell'
import { isDeveloperMode, reloadAfterDeveloperModeToggle } from '@/lib/browser-shell'

import { $developerMode, setDeveloperMode, toggleDeveloperMode } from './developer-mode'

vi.mock('@/lib/browser-shell', async importOriginal => ({
  ...(await importOriginal<typeof BrowserShell>()),
  reloadAfterDeveloperModeToggle: vi.fn()
}))

const KEY = 'uniwork.desktop.developerMode.v1'

describe('developer mode store', () => {
  beforeEach(() => {
    setDeveloperMode(false)
    vi.mocked(reloadAfterDeveloperModeToggle).mockClear()
  })

  it('toggles on and persists the state', () => {
    expect(toggleDeveloperMode()).toBe(true)
    expect($developerMode.get()).toBe(true)
    expect(window.localStorage.getItem(KEY)).toBe('true')
  })

  it('toggles off and persists the state', () => {
    setDeveloperMode(true)

    expect(toggleDeveloperMode()).toBe(false)
    expect($developerMode.get()).toBe(false)
    expect(window.localStorage.getItem(KEY)).toBe('false')
  })

  // Browser build (lib/browser-shell): what it hides from regular users follows
  // this same switch, and the page starts over whenever it flips.
  it('is the switch the browser build hides things by, and each flip asks for a fresh page', () => {
    expect(isDeveloperMode()).toBe(false)

    toggleDeveloperMode()

    expect(isDeveloperMode()).toBe(true)
    expect(reloadAfterDeveloperModeToggle).toHaveBeenCalledTimes(1)

    toggleDeveloperMode()

    expect(isDeveloperMode()).toBe(false)
    expect(reloadAfterDeveloperModeToggle).toHaveBeenCalledTimes(2)
  })
})
