import { describe, expect, it } from 'vitest'

import { expertForProfile, openingPrompt, pickerGroups, searchExperts, tryAskingPrompts } from './summon-model'
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
    try_asking: '',
    tags: [],
    ...extra
  }
}

describe('召唤列表', () => {
  const directory: ExpertDirectory = {
    experts: [card('b', { display_name: '乙' }), card('a', { display_name: '甲' }), card('c', { display_name: '丙' })],
    recent: ['c', 'gone', 'a']
  }

  it('最近召唤的排前面，最新的在最前，跳过已卸载的', () => {
    const { recent, rest } = pickerGroups(directory)

    expect(recent.map(expert => expert.name)).toEqual(['c', 'a'])
    expect(rest.map(expert => expert.name)).toEqual(['b'])
  })

  it('按名字、职业或介绍搜索全部专家，空白搜索词不出结果', () => {
    const found = searchExperts(
      {
        experts: [
          card('fund', { display_name: '基金诊断专家', profession: '东方财富妙想', description: '看一只基金' }),
          card('xhs', { display_name: '小红书运营专家', description: '写笔记' })
        ],
        recent: []
      },
      ' 基金 '
    )

    expect(found.map(expert => expert.name)).toEqual(['fund'])
    expect(searchExperts(directory, '   ')).toEqual([])
  })

  it('按档案找出会话所属的专家，普通档案找不到', () => {
    expect(expertForProfile(directory, 'a')?.display_name).toBe('甲')
    expect(expertForProfile(directory, 'default')).toBeNull()
    expect(expertForProfile(directory, '')).toBeNull()
  })
})

describe('召唤后的提示语', () => {
  it('填入开场白，包里没有开场白时输入框留空', () => {
    expect(openingPrompt(card('x', { init_prompt: ' 帮我写一份首次覆盖报告 ' }))).toBe('帮我写一份首次覆盖报告')
    expect(openingPrompt(card('x'))).toBe('')
  })

  it('「试试这样问」只放宿主写的那一条，不用专家包的短问法，和开场白相同时不放', () => {
    const expert = card('x', { init_prompt: '开场', quick_prompts: ['一', '二', '三'], try_asking: ' 另一份完整需求 ' })

    expect(tryAskingPrompts(expert)).toEqual(['另一份完整需求'])
    expect(tryAskingPrompts(card('y', { init_prompt: '一', quick_prompts: ['一', '二'] }))).toEqual([])
    expect(tryAskingPrompts(card('z', { init_prompt: '同一句', try_asking: '同一句' }))).toEqual([])
  })

  it('旧版后端的名单没有「试试这样问」字段时不出错，只是不显示', () => {
    const legacy = { ...card('old', { init_prompt: '开场' }), try_asking: undefined } as unknown as ExpertCard

    expect(tryAskingPrompts(legacy)).toEqual([])
  })
})
