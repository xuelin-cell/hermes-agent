import { useStore } from '@nanostores/react'

import { isBrowserShell } from '@/lib/browser-shell'
import { $uniWorkAuth } from '@/store/uniwork-auth'

import { LoginPage } from './login-page'

export function AuthGate({ children }: React.PropsWithChildren) {
  const auth = useStore($uniWorkAuth)

  // Browser build: the entry signed the user in before serving the app.
  return auth.authenticated || isBrowserShell() ? children : <LoginPage />
}
