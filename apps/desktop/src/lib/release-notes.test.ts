import { describe, expect, it } from 'vitest'

import { selectReleaseNotes } from './release-notes'

const groups = (label: string) => [{ id: 'new', label, items: [`${label} item`] }]

describe('selectReleaseNotes', () => {
  it('prefers the reader locale, then the product default, then any authored copy', () => {
    expect(selectReleaseNotes({ zh: groups('新增'), en: groups('New') }, 'zh')).toEqual(groups('新增'))
    expect(selectReleaseNotes({ zh: groups('新增'), en: groups('New') }, 'ja')).toEqual(groups('新增'))
    expect(selectReleaseNotes({ de: groups('Neu') }, 'ja')).toEqual(groups('Neu'))
  })

  it('has nothing to show for a feed that published no copy', () => {
    expect(selectReleaseNotes(null, 'zh')).toBeNull()
    expect(selectReleaseNotes({}, 'zh')).toBeNull()
    expect(selectReleaseNotes({ zh: [] }, 'zh')).toBeNull()
  })
})
