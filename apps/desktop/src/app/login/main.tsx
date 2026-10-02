import '../../styles.css'

import { createRoot } from 'react-dom/client'

import { I18nProvider } from '@/i18n/context'
import { resolveInitialLocale } from '@/i18n/languages'

import { LoginPage } from './page'

createRoot(document.getElementById('root')!).render(
  <I18nProvider configClient={null} initialLocale={resolveInitialLocale(undefined, navigator.language)}>
    <LoginPage />
  </I18nProvider>
)
