import './login.css'

import { type FormEvent, useEffect, useRef, useState } from 'react'

import loginBrandLogo from '@/assets/login-brand-logo.png'
import { ConnectingScreen } from '@/components/ui/connecting-screen'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n/context'

import type { LoginAccount } from '../../../electron/login/contract'

import { useCaptcha } from './use-captcha'
import { useSms } from './use-sms'

interface LoginFields {
  phone: string
  captchaCode: string
  smsCode: string
}

/** 展示短信登录表单；未接入主进程能力时禁用动作，不提供免登录入口。 */
export function LoginPage() {
  const { t } = useI18n()
  const copy = t.desktopLogin
  const bridge = window.hermesLogin
  const [account, setAccount] = useState<LoginAccount | null>(null)
  const [restoring, setRestoring] = useState(!!bridge)
  const image = useCaptcha(!restoring && !account ? bridge : undefined)
  const sms = useSms(bridge)
  const [fields, setFields] = useState<LoginFields>({ phone: '', captchaCode: '', smsCode: '' })

  const [error, setError] = useState<'phoneError' | 'captchaError' | 'smsError' | 'requestError' | 'expired' | null>(
    null
  )

  const [pending, setPending] = useState(false)
  const submitting = useRef(false)

  useEffect(() => {
    if (!bridge) {
      return
    }

    let active = true

    /** 等主进程恢复结果后再展示账号或表单，卸载后的响应不再更新页面。 */
    async function restoreAccount(): Promise<void> {
      try {
        const result = await bridge!.restore()

        if (active) {
          setAccount(result.ok ? result.account : null)
        }
      } catch {
        if (active) {
          setAccount(null)
        }
      } finally {
        if (active) {
          setRestoring(false)
        }
      }
    }

    void restoreAccount()

    return () => {
      active = false
    }
  }, [bridge])

  useEffect(() => {
    if (!account || !bridge) {
      return
    }

    let active = true
    // 套餐仍由主进程查询并交接账号；等待期间只保留官方启动画面。
    void bridge.plan().catch(() => {
      if (active) {
        setAccount(null)
        setError('requestError')
      }
    })

    return () => {
      active = false
    }
  }, [account, bridge])

  useEffect(() => {
    if (!account) {
      return
    }

    let timer: ReturnType<typeof setTimeout>

    /** 到期回到空表单；长有效期分段等待，避免浏览器定时器上限。 */
    function checkExpiry(): void {
      const remaining = account!.expiresAt - Date.now()

      if (remaining > 0) {
        timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647))

        return
      }

      setAccount(null)
      setFields({ phone: '', captchaCode: '', smsCode: '' })
      setError('expired')
    }

    checkExpiry()

    return () => clearTimeout(timer)
  }, [account])

  /** 修改输入时清除旧错误，验证码和手机号仅保留在当前页面内存中。 */
  function updateField(field: keyof LoginFields, value: string): void {
    setFields(previous => ({ ...previous, [field]: value }))
    setError(null)
  }

  /** 先校验手机号和当前图片输入，通过后才调用主进程发送短信。 */
  async function sendSms(): Promise<void> {
    const phone = fields.phone.trim()
    const captchaCode = fields.captchaCode.trim()

    if (!/^1\d{10}$/.test(phone)) {
      return setError('phoneError')
    }

    if (!captchaCode || !image.captcha) {
      return setError('captchaError')
    }

    setError(null)
    await sms.send({ phone, captchaCode, captchaId: image.captcha.captchaId })
  }

  /** 只提交手机号与短信码，主进程确认登录后清空页面输入。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    if (!window.hermesLogin || account || submitting.current || sms.pending) {
      return
    }

    const values = {
      phone: fields.phone.trim(),
      smsCode: fields.smsCode.trim()
    }

    const invalid = !/^1\d{10}$/.test(values.phone) ? 'phoneError' : !/^\d{6}$/.test(values.smsCode) ? 'smsError' : null

    setError(invalid)

    if (invalid) {
      return
    }

    submitting.current = true
    setPending(true)

    try {
      const result = await window.hermesLogin.login({ phone: values.phone, smsCode: values.smsCode })

      if (!result.ok) {
        setError('requestError')

        return
      }

      setAccount(result.account)
      setFields({ phone: '', captchaCode: '', smsCode: '' })
    } catch {
      setError('requestError')
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  if (account) {
    return <ConnectingScreen />
  }

  return (
    <main className="desktop-login login-container">
      <section aria-labelledby="login-heading" className="login-card">
        <header className="login-header">
          <img alt={copy.brand} className="login-logo" src={loginBrandLogo} />
          <h1 className="sr-only" id="login-heading">
            {copy.title}
          </h1>
        </header>
        {restoring ? (
          <Loader className="login-loader" label={copy.title} />
        ) : (
          <form
            aria-busy={pending || sms.pending}
            className="login-form"
            noValidate
            onSubmit={event => void submit(event)}
          >
            <div className="login-field">
              <label className="sr-only" htmlFor="login-phone">
                {copy.phone}
              </label>
              <div className="login-input-group">
                <span className="login-addon">+86</span>
                <input
                  aria-describedby="login-error"
                  aria-invalid={error === 'phoneError'}
                  autoComplete="off"
                  className="login-input"
                  disabled={pending || sms.pending}
                  id="login-phone"
                  inputMode="tel"
                  maxLength={11}
                  onChange={event => updateField('phone', event.target.value.replace(/\D/g, '').slice(0, 11))}
                  placeholder={copy.phonePlaceholder}
                  type="tel"
                  value={fields.phone}
                />
              </div>
            </div>
            <div className="login-field">
              <label className="sr-only" htmlFor="login-captcha">
                {copy.captcha}
              </label>
              <div className="login-input-group">
                <input
                  aria-describedby="login-error"
                  aria-invalid={error === 'captchaError'}
                  className="login-input login-input-captcha"
                  disabled={pending || sms.pending}
                  id="login-captcha"
                  maxLength={6}
                  onChange={event => updateField('captchaCode', event.target.value)}
                  placeholder={copy.captchaPlaceholder}
                  type="text"
                  value={fields.captchaCode}
                />
                <button
                  aria-label={copy.refresh}
                  className="login-captcha-img"
                  disabled={!window.hermesLogin || pending || sms.pending}
                  onClick={() => {
                    updateField('captchaCode', '')
                    void image.refresh()
                  }}
                  type="button"
                >
                  {image.loading ? (
                    <Loader className="size-5" label={copy.refresh} />
                  ) : image.captcha ? (
                    <img alt={copy.captcha} src={image.captcha.imageDataUrl} />
                  ) : (
                    copy.refresh
                  )}
                </button>
              </div>
              {image.failed && (
                <p className="login-field-error" role="alert">
                  {copy.captchaLoadError}
                </p>
              )}
            </div>
            <div className="login-field">
              <label className="sr-only" htmlFor="login-sms">
                {copy.sms}
              </label>
              <div className="login-input-group">
                <input
                  aria-describedby="login-error"
                  aria-invalid={error === 'smsError'}
                  autoComplete="one-time-code"
                  className="login-input login-input-sms"
                  disabled={pending}
                  id="login-sms"
                  inputMode="numeric"
                  maxLength={6}
                  onChange={event => updateField('smsCode', event.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder={copy.smsPlaceholder}
                  type="text"
                  value={fields.smsCode}
                />
                <button
                  className="login-send-btn"
                  disabled={!window.hermesLogin || !image.captcha || pending || sms.pending || sms.seconds > 0}
                  onClick={() => void sendSms()}
                  type="button"
                >
                  {sms.pending
                    ? copy.send
                    : sms.seconds > 0
                      ? copy.resendAfter.replace('{seconds}', String(sms.seconds))
                      : copy.send}
                </button>
              </div>
              {sms.result && (
                <p
                  className={sms.result.ok ? 'login-field-status' : 'login-field-error'}
                  role={sms.result.ok ? 'status' : 'alert'}
                >
                  {sms.result.ok ? copy.smsSent : sms.result.error === 'limited' ? copy.smsLimited : copy.smsSendError}
                </p>
              )}
            </div>
            <p className="login-error" id="login-error" role="alert">
              {error ? copy[error] : ''}
            </p>
            <button className="login-btn" disabled={!window.hermesLogin || pending || sms.pending} type="submit">
              {pending ? <Loader className="size-5" label={copy.submit} /> : copy.submit}
            </button>
          </form>
        )}
        {!window.hermesLogin && (
          <p className="login-unavailable" role="status">
            {copy.unavailable}
          </p>
        )}
      </section>
    </main>
  )
}
