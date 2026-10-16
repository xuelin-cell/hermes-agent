import { describe, expect, it } from 'vitest'

import { expertForProfile, openingPrompt, pickerGroups, quickPrompts } from './summon-model'
import type { ExpertCard, ExpertDirectory } from './types'

function card(name: string, extra: Partial<ExpertCard> = {}): ExpertCard {
  return {
    name,
    profile: name,
    display_name: name,
    profession: '',
    description: '',
    init_prompt: '',
    quick_prompts: [],
    tags: [],
    ...extra
  }
}

describe('summon picker', () => {
  const directory: ExpertDirectory = {
    experts: [card('b', { display_name: '乙' }), card('a', { display_name: '甲' }), card('c', { display_name: '丙' })],
    recent: ['c', 'gone', 'a']
  }

  it('puts the recently summoned first, newest first, and skips uninstalled names', () => {
    const { recent, rest } = pickerGroups(directory)

    expect(recent.map(expert => expert.name)).toEqual(['c', 'a'])
    expect(rest.map(expert => expert.name)).toEqual(['b'])
  })

  it('finds the expert a chat belongs to by its profile, and nothing for ordinary profiles', () => {
    expect(expertForProfile(directory, 'a')?.display_name).toBe('甲')
    expect(expertForProfile(directory, 'default')).toBeNull()
    expect(expertForProfile(directory, '')).toBeNull()
  })
})

describe('summon prompts', () => {
  it('fills the opening prompt and leaves the box empty when the package has none', () => {
    expect(openingPrompt(card('x', { init_prompt: ' 帮我写一份首次覆盖报告 ' }))).toBe('帮我写一份首次覆盖报告')
    expect(openingPrompt(card('x'))).toBe('')
  })

  it('offers quick prompts, the opening prompt first when the list lacks it', () => {
    const expert = card('x', { init_prompt: '开场', quick_prompts: ['一', '二', '三'] })

    expect(quickPrompts(expert)).toEqual(['开场', '一', '二'])
    expect(quickPrompts(card('y', { init_prompt: '一', quick_prompts: ['一', '二'] }))).toEqual(['一', '二'])
  })
})
