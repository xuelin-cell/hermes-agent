import './login.css'

import { type FormEvent, type MouseEvent, useEffect, useRef, useState } from 'react'

import loginBrandLogo from '@/assets/login-brand-logo.png'
import { ConnectingScreen } from '@/components/ui/connecting-screen'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n/context'

import type { InvitationLoginError, LoginAccount, SmsLoginError } from '../../../electron/login/contract'
import { LOGIN_LEGAL_DOCUMENTS, type LoginLegalDocument } from '../../../electron/login/legal-documents'

import { useCaptcha } from './use-captcha'
import { useSms } from './use-sms'

interface LoginFields {
  phone: string
  captchaCode: string
  smsCode: string
  invitationCode: string
}

const EMPTY_FIELDS: LoginFields = { phone: '', captchaCode: '', smsCode: '', invitationCode: '' }

const SMS_FEEDBACK = {
  invalid: 'smsSendError',
  busy: 'smsSendError',
  failed: 'smsSendError',
  limited: 'smsLimited',
  captchaIncorrect: 'captchaIncorrect',
  captchaExpired: 'captchaExpired'
} as const

/** 展示短信登录表单；未接入主进程能力时禁用动作，不提供免登录入口。 */
export function LoginPage() {
  const { t } = useI18n()
  const copy = t.desktopLogin
  const bridge = window.hermesLogin
  const [account, setAccount] = useState<LoginAccount | null>(null)
  const [restoring, setRestoring] = useState(!!bridge)
  const image = useCaptcha(!restoring && !account ? bridge : undefined)
  const sms = useSms(bridge)
  const [fields, setFields] = useState(EMPTY_FIELDS)

  const [error, setError] = useState<
    | 'phoneError'
    | 'captchaError'
    | 'smsError'
    | 'requestError'
    | 'storageError'
    | 'legalOpenError'
    | InvitationLoginError
    | SmsLoginError
    | null
  >(null)

  const [pending, setPending] = useState(false)
  const submitting = useRef(false)
  const phoneValid = /^1[3-9]\d{9}$/.test(fields.phone)
  const captchaCode = fields.captchaCode.trim()

  const smsFeedback = sms.result?.ok === false ? SMS_FEEDBACK[sms.result.error] : null

  const feedback = error ?? (image.failed ? 'captchaLoadError' : smsFeedback) ?? (!bridge ? 'unavailable' : null)
  const feedbackId = feedback ? 'login-feedback' : undefined
  const feedbackRole = feedback === 'unavailable' ? 'status' : 'alert'

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

  /** 修改输入时清除旧错误，验证码和手机号仅保留在当前页面内存中。 */
  function updateField(field: keyof LoginFields, value: string): void {
    setFields(previous => ({ ...previous, [field]: value }))
    setError(null)
  }

  /** 先校验手机号和当前图片输入，通过后才调用主进程发送短信。 */
  async function sendSms(): Promise<void> {
    if (!phoneValid) {
      return setError('phoneError')
    }

    if (!captchaCode || !image.captcha) {
      return setError('captchaError')
    }

    setError(null)
    const result = await sms.send({ phone: fields.phone, captchaCode, captchaId: image.captcha.captchaId })

    if (result?.ok === false && (result.error === 'captchaIncorrect' || result.error === 'captchaExpired')) {
      setFields(previous => ({ ...previous, captchaCode: '' }))
    }
  }

  /** 主进程确认登录后清空页面输入。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    if (!bridge || account || submitting.current || sms.pending) {
      return
    }

    const { phone, smsCode } = fields
    const invalid = !phoneValid ? 'phoneError' : !/^\d{6}$/.test(smsCode) ? 'smsError' : null

    sms.clearResult()
    setError(invalid)

    if (invalid) {
      return
    }

    submitting.current = true
    setPending(true)

    try {
      const invitationCode = fields.invitationCode.trim()
      const result = await bridge.login({ phone, smsCode, ...(invitationCode ? { invitationCode } : {}) })

      if (!result.ok) {
        setError(result.reason === 'storage' ? 'storageError' : (result.reason ?? 'requestError'))

        if (result.reason === 'smsExpired') {
          setFields(previous => ({ ...previous, captchaCode: '', smsCode: '' }))
          void image.refresh()
        }

        return
      }

      setAccount(result.account)
      setFields(EMPTY_FIELDS)
    } catch {
      setError('requestError')
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  async function openLegalDocument(event: MouseEvent<HTMLAnchorElement>, document: LoginLegalDocument): Promise<void> {
    if (!bridge) {
      return
    }

    event.preventDefault()

    try {
      if (!(await bridge.openLegalDocument(document))) {
        setError('legalOpenError')
      }
    } catch {
      setError('legalOpenError')
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
                  aria-describedby={feedbackId}
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
                  aria-describedby={feedbackId}
                  aria-invalid={
                    feedback === 'captchaError' || feedback === 'captchaIncorrect' || feedback === 'captchaExpired'
                  }
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
                    sms.clearResult()
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
            </div>
            <div className="login-field">
              <label className="sr-only" htmlFor="login-sms">
                {copy.sms}
              </label>
              <div className="login-input-group">
                <input
                  aria-describedby={feedbackId}
                  aria-invalid={error === 'smsError' || error === 'smsIncorrect' || error === 'smsExpired'}
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
                  disabled={
                    !bridge ||
                    !phoneValid ||
                    !captchaCode ||
                    !image.captcha ||
                    pending ||
                    sms.pending ||
                    sms.seconds > 0
                  }
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
            </div>
            <div className="login-field">
              <label className="sr-only" htmlFor="login-invitation">
                {copy.invitationCodePlaceholder}
              </label>
              <div className="login-input-group">
                <input
                  aria-describedby={feedbackId}
                  aria-invalid={error?.startsWith('invitation') ?? false}
                  autoComplete="off"
                  className="login-input"
                  disabled={pending}
                  id="login-invitation"
                  onChange={event => updateField('invitationCode', event.target.value)}
                  placeholder={copy.invitationCodePlaceholder}
                  spellCheck={false}
                  type="text"
                  value={fields.invitationCode}
                />
              </div>
            </div>
            {feedback && (
              <p className="login-feedback" id={feedbackId} role={feedbackRole}>
                {copy[feedback]}
              </p>
            )}
            <button
              className="login-btn"
              disabled={!bridge || !phoneValid || !fields.smsCode || pending || sms.pending}
              type="submit"
            >
              {pending ? <Loader className="size-5" label={copy.submit} /> : copy.submit}
            </button>
            <nav aria-label={copy.legalLinksLabel} className="login-legal-consent">
              <span>{copy.legalConsentPrefix}</span>
              <a
                className="login-legal-link"
                href={LOGIN_LEGAL_DOCUMENTS.privacy}
                onClick={event => void openLegalDocument(event, 'privacy')}
                rel="noopener noreferrer"
                target="_blank"
              >
                {copy.privacyPolicy}
              </a>
              <span>{copy.legalConsentConnector}</span>
              <a
                className="login-legal-link"
                href={LOGIN_LEGAL_DOCUMENTS.service}
                onClick={event => void openLegalDocument(event, 'service')}
                rel="noopener noreferrer"
                target="_blank"
              >
                {copy.userAgreement}
              </a>
            </nav>
          </form>
        )}
      </section>
    </main>
  )
}
