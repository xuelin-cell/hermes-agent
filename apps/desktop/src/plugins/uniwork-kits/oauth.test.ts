import { describe, expect, it } from 'vitest'

import { oauthStartParams } from './oauth'

describe('套件授权的请求参数', () => {
  it('写明 MCP 名字和专家所在的档案', () => {
    expect(oauthStartParams('lighthouse-ops--cloud', 'lighthouse-ops')).toEqual({
      name: 'lighthouse-ops--cloud',
      profile: 'lighthouse-ops'
    })
  })

  it('当前档案里的套件不带 profile', () => {
    expect(oauthStartParams('demo--remote')).toEqual({ name: 'demo--remote' })
  })
})
