import { mergeTranslations } from '@hermes/shared/i18n'

import type { Locale, Translations } from '@/i18n/types'

const BROWSER_ARTIFACT_LABELS = {
  en: { action: 'Open artifacts', title: 'Artifacts', detail: 'Browse generated outputs', sidebar: 'Artifacts' },
  zh: { action: '打开制品', title: '产物', detail: '浏览生成的输出', sidebar: '产物' },
  'zh-hant': { action: 'Open artifacts', title: '成品', detail: '瀏覽產生的輸出', sidebar: '成品' }
}

/** 文案目录在浏览器桥初始化前加载，沿用构建标志保留云端原有产物名称。 */
export function withBrowserArtifactLabels(locale: Locale, translations: Translations): Translations {
  if (import.meta.env.VITE_HERMES_BROWSER_BUILD !== '1') {
    return translations
  }

  // 日文未单独翻译此快捷键，原来继承英文；其余语种保留已有的独立翻译。
  if (locale === 'ja') {
    return mergeTranslations<Translations>(translations, {
      keybinds: { actions: { 'nav.artifacts': 'Open artifacts' } }
    })
  }

  if (locale !== 'en' && locale !== 'zh' && locale !== 'zh-hant') {
    return translations
  }

  const labels = BROWSER_ARTIFACT_LABELS[locale]

  return mergeTranslations<Translations>(translations, {
    keybinds: { actions: { 'nav.artifacts': labels.action } },
    commandCenter: { nav: { artifacts: { title: labels.title, detail: labels.detail } } },
    sidebar: { nav: { artifacts: labels.sidebar } }
  })
}
