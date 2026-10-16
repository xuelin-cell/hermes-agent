import { isRecord } from '@hermes/shared/i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'
import { en } from '@/i18n/en'

import { CLOUD_ZH, stillEnglish, withCloudChinese } from './browser-shell-zh'

interface Leaf {
  path: string[]
  value: unknown
}

// Keys may hold dots themselves (keybinds.actions['view.tabSlot.1']), so paths stay arrays.
function leaves(value: unknown, path: string[] = []): Leaf[] {
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, child]) => leaves(child, [...path, key]))
  }

  return [{ path, value }]
}

const at = (root: unknown, path: string[]) =>
  path.reduce<unknown>((node, key) => (isRecord(node) ? node[key] : undefined), root)

const render = (value: unknown) =>
  typeof value === 'function'
    ? String((value as (...args: unknown[]) => unknown)(...Array.from({ length: value.length }, (_, i) => i + 2)))
    : String(value)

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the cloud’s Chinese supplement', () => {
  it('is Chinese in every entry and takes the arguments English takes', () => {
    for (const { path, value } of leaves(CLOUD_ZH)) {
      const english = at(en, path)

      expect({ path: path.join(' › '), chinese: /[一-鿿]/.test(render(value)) }).toEqual({
        path: path.join(' › '),
        chinese: true
      })
      expect({ path: path.join(' › '), kind: typeof value }).toEqual({ path: path.join(' › '), kind: typeof english })

      if (typeof value === 'function' && typeof english === 'function') {
        expect({ path: path.join(' › '), arity: value.length }).toEqual({ path: path.join(' › '), arity: english.length })
      }
    }
  })

  it('only fills what zh.ts still leaves in English, so an upstream translation wins', () => {
    const zh = { a: { done: '已有中文', todo: 'English' }, n: (count: number) => `${count} items` }
    const english = { a: { done: 'Done', todo: 'English' }, n: zh.n }
    const overrides = { a: { done: '我们的', todo: '待补' }, n: (count: number) => `${count} 项` }

    expect(stillEnglish(overrides, zh, english)).toEqual({ a: { todo: '待补' }, n: overrides.n })
    expect(stillEnglish({ a: { done: '我们的' } }, zh, english)).toBeUndefined()
  })

  it('has no entry zh.ts has translated since (drop those here after a merge)', () => {
    const translatedUpstream = leaves(CLOUD_ZH)
      .filter(({ path }) => at(TRANSLATIONS.zh, path) !== at(en, path))
      .map(({ path }) => path.join(' › '))

    expect(translatedUpstream).toEqual([])
  })

  it('applies in the browser build only', () => {
    expect(withCloudChinese(TRANSLATIONS.zh)).toBe(TRANSLATIONS.zh)

    vi.stubEnv('VITE_HERMES_BROWSER_BUILD', '1')

    const cloud = withCloudChinese(TRANSLATIONS.zh)

    expect(cloud.connectorsPage.tools.summaryAllTools).toBe('全部工具')
    expect(cloud.connectorsPage.card.turnServerOff('yuanjing')).toBe('关闭 yuanjing')
    expect(cloud.titlebar.developerModeEnabled).toBe('开发者模式已开启')
    // What zh.ts translates itself stays as it is.
    expect(cloud.common.cancel).toBe(TRANSLATIONS.zh.common.cancel)
  })
})
