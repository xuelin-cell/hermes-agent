import { beforeEach, describe, expect, it, vi } from 'vitest'

import { COMPLETION_SOUND_VARIANTS } from '@/lib/completion-sound'

const STORAGE_KEY = 'hermes.desktop.completionSoundVariantId'

describe('completion sound first-install default', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('selects Two-note comfort when no sound preference has been saved', async () => {
    const { $completionSoundVariantId, DEFAULT_COMPLETION_SOUND_VARIANT_ID } = await import('./completion-sound')

    expect($completionSoundVariantId.get()).toBe(DEFAULT_COMPLETION_SOUND_VARIANT_ID)
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(String(DEFAULT_COMPLETION_SOUND_VARIANT_ID))
    expect(
      COMPLETION_SOUND_VARIANTS.find(({ id }) => id === $completionSoundVariantId.get())?.name
    ).toBe('Two-note comfort')
  })
})
