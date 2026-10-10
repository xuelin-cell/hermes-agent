import { useEffect, useState } from 'react'

import { getUniWorkCaptcha, loginUniWorkSms, sendUniWorkSmsCode } from '@/api/auth'
import { BrandMark } from '@/components/brand-mark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { CheckCircle2, Loader2, Lock, RefreshCw } from '@/lib/icons'
import { completeUniWorkLogin } from '@/store/uniwork-auth'

const PHONE_RE = /^1[3-9]\d{9}$/

function messageOf(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback
}

export function LoginPage() {
  const [phone, setPhone] = useState('')
  const [captcha, setCaptcha] = useState('')
  const [captchaId, setCaptchaId] = useState('')
  const [captchaImage, setCaptchaImage] = useState('')
  const [smsCode, setSmsCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [loadingCaptcha, setLoadingCaptcha] = useState(false)
  const [sending, setSending] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const refreshCaptcha = async () => {
    setLoadingCaptcha(true)
    setError('')

    try {
      const result = await getUniWorkCaptcha()

      if (result.code !== undefined && result.code !== 0) {
        throw new Error(result.message || result.msg || '验证码加载失败')
      }

      const data = result.data ?? result
      setCaptchaId(data.captchaId ?? '')
      const raw = data.b64s ?? ''
      setCaptchaImage(raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`)
      setCaptcha('')
    } catch (nextError) {
      setError(messageOf(nextError, '验证码加载失败，请稍后重试'))
    } finally {
      setLoadingCaptcha(false)
    }
  }

  useEffect(() => void refreshCaptcha(), [])
  useEffect(() => {
    if (!countdown) {return}
    const timer = window.setInterval(() => setCountdown(value => Math.max(0, value - 1)), 1_000)

    return () => window.clearInterval(timer)
  }, [countdown])

  const sendCode = async () => {
    if (!PHONE_RE.test(phone)) {return setError('请输入有效的中国大陆手机号')}

    if (!captcha.trim() || !captchaId) {return setError('请先输入图形验证码')}
    setSending(true)
    setError('')

    try {
      const result = await sendUniWorkSmsCode(phone, captcha.trim(), captchaId)

      if (result.code !== undefined && result.code !== 0) {
        throw new Error(result.message || result.msg || '短信验证码发送失败')
      }

      setCountdown(60)
    } catch (nextError) {
      setError(messageOf(nextError, '短信验证码发送失败'))
      void refreshCaptcha()
    } finally {
      setSending(false)
    }
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()

    if (!PHONE_RE.test(phone)) {return setError('请输入有效的中国大陆手机号')}

    if (!smsCode.trim()) {return setError('请输入短信验证码')}
    setSubmitting(true)
    setError('')

    try {
      completeUniWorkLogin(await loginUniWorkSms(phone, smsCode.trim()), phone)
    } catch (nextError) {
      setError(messageOf(nextError, '登录失败，请检查验证码后重试'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="relative flex min-h-screen overflow-hidden bg-[#06090f] font-['Microsoft_YaHei','PingFang_SC','Segoe_UI',sans-serif] text-white">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_18%_22%,rgba(39,127,255,.18),transparent_34%),radial-gradient(circle_at_78%_72%,rgba(24,208,181,.10),transparent_30%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-[.08] [background-image:linear-gradient(rgba(255,255,255,.3)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.3)_1px,transparent_1px)] [background-size:48px_48px]" />

      <section className="relative hidden flex-1 flex-col justify-between p-14 lg:flex">
        <div className="flex items-center gap-3 text-base font-semibold tracking-[.08em]">
          <BrandMark className="size-9 rounded-lg" /> UNIWORK
        </div>
        <div className="max-w-xl pb-10">
          <p className="mb-5 text-xs font-medium tracking-[.3em] text-cyan-300/80">INTELLIGENT WORKSPACE</p>
          <h1 className="text-5xl leading-[1.16] font-semibold tracking-normal">
            让工作流动起来，
            <span className="text-white/45">让智能触手可及。</span>
          </h1>
          <p className="mt-7 max-w-md text-sm leading-7 text-white/48">
            一个账户连接你的智能助手、技能与个人资料库，跨设备延续每一次协作。
          </p>
        </div>
        <p className="text-[11px] tracking-wider text-white/25">SECURE · CONNECTED · PERSONAL</p>
      </section>

      <section className="relative flex w-full items-center justify-center p-6 lg:w-[46%]">
        <div className="w-full max-w-[410px] rounded-3xl border border-white/10 bg-white/[.055] p-8 shadow-2xl shadow-black/40 backdrop-blur-2xl sm:p-10">
          <div className="mb-8 lg:hidden"><BrandMark className="size-11" /></div>
          <p className="text-xs font-medium tracking-[.24em] text-cyan-300/80">WELCOME TO UNIWORK</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">登录你的工作空间</h2>
          <p className="mt-2 text-sm text-white/42">使用 UniWork 手机号继续</p>

          <form className="mt-8 space-y-4" onSubmit={submit}>
            <label className="block space-y-2">
              <span className="text-xs text-white/55">手机号</span>
              <Input autoComplete="tel" className="h-11 border-white/10 bg-black/20 px-3 text-sm text-white" inputMode="numeric" maxLength={11} onChange={e => setPhone(e.target.value.replace(/\D/g, ''))} placeholder="请输入手机号" value={phone} />
            </label>
            <label className="block space-y-2">
              <span className="text-xs text-white/55">图形验证码</span>
              <div className="flex gap-2">
                <Input className="h-11 flex-1 border-white/10 bg-black/20 px-3 text-sm text-white" onChange={e => setCaptcha(e.target.value)} placeholder="请输入验证码" value={captcha} />
                <button aria-label="刷新验证码" className="relative flex h-11 w-28 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-white/95" onClick={() => void refreshCaptcha()} type="button">
                  {loadingCaptcha ? <Loader2 className="size-4 animate-spin text-black/50" /> : captchaImage ? <img alt="图形验证码" className="h-full w-full object-contain" src={captchaImage} /> : <RefreshCw className="size-4 text-black/50" />}
                </button>
              </div>
            </label>
            <label className="block space-y-2">
              <span className="text-xs text-white/55">短信验证码</span>
              <div className="flex gap-2">
                <Input autoComplete="one-time-code" className="h-11 flex-1 border-white/10 bg-black/20 px-3 text-sm text-white" inputMode="numeric" maxLength={8} onChange={e => setSmsCode(e.target.value.replace(/\D/g, ''))} placeholder="请输入短信验证码" value={smsCode} />
                <Button className="h-11 min-w-28 border-white/10 text-white" disabled={sending || countdown > 0} onClick={() => void sendCode()} type="button" variant="outline">
                  {sending ? <Loader2 className="animate-spin" /> : countdown ? `${countdown}s` : '获取验证码'}
                </Button>
              </div>
            </label>

            {error && <p className="rounded-lg border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs text-red-200">{error}</p>}

            <Button className="mt-2 h-11 w-full bg-gradient-to-r from-blue-500 to-cyan-400 text-sm text-white hover:opacity-90" disabled={submitting} type="submit">
              {submitting ? <Loader2 className="animate-spin" /> : <Lock className="size-4" />}
              {submitting ? '正在登录…' : '安全登录'}
            </Button>
          </form>

          <div className="mt-6 flex items-center gap-2 text-[11px] leading-5 text-white/32">
            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-400/70" />
            登录即表示你同意 UniWork 服务条款与隐私政策
          </div>
        </div>
      </section>
    </main>
  )
}
