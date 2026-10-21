import { describe, expect, it } from 'vitest'

import { installedExperts, type RosterProfile, withInstalledExperts } from './roster-model'

describe('机器人列表里的已装专家', () => {
  it('只留专家，跳过套件行和专家档案里自己的那份', () => {
    expect(
      installedExperts([
        { display_name: '严估深', kind: 'expert', profile: 'equity-research', self: false },
        { display_name: '套件', kind: 'kit', profile: '', self: false },
        { display_name: '自己', kind: 'expert', profile: 'equity-research', self: true }
      ])
    ).toEqual([{ displayName: '严估深', profile: 'equity-research' }])
  })

  it('把还没列出的专家补进机器人面板正在显示的列表', () => {
    const snapshot: { profiles: RosterProfile[] } = { profiles: [{ display_name: 'UniWork', name: 'default' }] }
    const next = withInstalledExperts(snapshot, [{ displayName: '看效果', profile: 'view-expert' }])

    expect(next?.profiles?.map(row => row.name)).toEqual(['default', 'view-expert'])
    expect(next?.profiles?.[1]?.display_name).toBe('看效果')
    expect(next?.profiles?.[1]?.ui_meta?.['hermes-bots']?.title).toBe('看效果')
  })

  it('专家已经在列表里时原样返回', () => {
    const current = { profiles: [{ name: 'view-expert', display_name: '看效果' }] }

    expect(withInstalledExperts(current, [{ displayName: '看效果', profile: 'view-expert' }])).toBe(current)
  })
})
