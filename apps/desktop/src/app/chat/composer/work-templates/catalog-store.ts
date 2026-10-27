import { atom, computed } from 'nanostores'

import { readKey, writeKey } from '@/lib/storage'

import {
  normalizeWelcomeCatalog,
  type WelcomeLocale,
  type WelcomeModule
} from '../../../../../electron/uniwork-welcome/catalog'

interface CatalogState {
  modules: WelcomeModule[] | null
  status: 'loading' | 'ready' | 'cached'
  version?: string
}

// v1 could cache the old main process's category array as top-level modules.
const KEY = 'uniwork.welcome.modules.v3.'

/** 仅恢复上次成功获取的云端目录；首次启动或缓存损坏时等待云端。 */
function initial(locale: WelcomeLocale): CatalogState {
  try {
    const saved = readKey(KEY + locale)

    if (!saved) {
      return { modules: null, status: 'cached' }
    }

    const payload = JSON.parse(saved)

    return { modules: normalizeWelcomeCatalog(payload), version: payload.version, status: 'cached' }
  } catch {
    return { modules: null, status: 'cached' }
  }
}

export const $welcomeCatalog = atom<Record<WelcomeLocale, CatalogState>>({
  'zh-CN': initial('zh-CN'),
  en: initial('en')
})

function resolvedCatalog(locale: WelcomeLocale) {
  const fallback = locale === 'zh-CN' ? 'en' : 'zh-CN'

  return computed($welcomeCatalog, catalog => ({
    ...(catalog[locale].modules == null ? catalog[fallback] : catalog[locale]),
    modules: catalog[locale].modules ?? catalog[fallback].modules ?? []
  }))
}

export const $resolvedWelcomeCatalog = { 'zh-CN': resolvedCatalog('zh-CN'), en: resolvedCatalog('en') }
const pending = new Map<WelcomeLocale, Promise<void>>()
const updated = new Map<WelcomeLocale, number>()

/** 同语言请求合并并短期复用；失败只保留旧目录，不清空用户正在编辑的提示词。 */
export function loadWelcomeCatalog(locale: WelcomeLocale, force = false): Promise<void> {
  const inFlight = pending.get(locale)

  if (inFlight) {
    return inFlight
  }

  if (!force && Date.now() - (updated.get(locale) ?? 0) < 300_000) {
    return Promise.resolve()
  }

  const request = window.hermesDesktop?.getWelcomeCatalog

  if (!request) {
    return Promise.resolve()
  }

  $welcomeCatalog.set({ ...$welcomeCatalog.get(), [locale]: { ...$welcomeCatalog.get()[locale], status: 'loading' } })

  const task = Promise.resolve().then(async () => {
    try {
      const raw = await request(locale)
      const modules = normalizeWelcomeCatalog(raw)

      if (!modules.length) {
        throw new Error('欢迎配置没有可用模块')
      }

      const previous = $welcomeCatalog.get()[locale]
      const unchanged = JSON.stringify(modules) === JSON.stringify(previous.modules)

      if (!unchanged || raw.version !== previous.version || !readKey(KEY + locale)) {
        writeKey(KEY + locale, JSON.stringify(raw))
      }

      $welcomeCatalog.set({
        ...$welcomeCatalog.get(),
        [locale]: {
          modules: unchanged ? previous.modules : modules,
          version: raw.version,
          status: 'ready'
        }
      })
    } catch {
      $welcomeCatalog.set({
        ...$welcomeCatalog.get(),
        [locale]: { ...$welcomeCatalog.get()[locale], status: 'cached' }
      })
    } finally {
      updated.set(locale, Date.now())
      pending.delete(locale)
    }
  })

  pending.set(locale, task)

  return task
}
