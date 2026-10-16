import { withBrowserArtifactLabels } from '@/lib/browser-shell-artifacts'
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
  en: withBrowserArtifactLabels('en', en),
  zh: withBrowserArtifactLabels('zh', withCloudChinese(zh)),
  'zh-hant': withBrowserArtifactLabels('zh-hant', zhHant),
  ja: withBrowserArtifactLabels('ja', ja),
  ar,
  ru,
  fr,
  de,
  es
}
