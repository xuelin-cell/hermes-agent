import { describe, expect, it } from 'vitest'

import type { Contribution } from '@/contrib/types'

import { CAPABILITY_SCOPE_AREA, hiddenScopeProfiles } from './scope-contrib'

function contribution(id: string, data: unknown): Contribution {
  return { area: CAPABILITY_SCOPE_AREA, data, id, source: 'plugin:test' } as Contribution
}

describe('插件托管、不在「正在配置」里出现的档案', () => {
  it('合并所有插件声明的档案，默认档案和无效的写法不算', () => {
    const hidden = hiddenScopeProfiles([
      contribution('a', { hideProfiles: ['fund-diagnostician', ' stock-diagnosis-expert '] }),
      contribution('b', { hideProfiles: ['default', '', 42, 'fund-diagnostician'] }),
      contribution('c', { hideProfiles: 'not-a-list' }),
      contribution('d', undefined)
    ])

    expect([...hidden].sort()).toEqual(['fund-diagnostician', 'stock-diagnosis-expert'])
  })
})
