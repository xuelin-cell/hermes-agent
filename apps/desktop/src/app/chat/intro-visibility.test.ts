import { describe, expect, it } from 'vitest'

import { shouldShowIntro } from './intro-visibility'

const showing = {
  activeSessionId: null,
  auxiliaryWindow: false,
  enabled: true,
  freshDraftReady: true,
  messagesEmpty: true,
  primary: true,
  routedSessionView: false,
  selectedSessionId: null
} as const

describe('shouldShowIntro', () => {
  it('shows on a fresh draft in the primary window', () => {
    expect(shouldShowIntro(showing)).toBe(true)
  })

  it('hides when the Appearance toggle is off', () => {
    expect(shouldShowIntro({ ...showing, enabled: false })).toBe(false)
  })

  it('keeps the toggle authoritative over every other clause', () => {
    // Off means off: no window, session, or draft state re-enables the splash.
    const inputs = [
      { ...showing, auxiliaryWindow: true, enabled: false },
      { ...showing, enabled: false, freshDraftReady: false },
      { ...showing, enabled: false, primary: false },
      { ...showing, enabled: false, messagesEmpty: false }
    ]

    for (const input of inputs) {
      expect(shouldShowIntro(input)).toBe(false)
    }
  })

  it('hides on surfaces that are not an empty primary draft', () => {
    expect(shouldShowIntro({ ...showing, primary: false })).toBe(false)
    expect(shouldShowIntro({ ...showing, auxiliaryWindow: true })).toBe(false)
    expect(shouldShowIntro({ ...showing, freshDraftReady: false })).toBe(false)
    expect(shouldShowIntro({ ...showing, routedSessionView: true })).toBe(false)
    expect(shouldShowIntro({ ...showing, selectedSessionId: 'session-1' })).toBe(false)
    expect(shouldShowIntro({ ...showing, messagesEmpty: false })).toBe(false)
  })

  it('hides the general splash on a draft a caller opened quietly', () => {
    expect(shouldShowIntro({ ...showing, quietDraft: true })).toBe(false)
  })

  it('shows ready empty sessions created in the primary view, tabs and splits', () => {
    for (const primary of [true, false]) {
      expect(shouldShowIntro({
        ...showing, primary, freshDraftReady: false, activeSessionId: 'runtime-1',
        selectedSessionId: 'stored-1', routedSessionView: true
      })).toBe(true)
    }
  })

  it('hides ready-session welcomes during loading, execution or historical hydration', () => {
    const session = { ...showing, primary: false, activeSessionId: 'runtime-1', selectedSessionId: 'stored-1' }
    for (const blocked of [{ loading: true }, { hasHistory: true }, { running: true }, { messagesEmpty: false }]) {
      expect(shouldShowIntro({ ...session, ...blocked })).toBe(false)
    }
  })
})
