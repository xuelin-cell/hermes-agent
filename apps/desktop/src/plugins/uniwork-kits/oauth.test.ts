import { describe, expect, it } from 'vitest'

import { oauthStartParams } from './oauth'

describe('kit oauth params', () => {
  it('names the mcp server and the expert profile', () => {
    expect(oauthStartParams('lighthouse-ops--cloud', 'lighthouse-ops')).toEqual({
      name: 'lighthouse-ops--cloud',
      profile: 'lighthouse-ops'
    })
  })

  it('omits profile for a kit on the current home', () => {
    expect(oauthStartParams('demo--remote')).toEqual({ name: 'demo--remote' })
  })
})
