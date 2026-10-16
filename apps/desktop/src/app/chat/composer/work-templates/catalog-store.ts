import { atom } from 'nanostores'

import { readKey, writeKey } from '@/lib/storage'

import {
  normalizeOfficeCatalog,
  type WelcomeCategory,
  type WelcomeLocale
} from '../../../../../electron/uniwork-welcome/catalog'

import english from './catalog.en.json'
import chinese from './catalog.zh-CN.json'

interface CatalogState {
  categories: WelcomeCategory[]
  status: 'loading' | 'ready' | 'cached'
}

const KEY = 'uniwork.welcome.office.v1.'

/** 磁盘缓存损坏时使用随应用提供的完整目录，不阻塞新对话。 */
function initial(locale: WelcomeLocale): CatalogState {
  let categories: WelcomeCategory[]

  try {
    const saved = readKey(KEY + locale)
    categories = normalizeOfficeCatalog(saved ? JSON.parse(saved) : locale === 'zh-CN' ? chinese : english)
  } catch {
    categories = normalizeOfficeCatalog(locale === 'zh-CN' ? chinese : english)
  }

  return { categories, status: 'cached' }
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
      const payload = { modules: [{ id: 'office', enabled: true, tags: raw }] }
      const categories = normalizeOfficeCatalog(payload)
      writeKey(KEY + locale, JSON.stringify({ modules: [{ id: 'office', enabled: true, tags: categories }] }))
      $welcomeCatalog.set({ ...$welcomeCatalog.get(), [locale]: { categories, status: 'ready' } })
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
