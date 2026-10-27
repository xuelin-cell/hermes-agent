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

const BROWSER_SHARE_EXPIRY: Record<Locale, string> = {
  en: 'Links default to 1 day (1–7 days). Cleanup is attempted when you next access sharing while signed in; public access may continue until deletion succeeds.',
  zh: '默认有效期 1 天，可设为 1～7 天。到期后在你有效登录并再次查看分享时尝试清理；删除成功前公网链接可能仍可访问。',
  'zh-hant': '預設有效期 1 天，可設為 1～7 天。到期後在你有效登入並再次查看分享時嘗試清理；刪除成功前公開連結可能仍可存取。',
  ja: '有効期間は既定で1日（1～7日）。期限後、ログインして共有を再表示すると削除を試みます。削除成功までは公開リンクにアクセスできる場合があります。',
  ar: 'المدة الافتراضية يوم واحد ويمكن اختيار 1–7 أيام. تُحاول إزالة الرابط عند فتح المشاركة مجددًا بعد تسجيل الدخول؛ وقد يبقى متاحًا حتى نجاح الحذف.',
  de: 'Links gelten standardmäßig 1 Tag (1–7 Tage). Beim nächsten angemeldeten Zugriff auf die Freigabe wird die Löschung versucht; bis zum Erfolg kann der Link öffentlich erreichbar bleiben.',
  es: 'Los enlaces duran 1 día por defecto (1–7 días). Se intenta eliminarlos al volver a acceder a las opciones de compartir con sesión iniciada; pueden seguir siendo públicos hasta que se eliminen.',
  fr: 'Les liens durent 1 jour par défaut (1 à 7 jours). La suppression est tentée lors du prochain accès au partage avec une session active ; le lien peut rester public tant que la suppression échoue.',
  ru: 'Срок по умолчанию — 1 день (от 1 до 7 дней). Удаление выполняется при следующем обращении к функции публикации после входа; до успешного удаления ссылка может оставаться доступной.'
}

/** Cloud cleanup needs a returning authenticated owner; it cannot promise an exact public deadline. */
export function withBrowserShareLabels(locale: Locale, translations: Translations): Translations {
  return import.meta.env.VITE_HERMES_BROWSER_BUILD === '1'
    ? mergeTranslations<Translations>(translations, { artifactShare: { expiryNotice: BROWSER_SHARE_EXPIRY[locale] } })
    : translations
}
