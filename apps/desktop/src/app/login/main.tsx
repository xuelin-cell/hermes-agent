import '../../styles.css'

import { createRoot } from 'react-dom/client'

import { I18nProvider } from '@/i18n/context'
import { resolveInitialLocale } from '@/i18n/languages'

import { AccountExitPage } from './exit-page'
import { LoginPage } from './page'

const params = new URLSearchParams(location.search)
const exiting = params.get('exit') === '1'

if (exiting) {
  document.documentElement.classList.toggle('dark', params.get('dark') === '1')
  const background = params.get('background')

  if (background && /^#[\da-f]{6}$/i.test(background)) {
    document.documentElement.style.setProperty('--ui-chat-surface-background', background)
  }
}

createRoot(document.getElementById('root')!).render(
  <I18nProvider configClient={null} initialLocale={resolveInitialLocale(undefined, navigator.language)}>
    {exiting ? <AccountExitPage /> : <LoginPage />}
  </I18nProvider>
)
