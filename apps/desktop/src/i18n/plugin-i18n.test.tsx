import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { I18nProvider, useI18n } from './context'
import { createPluginI18n, registerPluginLocales, translatePlugin, usePluginI18n } from './plugin-i18n'
import { setRuntimeI18nLocale } from './runtime'

const noopTrack = (dispose: () => void) => dispose

afterEach(() => {
  cleanup()
  setRuntimeI18nLocale('en')
})

describe('plugin locale registry', () => {
  it('resolves the active locale, falling back to English then the raw key', () => {
    const dispose = registerPluginLocales('cost', {
      en: { panel: { title: 'Cost' }, spent: (n: number) => `$${n} spent` },
      'zh-hant': { panel: { title: '成本' } }
    })

    expect(translatePlugin('cost', 'zh-hant', 'panel.title', [])).toBe('成本')
    // Missing in Traditional Chinese → English.
    expect(translatePlugin('cost', 'zh-hant', 'spent', [7])).toBe('$7 spent')
    // Missing everywhere → the key itself.
    expect(translatePlugin('cost', 'zh-hant', 'nope', [])).toBe('nope')

    dispose()
  })

  it('scopes bundles per plugin — no cross-read', () => {
    const a = registerPluginLocales('a', { en: { hi: 'from a' } })
    const b = registerPluginLocales('b', { en: { hi: 'from b' } })

    expect(translatePlugin('a', 'en', 'hi', [])).toBe('from a')
    expect(translatePlugin('b', 'en', 'hi', [])).toBe('from b')
    // An unknown plugin resolves to the key.
    expect(translatePlugin('c', 'en', 'hi', [])).toBe('hi')

    a()
    b()
  })

  it('merges repeated registrations and drops everything on dispose', () => {
    const one = registerPluginLocales('merge', { en: { a: 'A' } })
    const two = registerPluginLocales('merge', { en: { b: 'B' }, 'zh-hant': { a: '甲' } })

    expect(translatePlugin('merge', 'en', 'a', [])).toBe('A')
    expect(translatePlugin('merge', 'en', 'b', [])).toBe('B')
    expect(translatePlugin('merge', 'zh-hant', 'a', [])).toBe('甲')

    one()
    two()

    expect(translatePlugin('merge', 'en', 'a', [])).toBe('a')
  })

  it('locale listeners ignore no-op changes and unsubscribe both explicitly and on unload', () => {
    const disposers: Array<() => void> = []

    const i18n = createPluginI18n('listener-plugin', dispose => {
      disposers.push(dispose)

      return dispose
    })

    i18n.register({ en: { greet: 'hello' }, 'zh-hant': { greet: '你好' } })
    const calls: string[] = []
    const unsubscribe = i18n.onLocaleChange(() => calls.push(i18n.t('greet')))
    expect(calls).toEqual([])
    setRuntimeI18nLocale('en')
    expect(calls).toEqual([])
    setRuntimeI18nLocale('zh-hant')
    expect(calls).toEqual(['你好'])
    unsubscribe()
    setRuntimeI18nLocale('en')
    expect(calls).toEqual(['你好'])
    i18n.onLocaleChange(() => calls.push(i18n.t('greet')))
    disposers.forEach(dispose => dispose())
    setRuntimeI18nLocale('zh-hant')
    expect(calls).toEqual(['你好'])
  })

  it('ctx.i18n.t reads the app runtime locale', () => {
    const i18n = createPluginI18n('runtime-plugin', noopTrack)
    i18n.register({ en: { greet: 'hello' }, 'zh-hant': { greet: '你好' } })

    expect(i18n.t('greet')).toBe('hello')

    setRuntimeI18nLocale('zh-hant')
    expect(i18n.t('greet')).toBe('你好')
  })
})

function Probe({ pluginId }: { pluginId: string }) {
  const t = usePluginI18n(pluginId)

  return <p data-testid="copy">{t('greet')}</p>
}

// 切换受支持语言，验证插件随界面刷新。
function SwitchToTraditional() {
  const { setLocale } = useI18n()

  return (
    <button onClick={() => void setLocale('zh-hant')} type="button">
      to Traditional Chinese
    </button>
  )
}

describe('usePluginI18n', () => {
  it('re-renders on a locale switch', () => {
    const dispose = registerPluginLocales('hooked', {
      en: { greet: 'hello' },
      'zh-hant': { greet: '你好' }
    })

    render(
      <I18nProvider configClient={null}>
        <SwitchToTraditional />
        <Probe pluginId="hooked" />
      </I18nProvider>
    )

    expect(screen.getByTestId('copy').textContent).toBe('hello')

    fireEvent.click(screen.getByRole('button'))

    expect(screen.getByTestId('copy').textContent).toBe('你好')

    dispose()
  })

  it('picks up a bundle registered after mount', () => {
    render(
      <I18nProvider configClient={null}>
        <Probe pluginId="late" />
      </I18nProvider>
    )

    expect(screen.getByTestId('copy').textContent).toBe('greet')

    let dispose = () => {}
    act(() => {
      dispose = registerPluginLocales('late', { en: { greet: 'landed' } })
    })

    expect(screen.getByTestId('copy').textContent).toBe('landed')

    dispose()
  })
})
