import { describe, expect, it } from 'vitest'

import { TRANSLATIONS } from '@/i18n'

import { CONFIG_SUBPAGES, configSubpageForField } from './config-subpages'
import { SECTIONS } from './constants'
import { OTHER_SUBPAGES } from './other-subpages'
import {
  manifestView,
  type ManifestViewKey,
  SETTING_IDS,
  settingDefinition,
  SETTINGS_MANIFEST,
  settingSearchTargets
} from './settings-manifest'
import { settingsSearchTargetQuery } from './settings-search'
import { resolveSettingsSubpage, settingsNavSubpages, settingsSubpages } from './subpages'
import type { SettingsView } from './types'
import { settingsFieldVisible, settingsViewVisible } from './visibility'

const views: SettingsView[] = [
  ...SECTIONS.map(section => `config:${section.id}` as SettingsView),
  ...(Object.keys(OTHER_SUBPAGES) as SettingsView[])
]

describe('settings subpage routing', () => {
  it('工作空间保留仓库扫描设置，仅显示一个默认位置入口', () => {
    const keys = SECTIONS.find(section => section.id === 'workspace')!.keys
    expect(keys).toContain('desktop.repo_scan_enabled')
    expect(keys).not.toContain('terminal.cwd')
  })

  it('仅在开发者模式下显示 Browser 设置入口', () => {
    expect(settingsViewVisible('config:browser', false)).toBe(false)
    expect(settingsViewVisible('config:browser', true)).toBe(true)
    expect(settingsViewVisible('config:chat', false)).toBe(false)
  })

  it('仅在开发者模式下显示语音设置入口', () => {
    expect(settingsViewVisible('config:voice', false)).toBe(false)
    expect(settingsViewVisible('config:voice', true)).toBe(true)
    expect(settingsViewVisible('notifications', false)).toBe(false)
  })

  it('仅在开发者模式下显示通知声音子页', () => {
    expect(settingsSubpages('notifications', false).map(page => page.id)).not.toContain('sounds')
    expect(settingsSubpages('notifications', true).map(page => page.id)).toContain('sounds')
    expect(resolveSettingsSubpage('notifications', new URLSearchParams({ page: 'sounds' }), false)).toBe('alerts')
  })

  it('仅在开发者模式下显示记忆与上下文、对话时区和附件子页', () => {
    expect(settingsViewVisible('config:memory', false)).toBe(false)
    expect(settingsViewVisible('config:memory', true)).toBe(true)
    expect(settingsFieldVisible('config:chat', 'timezone', false)).toBe(false)
    expect(settingsFieldVisible('config:chat', 'timezone', true)).toBe(true)
    expect(settingsFieldVisible('config:chat', 'display.personality', false)).toBe(true)
    expect(settingsSubpages('config:chat', false).map(page => page.id)).not.toContain('attachments')
    expect(settingsSubpages('config:chat', true).map(page => page.id)).toContain('attachments')
    expect(resolveSettingsSubpage('config:chat', new URLSearchParams({ page: 'attachments' }), false)).toBe('behavior')
  })

  it('只在开发者模式下暴露宠物外观入口', () => {
    expect(settingsSubpages('config:appearance', false).map(page => page.id)).not.toContain('pet')
    expect(settingsSubpages('config:appearance', true).map(page => page.id)).toContain('pet')
    expect(resolveSettingsSubpage('config:appearance', new URLSearchParams({ page: 'pet' }), false)).toBe('general')
  })

  it('opens the first ordered child for parents and keeps explicit child destinations', () => {
    for (const view of views) {
      const pages = settingsSubpages(view)
      const navigable = pages.filter(page => !page.anchor)
      expect(pages.length).toBeGreaterThan(0)
      // A page made only of in-page anchors (About) opens whole, with no page param.
      expect(resolveSettingsSubpage(view, new URLSearchParams())).toBe(navigable[0]?.id)
      expect(resolveSettingsSubpage(view, new URLSearchParams({ page: 'missing' }))).toBe(navigable[0]?.id)

      if (navigable.some(page => page.id === 'general')) {
        expect(navigable[0]?.id).toBe('general')
      }

      for (const page of pages) {
        expect(resolveSettingsSubpage(view, new URLSearchParams({ page: page.id }))).toBe(page.id)

        for (const locale of Object.values(TRANSLATIONS)) {
          expect(locale.settings.subpages[page.labelKey]).toBeTruthy()
        }
      }
    }
  })

  it('关于页合并后，两个旧子页降级为页内锚点但仍可定位', () => {
    expect(settingsSubpages('about').map(page => page.id)).toEqual(['updates', 'legal'])
    expect(settingsNavSubpages('about')).toEqual([])
    expect(resolveSettingsSubpage('about', new URLSearchParams())).toBeUndefined()
    expect(resolveSettingsSubpage('about', new URLSearchParams({ page: 'updates' }))).toBe('updates')
    expect(resolveSettingsSubpage('about', new URLSearchParams({ page: 'legal' }))).toBe('legal')
    expect(resolveSettingsSubpage('about', new URLSearchParams({ setting: SETTING_IDS.about.legal }))).toBe('legal')

    // Search and palette anchors still serialize a page param for both sections.
    for (const key of ['updates', 'legal'] as const) {
      const params = new URLSearchParams(settingsSearchTargetQuery({ view: 'about', setting: SETTING_IDS.about[key] }))

      expect(params.get('page')).toBe(key)
    }
  })

  it('gives every settings group its own nav label in every locale', () => {
    for (const locale of Object.values(TRANSLATIONS)) {
      const nav: Record<string, string> = locale.settings.nav

      for (const view of Object.keys(OTHER_SUBPAGES)) {
        expect(nav[view]).toBeTruthy()
      }

      // Sessions also holds the default project folder, so it can't wear the
      // label of the palette row that lands on its archive page.
      expect(nav.sessions).not.toBe(nav.archivedChats)
    }
  })

  it('routes every curated field and legacy target to its owning child before consuming the target', () => {
    for (const section of SECTIONS.filter(section => section.keys.length)) {
      for (const field of section.keys) {
        const owner = configSubpageForField(section.id, field)
        expect(CONFIG_SUBPAGES[section.id].some(page => page.id === owner)).toBe(true)
        const view = `config:${section.id}` as SettingsView
        const params = new URLSearchParams(settingsSearchTargetQuery({ view, field }))
        expect(params.get('page')).toBe(owner)
        expect(resolveSettingsSubpage(view, params)).toBe(owner)
      }
    }

    const cases: [SettingsView, string, string][] = [
      ['config:model', 'aux=vision', 'auxiliary'],
      ['keybinds', 'setting=keybinds.hud-modifier', 'hud-gesture'],
      ['keybinds', 'page=shortcuts&setting=keybinds.hud-modifier', 'hud-gesture'],
      ['notifications', 'setting=notifications.completion-sound', 'sounds'],
      ['config:advanced', 'setting=advanced.keep-awake', 'desktop'],
      ['sessions', 'session=archived-id', 'archived'],
      ['vault', 'kind=login', 'credentials'],
      ['vault', 'label=Example', 'credentials'],
      ['vault', 'origin=https%3A%2F%2Fexample.com', 'credentials'],
      ['config:appearance', 'setting=appearance.hide-thread-timeline', 'chat-display']
    ]

    for (const [view, search, expected] of cases) {
      expect(resolveSettingsSubpage(view, new URLSearchParams(search))).toBe(expected)
    }
  })

  it('makes every manifest row a routed, translated palette hit on a real page', () => {
    for (const viewKey of Object.keys(SETTINGS_MANIFEST) as ManifestViewKey[]) {
      const view = manifestView(viewKey)
      const subpages = settingsSubpages(view).map(page => page.id)
      expect([...views, 'general']).toContain(view)

      for (const [key, setting] of Object.entries(SETTINGS_MANIFEST[viewKey])) {
        const id = SETTING_IDS[viewKey][key as keyof (typeof SETTING_IDS)[typeof viewKey]]
        expect(id).toBe(`${viewKey}.${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`)
        expect(settingDefinition(view, id)).toBe(setting)
        expect(setting.keywords.length).toBeGreaterThan(0)

        if (setting.subpage) {
          expect(subpages).toContain(setting.subpage)
          expect(
            resolveSettingsSubpage(view, new URLSearchParams(settingsSearchTargetQuery({ view, setting: id })))
          ).toBe(setting.subpage)
        }

        for (const locale of Object.values(TRANSLATIONS)) {
          expect(setting.copy(locale).label).toBeTruthy()
        }
      }
    }

    // Platform-gated rows aside, the whole manifest reaches the palette.
    const definitions = Object.values(SETTINGS_MANIFEST).flatMap(rows => Object.values(rows))
    const gated = definitions.filter(setting => 'available' in setting).length
    const targets = settingSearchTargets(TRANSLATIONS.en)
    expect(targets.length).toBeGreaterThanOrEqual(definitions.length - gated)
    expect(new Set(targets.map(target => target.id)).size).toBe(targets.length)
    expect(targets.map(target => target.label)).toEqual(
      expect.arrayContaining([
        'In-App Tips',
        'Guided Tours',
        'Keep computer awake',
        'Auto-archive stale chats',
        TRANSLATIONS.en.settings.about.updates
      ])
    )
  })
})

it('keeps safety approvals available while restricting privacy and checkpoints to developers', () => {
  expect(settingsViewVisible('config:safety', false)).toBe(true)
  expect(settingsSubpages('config:safety', false).map(page => page.id)).toEqual(['approvals'])
  expect(settingsSubpages('config:safety', true).map(page => page.id)).toEqual(['approvals', 'privacy', 'checkpoints'])
  expect(settingsFieldVisible('config:safety', 'approvals.mode', false)).toBe(true)
  expect(settingsFieldVisible('config:safety', 'security.redact_secrets', false)).toBe(false)
  expect(settingsFieldVisible('config:safety', 'checkpoints.enabled', false)).toBe(false)
})
