import { describe, expect, it } from 'vitest'

import { KITS_HASH, openKitsPage } from './navigation'

describe('跳转到套件页', () => {
  it('把 hash 路由指向套件页', () => {
    window.location.hash = '#/'
    openKitsPage()
    expect(window.location.hash).toBe(KITS_HASH)
  })

  it('已经在套件页时不再改写 hash', () => {
    window.location.hash = KITS_HASH
    openKitsPage()
    expect(window.location.hash).toBe(KITS_HASH)
  })
})
