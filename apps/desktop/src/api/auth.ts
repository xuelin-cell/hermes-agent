import { hermesApi } from './client'

export interface UniWorkCaptcha {
  code?: number
  captchaId?: string
  b64s?: string
  data?: { captchaId?: string; b64s?: string }
  message?: string
  msg?: string
}

export interface UniWorkLoginUser {
  token: string
  uid?: string | number
  username?: string
  nickname?: string
  phone?: string
  refreshToken?: string
  expiresAt?: number | string
  expireIn?: number
  expires_in?: number
  scope?: string
  app_token?: string
  plan?: unknown
}

export interface UniWorkLoginResponse extends Partial<UniWorkLoginUser> {
  code?: number | string
  success?: boolean
  message?: string
  msg?: string
  data?: UniWorkLoginUser
}

export function getUniWorkCaptcha() {
  return hermesApi<UniWorkCaptcha>({ method: 'GET', path: '/api/uniwork/auth/captcha' })
}

export function sendUniWorkSmsCode(phone: string, captchaCode: string, captchaId: string) {
  return hermesApi<{ code?: number; message?: string; msg?: string }>({
    method: 'POST',
    path: '/api/uniwork/auth/send-code',
    body: { phone, captchaCode, captchaId }
  })
}

export function loginUniWorkSms(phone: string, smsCode: string) {
  return hermesApi<UniWorkLoginResponse>({
    method: 'POST',
    path: '/api/uniwork/auth/sms-login',
    body: { phone, smsCode }
  })
}
