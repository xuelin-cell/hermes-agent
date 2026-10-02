export const CAPTCHA_CHANNEL = 'hermes-login:captcha'

export interface LoginCaptcha {
  captchaId: string
  imageDataUrl: string
}

export type CaptchaResult = { ok: true; captcha: LoginCaptcha } | { ok: false }

export interface DesktopLoginBridge {
  /** 请求固定 MaaS 接口，不接受页面提供的地址或请求参数。 */
  captcha(): Promise<CaptchaResult>
}

declare global {
  interface Window {
    hermesLogin?: DesktopLoginBridge
  }
}
