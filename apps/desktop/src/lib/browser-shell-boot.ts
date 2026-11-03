import { mergeTranslations } from '@hermes/shared/i18n'

import type { Locale, Translations } from '@/i18n/types'

const CLOUD_STARTING: Record<Locale, string> = {
  zh: '正在准备你的云端工作空间…',
  'zh-hant': '正在準備你的雲端工作空間…',
  en: 'Preparing your cloud workspace…',
  ja: 'クラウドワークスペースを準備しています…',
  ar: 'جار تجهيز مساحة عملك السحابية…',
  de: 'Dein Cloud-Arbeitsbereich wird vorbereitet…',
  es: 'Preparando tu espacio de trabajo en la nube…',
  fr: 'Préparation de votre espace de travail cloud…',
  ru: 'Подготавливаем ваше облачное рабочее пространство…'
}

/** Boot state and onboarding share these labels, including before the bridge mounts. */
export function withBrowserBootLabels(locale: Locale, translations: Translations): Translations {
  if (import.meta.env.VITE_HERMES_BROWSER_BUILD !== '1') return translations

  return mergeTranslations<Translations>(translations, {
    boot: {
      steps: {
        startingDesktopConnection: CLOUD_STARTING[locale],
        startingHermesDesktop: CLOUD_STARTING[locale]
      }
    }
  })
}
