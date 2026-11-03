import { withBrowserShareLabels } from '@/lib/browser-shell-artifacts'
import { withBrowserBootLabels } from '@/lib/browser-shell-boot'
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

function browserLabels(locale: Locale, translations: Translations): Translations {
  return withBrowserBootLabels(locale, withBrowserShareLabels(locale, translations))
}

export const TRANSLATIONS: Record<Locale, Translations> = {
  en: browserLabels('en', en),
  zh: browserLabels('zh', withCloudChinese(zh)),
  'zh-hant': browserLabels('zh-hant', zhHant),
  ja: browserLabels('ja', ja),
  ar: browserLabels('ar', ar),
  ru: browserLabels('ru', ru),
  fr: browserLabels('fr', fr),
  de: browserLabels('de', de),
  es: browserLabels('es', es)
}
