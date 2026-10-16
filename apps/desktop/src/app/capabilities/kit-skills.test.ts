import { describe, expect, it } from 'vitest'

import { isManagedKitSkill } from './kit-skills'

describe('kit skill names', () => {
  it('treats a double-dash skill name as managed on the kits page', () => {
    expect(isManagedKitSkill('pptx--pptx')).toBe(true)
    expect(isManagedKitSkill('finance-research--westock-data')).toBe(true)
  })

  it('leaves ordinary skills on the skills page', () => {
    expect(isManagedKitSkill('web-research')).toBe(false)
    expect(isManagedKitSkill('pptx')).toBe(false)
  })
})
