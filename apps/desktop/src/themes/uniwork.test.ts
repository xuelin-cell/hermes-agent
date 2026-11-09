import { describe, expect, it } from 'vitest'

import { uniworkTheme } from './uniwork'

describe('UniWork theme', () => {
  it.each([uniworkTheme.colors, uniworkTheme.darkColors])('keeps brand interactions in the cool-blue family', colors => {
    const coolBlue = (color: string) => {
      const [red, green, blue] = color.match(/\w\w/g)!.map(value => Number.parseInt(value, 16))

      return blue > green && green > red
    }

    expect(coolBlue(colors.primary)).toBe(true)
    expect(coolBlue(colors.accent)).toBe(true)
    expect(coolBlue(colors.accentForeground)).toBe(true)
    expect(coolBlue(colors.userBubble)).toBe(true)
    expect(coolBlue(colors.userBubbleBorder)).toBe(true)
    expect(colors.ring).toBe(colors.primary)
    expect(colors.midground).toBe(colors.primary)
    expect(colors.composerRing).toBe(colors.primary)
    expect(colors.userBubble).not.toBe(colors.background)
  })
})
