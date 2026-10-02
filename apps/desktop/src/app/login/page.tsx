import { type FormEvent, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n/context'

import { PAGE_INSET_X } from '../layout-constants'

import { useCaptcha } from './use-captcha'

export interface LoginFields {
  phone: string
  captchaCode: string
  smsCode: string
}

export interface LoginPageProps {
  onSubmit?: (fields: LoginFields) => Promise<void>
}

/** 展示短信登录表单；未接入主进程能力时禁用动作，不提供免登录入口。 */
export function LoginPage({ onSubmit }: LoginPageProps) {
  const { t } = useI18n()
  const copy = t.desktopLogin
  const image = useCaptcha(window.hermesLogin)
  const [fields, setFields] = useState<LoginFields>({ phone: '', captchaCode: '', smsCode: '' })
  const [error, setError] = useState<'phoneError' | 'captchaError' | 'smsError' | 'requestError' | null>(null)
  const [pending, setPending] = useState(false)
  const submitting = useRef(false)

  /** 修改输入时清除旧错误，验证码和手机号仅保留在当前页面内存中。 */
  function updateField(field: keyof LoginFields, value: string): void {
    setFields(previous => ({ ...previous, [field]: value }))
    setError(null)
  }

  /** 本地校验和重复提交保护；真正的身份判断仍由后续主进程 Login 完成。 */
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()

    if (!onSubmit || submitting.current) {
      return
    }

    const values = {
      phone: fields.phone.trim(),
      captchaCode: fields.captchaCode.trim(),
      smsCode: fields.smsCode.trim()
    }

    const invalid = !/^1\d{10}$/.test(values.phone)
      ? 'phoneError'
      : !values.captchaCode || values.captchaCode.length > 6
        ? 'captchaError'
        : !/^\d{6}$/.test(values.smsCode)
          ? 'smsError'
          : null

    setError(invalid)

    if (invalid) {
      return
    }

    submitting.current = true
    setPending(true)

    try {
      await onSubmit(values)
    } catch {
      setError('requestError')
    } finally {
      submitting.current = false
      setPending(false)
    }
  }

  return (
    <main className={`flex h-full overflow-y-auto py-8 ${PAGE_INSET_X}`}>
      <section aria-labelledby="login-heading" className="m-auto w-full max-w-sm space-y-6">
        <header className="space-y-2">
          <h1 className="text-xl font-semibold" id="login-heading">
            {copy.title}
          </h1>
          <p className="text-sm text-muted-foreground">{copy.subtitle}</p>
        </header>
        <form aria-busy={pending} className="space-y-4" noValidate onSubmit={event => void submit(event)}>
          <div className="space-y-2">
            <label className="text-sm" htmlFor="login-phone">
              {copy.phone}
            </label>
            <Input
              aria-describedby="login-error"
              aria-invalid={error === 'phoneError'}
              autoComplete="off"
              disabled={pending}
              id="login-phone"
              inputMode="tel"
              maxLength={11}
              onChange={event => updateField('phone', event.target.value)}
              size="lg"
              value={fields.phone}
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm" htmlFor="login-captcha">
              {copy.captcha}
            </label>
            <div className="flex gap-2">
              <Input
                aria-describedby="login-error"
                aria-invalid={error === 'captchaError'}
                disabled={pending}
                id="login-captcha"
                maxLength={6}
                onChange={event => updateField('captchaCode', event.target.value)}
                size="lg"
                value={fields.captchaCode}
              />
              <Button
                disabled={!window.hermesLogin || pending}
                loading={image.loading}
                onClick={() => {
                  updateField('captchaCode', '')
                  void image.refresh()
                }}
                size="lg"
                type="button"
                variant="secondary"
              >
                {copy.refresh}
              </Button>
            </div>
            {image.captcha && <img alt={copy.captcha} className="h-10" src={image.captcha.imageDataUrl} />}
            {image.failed && (
              <p className="text-sm text-destructive" role="alert">
                {copy.captchaLoadError}
              </p>
            )}
          </div>
          <div className="space-y-2">
            <label className="text-sm" htmlFor="login-sms">
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
                size="lg"
                value={fields.smsCode}
              />
              <Button disabled size="lg" type="button" variant="secondary">
                {copy.send}
              </Button>
            </div>
          </div>
          <Button className="w-full" disabled={!onSubmit} loading={pending} size="lg" type="submit">
            {copy.submit}
          </Button>
          <p className="min-h-5 text-sm text-destructive" id="login-error" role="alert">
            {error ? copy[error] : ''}
          </p>
        </form>
        {!onSubmit && (
          <p className="text-sm text-muted-foreground" role="status">
            {copy.unavailable}
          </p>
        )}
      </section>
    </main>
  )
}
