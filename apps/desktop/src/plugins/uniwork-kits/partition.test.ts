import { describe, expect, it } from 'vitest'

import { matchesQuery, partition } from './partition'
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

describe('kit shelves', () => {
  it('puts expert stubs on the expert shelf and kits on the kit shelf', () => {
    const shelves = partition([
      row({ kind: 'kit', name: 'pptx' }),
      row({ kind: 'expert', name: 'equity-research', profile: 'equity-research' }),
      row({ kind: 'team', name: 'a-team' })
    ])

    expect(shelves.kits.map(item => item.name)).toEqual(['pptx', 'a-team'])
    expect(shelves.experts.map(item => item.name)).toEqual(['equity-research'])
  })

  it('keeps an expert profile’s own row with the kits of that home', () => {
    const shelves = partition([row({ kind: 'expert', name: 'equity-research', self: true })])

    expect(shelves.kits.map(item => item.name)).toEqual(['equity-research'])
    expect(shelves.experts).toEqual([])
  })
})

describe('kit search', () => {
  const kit = row({
    description: '用 pptxgenjs 生成演示文稿',
    display_name: 'PPT 写作',
    kind: 'kit',
    name: 'ppt-writer',
    phrases: ['做个PPT', '写幻灯片']
  })

  it('matches the name, description and trigger phrases, ignoring case', () => {
    for (const query of ['', 'PPT-writer', '演示文稿', '幻灯片', 'ppt 写作']) {
      expect(matchesQuery(kit, query)).toBe(true)
    }
  })

  it('needs every word to match', () => {
    expect(matchesQuery(kit, 'ppt 基金')).toBe(false)
  })
})
