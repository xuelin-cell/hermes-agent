import { afterEach, expect, it, vi } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'
import type { Locale } from '@/i18n/types'

import { withBrowserArtifactLabels } from './browser-shell-artifacts'

afterEach(() => vi.unstubAllEnvs())

it('桌面保留资料库名称，浏览器覆盖不污染桌面的翻译对象或分享和云盘文案', () => {
  for (const locale of ['en', 'zh', 'zh-hant', 'ja'] as const) {
    const desktop = TRANSLATIONS[locale]
    expect(withBrowserArtifactLabels(locale, desktop)).toBe(desktop)
  }

  expect(TRANSLATIONS.zh.sidebar.nav.artifacts).toBe('资料库')
  vi.stubEnv('VITE_HERMES_BROWSER_BUILD', '1')
  const cloud = withBrowserArtifactLabels('zh', TRANSLATIONS.zh)
  expect(cloud.sidebar.nav.artifacts).toBe('产物')
  expect(cloud.keybinds.actions['nav.artifacts']).toBe('打开制品')
  expect(cloud.commandCenter.nav.artifacts).toEqual({ title: '产物', detail: '浏览生成的输出' })
  expect(cloud.conversationShare).toBe(TRANSLATIONS.zh.conversationShare)
  expect(cloud.cloudLibrary).toBe(TRANSLATIONS.zh.cloudLibrary)
  expect(TRANSLATIONS.zh.sidebar.nav.artifacts).toBe('资料库')
})

it('浏览器保留原有英文、繁体及日文的英文快捷键回退，其他语种不改名', () => {
  vi.stubEnv('VITE_HERMES_BROWSER_BUILD', '1')

  for (const [locale, name, action] of [
    ['en', 'Artifacts', 'Open artifacts'],
    ['zh-hant', '成品', 'Open artifacts'],
    ['ja', 'アーティファクト', 'Open artifacts']
  ] as const) {
    const cloud = withBrowserArtifactLabels(locale, TRANSLATIONS[locale])
    expect(cloud.sidebar.nav.artifacts).toBe(name)
    expect(cloud.keybinds.actions['nav.artifacts']).toBe(action)
  }

  for (const locale of ['ar', 'de', 'es', 'fr', 'ru'] as Locale[]) {
    expect(withBrowserArtifactLabels(locale, TRANSLATIONS[locale])).toBe(TRANSLATIONS[locale])
  }
})
