import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $developerMode, setDeveloperMode, toggleDeveloperMode } from './developer-mode'

const KEY = 'uniwork.desktop.developerMode.v1'
const BROWSER_KEY = 'hermes.mt.developer'

describe('developer mode store', () => {
  beforeEach(() => {
    setDeveloperMode(false)
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
})

describe('developer mode in the browser build', () => {
  async function loadInBrowserBuild() {
    document.documentElement.dataset.hermesBrowser = 'production'
    vi.resetModules()

    return import('./developer-mode')
  }

  afterEach(() => {
    delete document.documentElement.dataset.hermesBrowser
    window.localStorage.removeItem(KEY)
    window.localStorage.removeItem(BROWSER_KEY)
  })

  it('follows the entry badge’s developer mode, which only the badge toggles', async () => {
    window.localStorage.setItem(KEY, 'false')
    window.localStorage.setItem(BROWSER_KEY, '1')

    const store = await loadInBrowserBuild()

    expect(store.$developerMode.get()).toBe(true)
    expect(store.toggleDeveloperMode()).toBe(true)
    expect(store.$developerMode.get()).toBe(true)
    expect(window.localStorage.getItem(BROWSER_KEY)).toBe('1')
  })

  it('stays off for regular users, whatever the desktop switch says', async () => {
    window.localStorage.setItem(KEY, 'true')

    const store = await loadInBrowserBuild()

    expect(store.$developerMode.get()).toBe(false)
    expect(store.toggleDeveloperMode()).toBe(false)
    expect(store.$developerMode.get()).toBe(false)
    expect(window.localStorage.getItem(BROWSER_KEY)).toBeNull()
  })
})
