import { describe, expect, it } from 'vitest'

import { settingsViewVisible } from './visibility'

describe('settingsViewVisible', () => {
  it('shows the developer pages only in developer mode', () => {
    expect(settingsViewVisible('gateway', false)).toBe(false)
    expect(settingsViewVisible('gateway', true)).toBe(true)
    // 普通用户在「模型」页管理模型；提供方的完整管理只在开发者模式。
    expect(settingsViewVisible('providers', false)).toBe(false)
    expect(settingsViewVisible('providers', true)).toBe(true)
    expect(settingsViewVisible('models', false)).toBe(true)
    expect(settingsViewVisible('keybinds', false)).toBe(false)
    expect(settingsViewVisible('keybinds', true)).toBe(true)
  })
})
