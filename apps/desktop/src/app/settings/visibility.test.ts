import { afterEach, describe, expect, it } from 'vitest'

import { settingsViewVisible } from './visibility'

// UniWork's developer mode (store/developer-mode.ts), which the browser build follows.
const DEVELOPER_MODE_KEY = 'uniwork.desktop.developerMode.v1'

afterEach(() => {
  delete document.documentElement.dataset.hermesBrowser
  localStorage.removeItem(DEVELOPER_MODE_KEY)
})

describe('settingsViewVisible', () => {
  it('shows the developer pages only in developer mode', () => {
    expect(settingsViewVisible('gateway', false)).toBe(false)
    expect(settingsViewVisible('gateway', true)).toBe(true)
    expect(settingsViewVisible('providers', false)).toBe(true)
  })

  // The settings nav, the command palette's settings rows and its settings search all ask this:
  // a page the browser build hides from normal users must not be found through any of them.
  it('drops the pages the browser build hides, until developer mode is on', () => {
    document.documentElement.dataset.hermesBrowser = 'production'

    expect(['about', 'providers', 'vault'].map(view => settingsViewVisible(view, false))).toEqual([false, false, false])
    expect(settingsViewVisible('config:appearance', false)).toBe(true)

    localStorage.setItem(DEVELOPER_MODE_KEY, 'true')

    expect(['about', 'providers', 'vault'].map(view => settingsViewVisible(view, true))).toEqual([true, true, true])
  })
})
