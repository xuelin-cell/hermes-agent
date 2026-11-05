import { beforeEach, describe, expect, it } from 'vitest'

import { $developerMode, setDeveloperMode, toggleDeveloperMode } from './developer-mode'

const KEY = 'uniwork.desktop.developerMode.v1'

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
