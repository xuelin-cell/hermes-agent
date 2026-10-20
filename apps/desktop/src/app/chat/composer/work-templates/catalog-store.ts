import { atom } from 'nanostores'

import { readKey, writeKey } from '@/lib/storage'

import {
  normalizeWelcomeCatalog,
  type WelcomeLocale,
  type WelcomeModule
} from '../../../../../electron/uniwork-welcome/catalog'

import english from './catalog.en.json'
import chinese from './catalog.zh-CN.json'

interface CatalogState {
  modules: WelcomeModule[]
  status: 'loading' | 'ready' | 'cached'
}

// v1 could cache the old main process's category array as top-level modules.
const KEY = 'uniwork.welcome.modules.v2.'

/** 磁盘缓存损坏时使用随应用提供的完整目录，不阻塞新对话。 */
function initial(locale: WelcomeLocale): CatalogState {
  let modules: WelcomeModule[]

  try {
    const saved = readKey(KEY + locale)
    modules = normalizeWelcomeCatalog(saved ? JSON.parse(saved) : locale === 'zh-CN' ? chinese : english)
  } catch {
    modules = normalizeWelcomeCatalog(locale === 'zh-CN' ? chinese : english)
  }

  return { modules, status: 'cached' }
}

export const $welcomeCatalog = atom<Record<WelcomeLocale, CatalogState>>({
  'zh-CN': initial('zh-CN'),
  en: initial('en')
})
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
      writeKey(KEY + locale, JSON.stringify(raw))
      $welcomeCatalog.set({ ...$welcomeCatalog.get(), [locale]: { modules, status: 'ready' } })
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
