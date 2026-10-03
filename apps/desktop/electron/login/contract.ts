export const CAPTCHA_CHANNEL = 'hermes-login:captcha'
export const SEND_SMS_CHANNEL = 'hermes-login:send-sms'
export const LOGIN_CHANNEL = 'hermes-login:login'

export interface LoginRequest {
  phone: string
  smsCode: string
}

export interface LoginAccount {
  maskedPhone: string
  expiresAt: number
}

export type LoginResult = { ok: true; account: LoginAccount } | { ok: false }

export interface SmsRequest {
  phone: string
  captchaCode: string
  captchaId: string
}

export type SmsResult =
  | { ok: true; retryAt: number }
  | { ok: false; error: 'invalid' | 'busy' | 'failed' }
  | { ok: false; error: 'limited'; retryAt: number }

export interface LoginCaptcha {
  captchaId: string
  imageDataUrl: string
}

export type CaptchaResult = { ok: true; captcha: LoginCaptcha } | { ok: false }

export interface DesktopLoginBridge {
  /** 请求固定 MaaS 接口，不接受页面提供的地址或请求参数。 */
  captcha(): Promise<CaptchaResult>
  /** 提交短信所需字段，主进程负责校验、发送与频率限制。 */
  sendSms(input: SmsRequest): Promise<SmsResult>
  /** 短信登录只返回脱敏账号；UID 和 token 始终由主进程保管。 */
  login(input: LoginRequest): Promise<LoginResult>
}

declare global {
  interface Window {
    hermesLogin?: DesktopLoginBridge
  }
}
