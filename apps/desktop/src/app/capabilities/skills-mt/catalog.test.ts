import { describe, expect, it } from 'vitest'

import type { SkillInfo } from '@/types/hermes'

import {
  canUninstall,
  catalogNameGuesses,
  exampleKeyFor,
  filterCatalog,
  filterInstalled,
  installedBadge,
  installedCounts,
  isCatalogInstalled,
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

describe('catalog installed state', () => {
  // 真实目录数据的样子：市场 id 是短名、显示名「中文（短名）」；推荐 id 是 UUID、带包名。
  const market = (id: string, name = `显示名（${id}）`) => ({ id, name, download_url: `https://x/${id}.zip` })

  const recommended = (packageFile: string, name = '中文显示名') => ({
    id: '04267514-133a-4e19-ad44-cf492b158c6e',
    name,
    package_download_path: '/uniwork/skills/04267514-133a-4e19-ad44-cf492b158c6e/package',
    package_file_name: packageFile
  })

  const installed = (...names: string[]) => new Set(names)

  it('trusts the install record over the display name, and only while that skill is still installed', () => {
    const entry = market('apple-mail-search-safe', '苹果邮件搜索（apple-mail-search-safe）')

    expect(isCatalogInstalled(entry, installed('apple-mail-search'), 'apple-mail-search')).toBe(true)
    // 卸载后记录可能还在一会儿：名字不在已安装列表里就是「+」，也不再退回去猜。
    expect(isCatalogInstalled(entry, installed('apple-mail-search-safe'), 'apple-mail-search')).toBe(false)
  })

  it('guesses a market entry by its id, never by the name in brackets', () => {
    expect(
      isCatalogInstalled(market('tushare-finance', '中国金融行情数据（tushare-finance）'), installed('tushare-finance'))
    ).toBe(true)
    // 括号里的英文名和 id 不一致时可能是另一个条目的 id。
    expect(
      isCatalogInstalled(
        market('jvs-wechat-article-publisher', '公众号（wechat-article-publisher）'),
        installed('wechat-article-publisher')
      )
    ).toBe(false)
    expect(isCatalogInstalled(market('brainstorming-v2'), installed('brainstorming'))).toBe(false)
  })

  it('guesses a recommended entry by its package name, never by the UUID or a Chinese display name', () => {
    expect(isCatalogInstalled(recommended('humanizer.zip'), installed('humanizer'))).toBe(true)
    expect(isCatalogInstalled(recommended('prd-to-design-doc__skillhub.zip'), installed('prd-to-design-doc'))).toBe(
      true
    )
    expect(isCatalogInstalled(recommended('Stock-Diagnosis.ZIP'), installed('Stock-Diagnosis'))).toBe(true)
    expect(
      isCatalogInstalled(recommended('superpowers-skill__skillhub.zip', 'superpowers'), installed('superpowers'))
    ).toBe(true)
    expect(
      isCatalogInstalled(
        recommended('ffmpeg-media-processing-agent-skill.zip', 'FFmpeg 音视频处理'),
        installed('ffmpeg-media-processing')
      )
    ).toBe(false)
    expect(catalogNameGuesses(recommended('oo-autotask.zip'))).not.toContain('04267514-133a-4e19-ad44-cf492b158c6e')
  })

  it('compares against the 64-character name the skill list returns', () => {
    const long = 'a'.repeat(70)

    expect(isCatalogInstalled(market('x'), installed(long.slice(0, 64)), long)).toBe(true)
    expect(isCatalogInstalled(market(long), installed(long.slice(0, 64)))).toBe(true)
  })

  it('stays a plus when nothing matches', () => {
    expect(isCatalogInstalled(market('tushare-finance'), installed())).toBe(false)
    expect(isCatalogInstalled(recommended(''), installed(''))).toBe(false)
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
