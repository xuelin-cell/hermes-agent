import { atom } from 'nanostores'

import type { UniWorkLoginResponse, UniWorkLoginUser } from '@/api/auth'

const TOKEN_KEY = 'auth_token'
const USER_KEY = 'user_info'
const TOKEN_INFO_KEY = 'api_token_info'
const APP_KEY = 'auth_application'

export interface UniWorkAuthState {
  authenticated: boolean
  user: UniWorkLoginUser | null
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value)

  return Number.isFinite(parsed) ? parsed : null
}

function timestampValue(value: unknown): number | null {
  const numeric = numberValue(value)

  if (numeric !== null) {
    return numeric < 10_000_000_000 ? numeric * 1000 : numeric
  }

  if (typeof value === 'string') {
    const parsed = Date.parse(value)

    return Number.isFinite(parsed) ? parsed : null
  }

  return null
}

function expired(user: UniWorkLoginUser, tokenInfo?: Record<string, unknown>): boolean {
  const expiry = timestampValue(user.expiresAt)

  if (expiry !== null) {
    return expiry <= Date.now()
  }

  const ttl = numberValue(user.expires_in ?? user.expireIn ?? tokenInfo?.expires_in)
  const issued = timestampValue(tokenInfo?.successDate)

  return Boolean(ttl && issued && issued + ttl * 1000 <= Date.now())
}

export function loadUniWorkAuth(): UniWorkAuthState {
  try {
    if (localStorage.getItem(APP_KEY) !== 'uniwork') {return { authenticated: false, user: null }}
    const token = localStorage.getItem(TOKEN_KEY)
    const stored = localStorage.getItem(USER_KEY)

    if (!token || !stored) {return { authenticated: false, user: null }}
    const user = { ...JSON.parse(stored), token } as UniWorkLoginUser
    const tokenInfo = JSON.parse(localStorage.getItem(TOKEN_INFO_KEY) || '{}') as Record<string, unknown>

    if (expired(user, tokenInfo)) {
      clearUniWorkAuthStorage()

      return { authenticated: false, user: null }
    }

    return { authenticated: true, user }
  } catch {
    clearUniWorkAuthStorage()

    return { authenticated: false, user: null }
  }
}

export const $uniWorkAuth = atom<UniWorkAuthState>(loadUniWorkAuth())

function clearUniWorkAuthStorage() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(USER_KEY)
  localStorage.removeItem(TOKEN_INFO_KEY)
  localStorage.removeItem(APP_KEY)
}

export function completeUniWorkLogin(response: UniWorkLoginResponse, phone: string): UniWorkLoginUser {
  if ((response.code !== undefined && Number(response.code) !== 0) || response.success === false) {
    throw new Error(response.message || response.msg || '登录失败')
  }

  const source = response.data ?? response

  if (!source.token) {throw new Error(response.message || response.msg || '登录响应中缺少访问令牌')}
  const user: UniWorkLoginUser = { ...source, phone: source.phone || phone, token: source.token }
  localStorage.setItem(TOKEN_KEY, user.token)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
  localStorage.setItem(APP_KEY, 'uniwork')
  localStorage.setItem(
    TOKEN_INFO_KEY,
    JSON.stringify({ expires_in: user.expires_in ?? user.expireIn, successDate: Date.now() })
  )
  $uniWorkAuth.set({ authenticated: true, user })

  return user
}

export function logoutUniWork() {
  clearUniWorkAuthStorage()
  $uniWorkAuth.set({ authenticated: false, user: null })
}
