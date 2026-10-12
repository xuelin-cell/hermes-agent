import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { $uniWorkAuth } from '@/store/uniwork-auth'

import { AuthGate } from './auth-gate'

vi.mock('./login-page', () => ({ LoginPage: () => <p>UniWork login</p> }))

afterEach(() => {
  cleanup()
  delete window.document.documentElement.dataset.hermesBrowser
})

describe('AuthGate', () => {
  it('asks a signed-out desktop user to sign in', () => {
    $uniWorkAuth.set({ authenticated: false, user: null })

    render(<AuthGate>app</AuthGate>)

    expect(screen.getByText('UniWork login')).toBeTruthy()
    expect(screen.queryByText('app')).toBeNull()
  })

  it('lets the browser build straight in: the entry has signed the user in', () => {
    $uniWorkAuth.set({ authenticated: false, user: null })
    window.document.documentElement.dataset.hermesBrowser = 'production'

    render(<AuthGate>app</AuthGate>)

    expect(screen.getByText('app')).toBeTruthy()
    expect(screen.queryByText('UniWork login')).toBeNull()
  })
})
