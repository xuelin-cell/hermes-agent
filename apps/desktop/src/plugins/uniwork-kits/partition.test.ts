import { describe, expect, it } from 'vitest'

import { matchesQuery, normalizeRow, partition } from './partition'
import type { KitRow } from './types'

function row(partial: Partial<KitRow> & Pick<KitRow, 'kind' | 'name'>): KitRow {
  return {
    agent_count: 0,
    description: '',
    display_name: partial.name,
    enabled: partial.kind === 'expert' ? null : true,
    market_id: '',
    mcp_count: 0,
    missing_secrets: [],
    oauth_servers: [],
    pending_triggers: 0,
    phrases: [],
    profession: '',
    profile: '',
    self: false,
    skill_count: 0,
    unverified_triggers: 0,
    user_config: [],
    version: '1',
    ...partial
  }
}

describe('套件页的分栏', () => {
  it('专家放进专家栏，套件和团队放进套件栏', () => {
    const shelves = partition([
      row({ kind: 'kit', name: 'pptx' }),
      row({ kind: 'expert', name: 'equity-research', profile: 'equity-research' }),
      row({ kind: 'team', name: 'a-team' })
    ])

    expect(shelves.kits.map(item => item.name)).toEqual(['pptx', 'a-team'])
    expect(shelves.experts.map(item => item.name)).toEqual(['equity-research'])
  })

  it('专家档案里自己的那一行留在该档案的套件栏', () => {
    const shelves = partition([row({ kind: 'expert', name: 'equity-research', self: true })])

    expect(shelves.kits.map(item => item.name)).toEqual(['equity-research'])
    expect(shelves.experts).toEqual([])
  })
})

describe('搜索套件', () => {
  const kit = row({
    description: '用 pptxgenjs 生成演示文稿',
    display_name: 'PPT 写作',
    kind: 'kit',
    name: 'ppt-writer',
    phrases: ['做个PPT', '写幻灯片']
  })

  it('按名字、描述和触发词搜索，不分大小写', () => {
    for (const query of ['', 'PPT-writer', '演示文稿', '幻灯片', 'ppt 写作']) {
      expect(matchesQuery(kit, query)).toBe(true)
    }
  })

  it('每个词都要对得上', () => {
    expect(matchesQuery(kit, 'ppt 基金')).toBe(false)
  })
})

describe('旧版后端返回的目录行', () => {
  it('缺的描述、副标题和触发词补成空值，不是 undefined', () => {
    const { description, phrases, profession, ...old } = row({ kind: 'kit', name: 'pptx' })
    const filled = normalizeRow(old as KitRow)

    expect([description, profession, phrases]).toEqual(['', '', []])
    expect(filled.description).toBe('')
    expect(filled.profession).toBe('')
    expect(filled.phrases).toEqual([])
    expect(matchesQuery(filled, 'pptx')).toBe(true)
  })
})
