import { describe, expect, it } from 'vitest'

import { installedExperts, type RosterProfile, withInstalledExperts } from './roster-model'

describe('installed experts on the bots roster', () => {
  it('keeps experts and skips kit rows and the expert profile’s own copy', () => {
    expect(
      installedExperts([
        { display_name: '严估深', kind: 'expert', profile: 'equity-research', self: false },
        { display_name: '套件', kind: 'kit', profile: '', self: false },
        { display_name: '自己', kind: 'expert', profile: 'equity-research', self: true }
      ])
    ).toEqual([{ displayName: '严估深', profile: 'equity-research' }])
  })

  it('adds a missing expert to the snapshot the bots pane is already painting', () => {
    const snapshot: { profiles: RosterProfile[] } = { profiles: [{ display_name: 'UniWork', name: 'default' }] }
    const next = withInstalledExperts(snapshot, [{ displayName: '看效果', profile: 'view-expert' }])

    expect(next?.profiles?.map(row => row.name)).toEqual(['default', 'view-expert'])
    expect(next?.profiles?.[1]?.display_name).toBe('看效果')
    expect(next?.profiles?.[1]?.ui_meta?.['hermes-bots']?.title).toBe('看效果')
  })

  it('leaves a snapshot alone when the expert is already listed', () => {
    const current = { profiles: [{ name: 'view-expert', display_name: '看效果' }] }

    expect(withInstalledExperts(current, [{ displayName: '看效果', profile: 'view-expert' }])).toBe(current)
  })
})
