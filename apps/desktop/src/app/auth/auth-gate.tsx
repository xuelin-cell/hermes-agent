import { useStore } from '@nanostores/react'

import { $uniWorkAuth } from '@/store/uniwork-auth'

import { LoginPage } from './login-page'

export function AuthGate({ children }: React.PropsWithChildren) {
  const auth = useStore($uniWorkAuth)

  return auth.authenticated ? children : <LoginPage />
}
