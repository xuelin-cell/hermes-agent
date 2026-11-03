import { afterEach, expect, it, vi } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'
import type { Locale } from '@/i18n/types'

import { withBrowserShareLabels } from './browser-shell-artifacts'

afterEach(() => vi.unstubAllEnvs())

it('云端沿用桌面资料库入口，仅覆盖实例和浏览器实际行为的说明', () => {
  expect(TRANSLATIONS.zh.sidebar.nav.artifacts).toBe('资料库')
  for (const locale of Object.keys(TRANSLATIONS) as Locale[]) {
    const desktop = TRANSLATIONS[locale]
    vi.stubEnv('VITE_HERMES_BROWSER_BUILD', '0')
    expect(withBrowserShareLabels(locale, desktop)).toBe(desktop)
    vi.stubEnv('VITE_HERMES_BROWSER_BUILD', '1')
    const cloud = withBrowserShareLabels(locale, desktop)
    expect(cloud.sidebar.nav).toBe(desktop.sidebar.nav)
    expect(cloud.keybinds.actions).toBe(desktop.keybinds.actions)
    expect(cloud.commandCenter.nav).toBe(desktop.commandCenter.nav)
    expect(cloud.conversationShare).toBe(desktop.conversationShare)
    expect(cloud.artifactShare.expiryNotice).not.toBe(desktop.artifactShare.expiryNotice)
  }
})
