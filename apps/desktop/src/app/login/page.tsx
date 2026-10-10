import './login.css'

import { type FormEvent, useEffect, useRef, useState } from 'react'

import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { ConnectingScreen } from '@/components/ui/connecting-screen'
import { Input } from '@/components/ui/input'
import { Loader } from '@/components/ui/loader'
import { useI18n } from '@/i18n/context'

import type { LoginAccount } from '../../../electron/login/contract'
import { PAGE_INSET_X } from '../layout-constants'

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
    <main className={`desktop-login flex h-full overflow-y-auto py-8 ${PAGE_INSET_X}`}>
      <div className="m-auto grid w-full max-w-6xl gap-10 lg:grid-cols-[1.1fr_1fr]">
        <aside className="hidden flex-col justify-between gap-12 py-6 lg:flex">
          <div className="flex items-center gap-3 text-base font-semibold tracking-widest">
            <BrandMark className="size-9" />
            {copy.brand}
          </div>
          <div className="max-w-lg pb-10">
            <p className="text-5xl leading-tight font-semibold tracking-tight">
              {copy.headline}
              <span className="mt-2 block text-muted-foreground">{copy.headlineAccent}</span>
            </p>
            <p className="mt-7 max-w-sm text-sm leading-7 text-muted-foreground">{copy.subtitle}</p>
          </div>
        </aside>
        <section
          aria-labelledby="login-heading"
          className="desktop-login-panel m-auto w-full max-w-[26rem] space-y-6 rounded-3xl border border-(--ui-stroke-tertiary) p-6 shadow-nous sm:p-10"
        >
          <header className="space-y-2">
            <BrandMark className="mb-6 size-11 lg:hidden" />
            <p className="text-xs font-medium tracking-widest text-primary">{copy.welcome}</p>
            <h1 className="text-2xl font-bold tracking-tight" id="login-heading">
              {copy.title}
            </h1>
            <p className="text-sm leading-relaxed text-muted-foreground">{copy.subtitle}</p>
          </header>
          {restoring ? (
            <Loader className="mx-auto size-8" label={copy.title} />
          ) : (
            <form
              aria-busy={pending || sms.pending}
              className="space-y-4"
              noValidate
              onSubmit={event => void submit(event)}
            >
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground" htmlFor="login-phone">
                  {copy.phone}
                </label>
                <Input
                  aria-describedby="login-error"
                  aria-invalid={error === 'phoneError'}
                  autoComplete="off"
                  disabled={pending || sms.pending}
                  id="login-phone"
                  inputMode="tel"
                  maxLength={11}
                  onChange={event => updateField('phone', event.target.value)}
                  placeholder={copy.phonePlaceholder}
                  size="auth"
                  value={fields.phone}
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground" htmlFor="login-captcha">
                  {copy.captcha}
                </label>
                <div className="flex gap-2">
                  <Input
                    aria-describedby="login-error"
                    aria-invalid={error === 'captchaError'}
                    disabled={pending || sms.pending}
                    id="login-captcha"
                    maxLength={6}
                    onChange={event => updateField('captchaCode', event.target.value)}
                    placeholder={copy.captchaPlaceholder}
                    size="auth"
                    value={fields.captchaCode}
                  />
                  <Button
                    aria-label={copy.refresh}
                    disabled={!window.hermesLogin || pending || sms.pending}
                    loading={image.loading}
                    onClick={() => {
                      updateField('captchaCode', '')
                      void image.refresh()
                    }}
                    size="captcha"
                    type="button"
                    variant="grip"
                  >
                    {image.captcha ? (
                      <img
                        alt={copy.captcha}
                        className="h-11 w-auto max-w-full rounded-[0.625rem]"
                        src={image.captcha.imageDataUrl}
                      />
                    ) : (
                      copy.refresh
                    )}
                  </Button>
                </div>
                {image.failed && (
                  <p className="text-sm text-destructive" role="alert">
                    {copy.captchaLoadError}
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <label className="text-sm text-muted-foreground" htmlFor="login-sms">
                  {copy.sms}
                </label>
                <div className="flex gap-2">
                  <Input
                    aria-describedby="login-error"
                    aria-invalid={error === 'smsError'}
                    autoComplete="one-time-code"
                    disabled={pending}
                    id="login-sms"
                    inputMode="numeric"
                    maxLength={6}
                    onChange={event => updateField('smsCode', event.target.value)}
                    placeholder={copy.smsPlaceholder}
                    size="auth"
                    value={fields.smsCode}
                  />
                  <Button
                    disabled={!window.hermesLogin || !image.captcha || pending || sms.seconds > 0}
                    loading={sms.pending}
                    onClick={() => void sendSms()}
                    size="auth"
                    type="button"
                    variant="outline"
                  >
                    {sms.seconds > 0 ? copy.resendAfter.replace('{seconds}', String(sms.seconds)) : copy.send}
                  </Button>
                </div>
                {sms.result && (
                  <p
                    className={sms.result.ok ? 'text-sm text-muted-foreground' : 'text-sm text-destructive'}
                    role={sms.result.ok ? 'status' : 'alert'}
                  >
                    {sms.result.ok
                      ? copy.smsSent
                      : sms.result.error === 'limited'
                        ? copy.smsLimited
                        : copy.smsSendError}
                  </p>
                )}
              </div>
              <Button
                className="mt-2 w-full"
                disabled={!window.hermesLogin || sms.pending}
                loading={pending}
                size="auth"
                type="submit"
              >
                {copy.submit}
              </Button>
              <p className="text-sm text-destructive empty:hidden" id="login-error" role="alert">
                {error ? copy[error] : ''}
              </p>
            </form>
          )}
          {!window.hermesLogin && (
            <p className="text-center text-xs text-muted-foreground" role="status">
              {copy.unavailable}
            </p>
          )}
        </section>
      </div>
    </main>
  )
}
