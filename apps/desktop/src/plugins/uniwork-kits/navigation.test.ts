import { describe, expect, it } from 'vitest'

import { KITS_HASH, openKitsPage } from './navigation'

describe('kits page navigation', () => {
  it('points the hash router at the kits page', () => {
    window.location.hash = '#/'
    openKitsPage()
    expect(window.location.hash).toBe(KITS_HASH)
  })

  it('does not rewrite the hash when the kits page is already open', () => {
    window.location.hash = KITS_HASH
    openKitsPage()
    expect(window.location.hash).toBe(KITS_HASH)
  })
})
