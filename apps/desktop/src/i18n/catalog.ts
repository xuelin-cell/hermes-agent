import { withBrowserShareLabels } from '@/lib/browser-shell-artifacts'
import { withCloudChinese } from '@/lib/browser-shell-zh'

import { ar } from './ar'
import { de } from './de'
import { en } from './en'
import { es } from './es'
import { fr } from './fr'
import { ja } from './ja'
import { ru } from './ru'
import type { Locale, Translations } from './types'
import { zh } from './zh'
import { zhHant } from './zh-hant'

export const TRANSLATIONS: Record<Locale, Translations> = {
  en: withBrowserShareLabels('en', en),
  zh: withBrowserShareLabels('zh', withCloudChinese(zh)),
  'zh-hant': withBrowserShareLabels('zh-hant', zhHant),
  ja: withBrowserShareLabels('ja', ja),
  ar: withBrowserShareLabels('ar', ar),
  ru: withBrowserShareLabels('ru', ru),
  fr: withBrowserShareLabels('fr', fr),
  de: withBrowserShareLabels('de', de),
  es: withBrowserShareLabels('es', es)
}
