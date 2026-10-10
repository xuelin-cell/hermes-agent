import { beforeEach, describe, expect, it } from 'vitest'

import { loadUniWorkAuth } from './uniwork-auth'

describe('UniWork auth persistence', () => {
  beforeEach(() => window.localStorage.clear())

  it('rejects an expired ISO timestamp from a restored login', () => {
    localStorage.setItem('auth_application', 'uniwork')
    localStorage.setItem('auth_token', 'expired-token')
    localStorage.setItem('user_info', JSON.stringify({ token: 'expired-token', expiresAt: '2020-01-01T00:00:00Z' }))

    expect(loadUniWorkAuth()).toEqual({ authenticated: false, user: null })
    expect(localStorage.getItem('auth_token')).toBeNull()
  })

  it('keeps a future ISO timestamp', () => {
    localStorage.setItem('auth_application', 'uniwork')
    localStorage.setItem('auth_token', 'valid-token')
    localStorage.setItem('user_info', JSON.stringify({ token: 'valid-token', expiresAt: '2999-01-01T00:00:00Z' }))

    expect(loadUniWorkAuth().authenticated).toBe(true)
  })
})
