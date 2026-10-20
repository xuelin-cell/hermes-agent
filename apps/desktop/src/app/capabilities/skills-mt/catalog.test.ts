import { describe, expect, it } from 'vitest'

import type { SkillInfo } from '@/types/hermes'

import {
  canUninstall,
  exampleKeyFor,
  filterCatalog,
  filterInstalled,
  installedBadge,
  installedCounts,
  skillColor,
  skillInitials,
  skillSlug,
  tryPrompt,
  usableIconUrl
} from './catalog'

const skill = (name: string, enabled: boolean, provenance?: SkillInfo['provenance'], description = ''): SkillInfo => ({
  category: 'general',
  description,
  enabled,
  name,
  provenance
})

describe('skill tiles', () => {
  it('takes the English name in brackets and two initials, or the first CJK character', () => {
    expect(skillSlug('iPhone Duo 优先购（chinaunicomvsensiphoneduo）')).toBe('chinaunicomvsensiphoneduo')
    expect(skillInitials('iPhone Duo 优先购（chinaunicomvsensiphoneduo）')).toBe('CH')
    expect(skillInitials('A股数据查询（akshare-stock）')).toBe('AS')
    expect(skillInitials('密码管家（1password）')).toBe('1P')
    expect(skillInitials('law-skills')).toBe('LS')
    expect(skillInitials('自选股管理')).toBe('自')
  })

  it('keeps one color per skill and only trusts https or inline image icons', () => {
    expect(skillColor('law-skills')).toBe(skillColor('law-skills'))
    expect(usableIconUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png')
    expect(usableIconUrl('http://cdn.example.com/a.png')).toBeNull()
    expect(usableIconUrl('/uniwork/icon.png')).toBeNull()
    expect(usableIconUrl(undefined)).toBeNull()
  })
})

describe('installed skills', () => {
  const list = [
    skill('b-tool', true, 'bundled', 'makes slides'),
    skill('a-tool', false, 'hub'),
    skill('c', true, 'agent')
  ]

  it('badges by source and only lets market installs be uninstalled', () => {
    expect(list.map(installedBadge)).toEqual(['bundled', 'market', 'agent'])
    expect(list.map(canUninstall)).toEqual([false, true, false])
    expect(installedBadge(skill('x', true))).toBe('bundled')
  })

  it('counts and filters by state and search, sorted by name', () => {
    expect(installedCounts(list)).toEqual({ all: 3, enabled: 2, disabled: 1 })
    expect(filterInstalled(list, 'all', '').map(s => s.name)).toEqual(['a-tool', 'b-tool', 'c'])
    expect(filterInstalled(list, 'enabled', '').map(s => s.name)).toEqual(['b-tool', 'c'])
    expect(filterInstalled(list, 'disabled', '').map(s => s.name)).toEqual(['a-tool'])
    expect(filterInstalled(list, 'all', 'SLIDES').map(s => s.name)).toEqual(['b-tool'])
  })
})

describe('catalog filter', () => {
  const items = [
    { category: 'AI Agent', description: 'tasks', name: 'Autotask', provider: 'SkillHub' },
    { category: 'ai', category_id: '7', description: '法律', name: 'law-skills', provider: '马常成律师' }
  ]

  it('matches category by name or id and searches name, description and provider', () => {
    expect(filterCatalog(items, 'all', '').length).toBe(2)
    expect(filterCatalog(items, 'AI Agent', '').map(s => s.name)).toEqual(['Autotask'])
    expect(filterCatalog(items, '7', '').map(s => s.name)).toEqual(['law-skills'])
    expect(filterCatalog(items, 'all', '律师').map(s => s.name)).toEqual(['law-skills'])
  })
})

describe('try-it prompt', () => {
  const examples = (key: string, name: string) => `${key}:${name}`

  it('prefers the skill guide, then keywords, then the market category, then the fallback', () => {
    expect(tryPrompt({ name: 'Autotask' }, examples, '  帮我设置一个自动化任务  ')).toBe('帮我设置一个自动化任务')
    expect(tryPrompt({ name: 'uniai-ppt', description: '生成演示文稿' }, examples)).toBe('ppt:uniai-ppt')
    expect(tryPrompt({ category: 'security', name: 'zzz' }, examples)).toBe('cat_security:zzz')
    expect(tryPrompt({ name: 'zzz' }, examples)).toBe('fallback:zzz')
  })

  it('checks keyword groups in order', () => {
    expect(exampleKeyFor('PDF 报告 表格')).toBe('excel')
    expect(exampleKeyFor('股票 行情')).toBe('stock')
    expect(exampleKeyFor('nothing here', 'unknown')).toBe('fallback')
  })
})
