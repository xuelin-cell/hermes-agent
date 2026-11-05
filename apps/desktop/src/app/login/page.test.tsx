import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { TRANSLATIONS } from '@/i18n/catalog'
import { I18nProvider } from '@/i18n/context'
import type { Locale } from '@/i18n/types'

import type { LoginResult, PlanResult } from '../../../electron/login/contract'
import { LOGIN_LEGAL_DOCUMENTS } from '../../../electron/login/legal-documents'

import { LoginPage } from './page'

afterEach(() => {
  delete window.hermesLogin
  vi.useRealTimers()
})

/** 以无配置读取能力的中文环境挂载真实登录组件。 */
function renderLogin() {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <LoginPage />
    </I18nProvider>
  )
}

/** 通过真实输入事件填写表单，不依赖内部状态实现。 */
function fill(fields = { phone: '13800000000', captcha: 'abcd', sms: '123456' }): void {
  fireEvent.change(screen.getByLabelText('手机号'), { target: { value: fields.phone } })
  fireEvent.change(screen.getByLabelText('图形验证码'), { target: { value: fields.captcha } })
  fireEvent.change(screen.getByLabelText('短信验证码'), { target: { value: fields.sms } })
}

describe('桌面登录表单', () => {
  it.each<Locale>(['zh', 'en', 'zh-hant'])('以 %s 显示协议并通过登录桥打开，失败后表单仍然可用', async locale => {
    const copy = TRANSLATIONS[locale].desktopLogin
    const openLegalDocument = vi.fn().mockResolvedValue(true)
    window.hermesLogin = {
      openLegalDocument,
      restore: vi.fn().mockResolvedValue({ ok: false }),
      plan: vi.fn(),
      captcha: vi.fn().mockResolvedValue({ ok: false }),
      sendSms: vi.fn(),
      login: vi.fn()
    }
    render(
      <I18nProvider configClient={null} initialLocale={locale}>
        <LoginPage />
      </I18nProvider>
    )
    const nav = await screen.findByRole('navigation', { name: copy.legalLinksLabel })
    expect(nav.textContent).toContain(copy.legalConsentPrefix)
    const form = screen.getByRole('button', { name: copy.submit }).closest('form')!
    expect(form.contains(nav)).toBe(true)

    for (const [key, label] of [
      ['privacy', copy.privacyPolicy],
      ['service', copy.userAgreement]
    ] as const) {
      const link = screen.getByRole('link', { name: label })
      expect(link.getAttribute('href')).toBe(LOGIN_LEGAL_DOCUMENTS[key])
      expect(link.getAttribute('target')).toBe('_blank')
      fireEvent.click(link)
      await waitFor(() => expect(openLegalDocument).toHaveBeenLastCalledWith(key))
    }

    openLegalDocument.mockResolvedValueOnce(false)
    fireEvent.click(screen.getByRole('link', { name: copy.privacyPolicy }))
    await screen.findByText(copy.legalOpenError)
    expect(window.hermesLogin.login).not.toHaveBeenCalled()
    expect((screen.getByLabelText(copy.phone) as HTMLInputElement).disabled).toBe(false)
  })

  it('发送短信先校验输入，失败可修正刷新，成功显示倒计时并禁止重复发送', async () => {
    const captcha = vi.fn().mockResolvedValue({
      ok: true,
      captcha: { captchaId: 'test-id', imageDataUrl: 'data:image/png;base64,aGVsbG8=' }
    })

    const sendSms = vi.fn().mockResolvedValueOnce({ ok: false, error: 'failed' })
    window.hermesLogin = {
      openLegalDocument: vi.fn().mockResolvedValue(true),
      restore: vi.fn().mockResolvedValue({ ok: false }),
      plan: vi.fn().mockResolvedValue({ status: 'empty' }),
      captcha,
      sendSms,
      login: vi.fn()
    }
    renderLogin()
    await screen.findByRole('img', { name: '图形验证码' })
    const sendButton = screen.getByRole<HTMLButtonElement>('button', { name: '发送验证码' })
    expect(sendButton.disabled).toBe(true)
    fill({ phone: '12800000000', captcha: 'abcd', sms: '' })
    expect(sendButton.disabled).toBe(true)
    fill({ phone: '13800000000', captcha: '  ', sms: '' })
    expect(sendButton.disabled).toBe(true)
    fireEvent.click(sendButton)
    expect(sendSms).not.toHaveBeenCalled()
    fill()
    expect(sendButton.disabled).toBe(false)
    fireEvent.click(sendButton)
    const failure = await screen.findByText('发送失败，请检查输入或刷新图片后重试。')
    const invitation = screen.getByLabelText('邀请码（选填）')
    expect(invitation.compareDocumentPosition(failure)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(sendSms).toHaveBeenCalledWith({ phone: '13800000000', captchaCode: 'abcd', captchaId: 'test-id' })
    expect((screen.getByRole('button', { name: '发送验证码' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('img', { name: '图形验证码' }))
    await screen.findByRole('img', { name: '图形验证码' })
    expect((screen.getByLabelText('图形验证码') as HTMLInputElement).value).toBe('')
    fill()
    sendSms.mockResolvedValueOnce({ ok: true, retryAt: Date.now() + 60_000 })
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }))
    const resend = await screen.findByRole('button', { name: /秒后重发/ })
    expect(screen.queryByRole('alert')).toBeNull()
    expect((resend as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(resend)
    expect(sendSms).toHaveBeenCalledTimes(2)
    expect((screen.getByRole('button', { name: '登录' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('按验证码失败原因提示，并清除已失效的输入', async () => {
    const captcha = vi.fn().mockResolvedValue({
      ok: true,
      captcha: { captchaId: 'id', imageDataUrl: 'data:image/png;base64,aGVsbG8=' }
    })

    window.hermesLogin = {
      openLegalDocument: vi.fn(),
      restore: vi.fn().mockResolvedValue({ ok: false }),
      plan: vi.fn(),
      captcha,
      sendSms: vi.fn().mockResolvedValue({ ok: false, error: 'captchaExpired' }),
      login: vi
        .fn()
        .mockResolvedValueOnce({ ok: false, reason: 'smsIncorrect' })
        .mockResolvedValueOnce({ ok: false, reason: 'smsExpired' })
    }
    renderLogin()
    await screen.findByRole('img', { name: '图形验证码' })
    fill()
    const imageCode = screen.getByLabelText<HTMLInputElement>('图形验证码')
    const smsCode = screen.getByLabelText<HTMLInputElement>('短信验证码')
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }))
    await screen.findByText('图形验证码已失效，请刷新后重试。')
    expect(imageCode.value).toBe('')
    expect(imageCode.getAttribute('aria-invalid')).toBe('true')

    const login = screen.getByRole('button', { name: '登录' })
    fireEvent.click(login)
    await screen.findByText('短信验证码错误，请重新输入。')
    expect(smsCode.value).toBe('123456')
    expect(captcha).toHaveBeenCalledTimes(1)

    fill({ phone: '13800000000', captcha: 'abcd', sms: '654321' })
    fireEvent.click(login)
    await screen.findByText('验证码失效，请重新发送短信。')
    expect(imageCode.value).toBe('')
    expect(smsCode.value).toBe('')
    expect(captcha).toHaveBeenCalledTimes(2)
  })

  it('未接入服务时按钮不可用，填写或提交不能进入账号环境', () => {
    renderLogin()
    fill()

    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true)
    }

    fireEvent.submit(screen.getByRole('button', { name: '登录' }).closest('form')!)
    expect(screen.getByRole('status').textContent).toContain('短信登录功能正在接入')
    expect((screen.getByLabelText('手机号') as HTMLInputElement).value).toBe('13800000000')
  })

  it('依次显示字段错误，不把不合格输入传给登录动作', async () => {
    const submit = vi.fn()
    window.hermesLogin = {
      openLegalDocument: vi.fn().mockResolvedValue(true),
      restore: vi.fn().mockResolvedValue({ ok: false }),
      plan: vi.fn().mockResolvedValue({ status: 'empty' }),
      captcha: vi
        .fn()
        .mockResolvedValue({ ok: true, captcha: { captchaId: 'id', imageDataUrl: 'data:image/png;base64,aGVsbG8=' } }),
      sendSms: vi.fn(),
      login: submit
    }
    renderLogin()
    await screen.findByLabelText('手机号')
    const button = screen.getByRole<HTMLButtonElement>('button', { name: '登录' })
    const form = button.closest('form')!
    expect(button.disabled).toBe(true)
    fill({ phone: '12800000000', captcha: '', sms: '123456' })
    expect(button.disabled).toBe(true)
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toContain('11 位手机号')
    fill({ phone: '13800000000', captcha: '', sms: '' })
    expect(button.disabled).toBe(true)
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toContain('6 位数字')
    fill({ phone: '13800000000', captcha: 'abcd', sms: '123' })
    expect(button.disabled).toBe(false)
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toContain('6 位数字')
    expect(submit).not.toHaveBeenCalled()
    fill({ phone: '13800000000', captcha: '', sms: '123456' })
    expect(button.disabled).toBe(false)
  })

  it('邀请码错误替换短信提示，清空并重试时省略该字段', async () => {
    const login = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, reason: 'invitationUsed' })
      .mockResolvedValue({ ok: false })

    window.hermesLogin = {
      openLegalDocument: vi.fn(),
      restore: vi.fn().mockResolvedValue({ ok: false }),
      plan: vi.fn(),
      captcha: vi
        .fn()
        .mockResolvedValue({ ok: true, captcha: { captchaId: 'id', imageDataUrl: 'data:image/png;base64,aGVsbG8=' } }),
      sendSms: vi.fn().mockResolvedValue({ ok: false, error: 'limited', retryAt: Date.now() + 60_000 }),
      login
    }
    renderLogin()
    const invitation = await screen.findByRole<HTMLInputElement>('textbox', { name: '邀请码（选填）' })
    const button = screen.getByRole('button', { name: '登录' })
    fill()
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }))
    await screen.findByText('发送过于频繁，请稍后重试。')
    fireEvent.change(invitation, { target: { value: '  INVITE-1  ' } })
    fireEvent.click(button)
    const invitationError = await screen.findByText(/已使用过邀请码/)
    expect(invitation.compareDocumentPosition(invitationError)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.queryByText('发送过于频繁，请稍后重试。')).toBeNull()
    expect(login).toHaveBeenNthCalledWith(1, { phone: '13800000000', smsCode: '123456', invitationCode: 'INVITE-1' })
    expect(invitation.getAttribute('aria-invalid')).toBe('true')
    expect(invitation.value).toBe('  INVITE-1  ')

    fireEvent.change(invitation, { target: { value: ' ' } })
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.click(button)
    await screen.findByText('登录失败，请重试。')
    expect(login).toHaveBeenNthCalledWith(2, { phone: '13800000000', smsCode: '123456' })
  })

  it('提交期间禁用输入并合并重复提交，失败后展示安全错误并可重试', async () => {
    let reject!: (reason: Error) => void

    const submit = vi.fn(
      () =>
        new Promise<LoginResult>((_resolve, fail) => {
          reject = fail
        })
    )

    window.hermesLogin = {
      openLegalDocument: vi.fn().mockResolvedValue(true),
      restore: vi.fn().mockResolvedValue({ ok: false }),
      plan: vi.fn().mockResolvedValue({ status: 'empty' }),
      captcha: vi
        .fn()
        .mockResolvedValue({ ok: true, captcha: { captchaId: 'id', imageDataUrl: 'data:image/png;base64,aGVsbG8=' } }),
      sendSms: vi.fn(),
      login: submit
    }
    renderLogin()
    await screen.findByLabelText('手机号')
    fill()
    const button = screen.getByRole('button', { name: '登录' })
    const form = button.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith({ phone: '13800000000', smsCode: '123456' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('手机号') as HTMLInputElement).disabled).toBe(true)
    await act(async () => reject(new Error('secret-response-must-not-render')))
    expect(screen.getByRole('alert').textContent).toContain('登录失败，请重试')
    expect(screen.queryByText('secret-response-must-not-render')).toBeNull()
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('短信验证码'), { target: { value: '654321' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('点击验证码图片刷新并清空旧输入，失败后原位置可以重试', async () => {
    const imageDataUrl = 'data:image/png;base64,aGVsbG8='
    const captcha = vi.fn().mockResolvedValue({ ok: true, captcha: { captchaId: 'first', imageDataUrl } })
    window.hermesLogin = {
      openLegalDocument: vi.fn().mockResolvedValue(true),
      restore: vi.fn().mockResolvedValue({ ok: false }),
      plan: vi.fn().mockResolvedValue({ status: 'empty' }),
      captcha,
      sendSms: vi.fn(),
      login: vi.fn()
    }
    renderLogin()
    const image = await screen.findByRole('img', { name: '图形验证码' })
    fill()
    captcha.mockResolvedValueOnce({ ok: false })
    fireEvent.click(image)
    await waitFor(() => expect(captcha).toHaveBeenCalledTimes(2))
    expect((screen.getByLabelText('图形验证码') as HTMLInputElement).value).toBe('')
    const feedback = await screen.findByText('图形验证码获取失败，请点击刷新图片重试。')
    expect(screen.getByLabelText('邀请码（选填）').compareDocumentPosition(feedback)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
    fireEvent.click(screen.getByRole('button', { name: '刷新图片' }))
    await screen.findByRole('img', { name: '图形验证码' })
    expect(captcha).toHaveBeenCalledTimes(3)
  })

  it('登录成功立即显示官方启动画面并后台查套餐；到期后要求重新登录', async () => {
    vi.useFakeTimers()

    const login = vi
      .fn()
      .mockResolvedValue({ ok: true, account: { maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 } })

    window.hermesLogin = {
      openLegalDocument: vi.fn().mockResolvedValue(true),
      restore: vi.fn().mockResolvedValue({ ok: false }),
      plan: vi.fn().mockResolvedValue({ status: 'empty' }),
      captcha: vi.fn().mockResolvedValue({ ok: false }),
      sendSms: vi.fn(),
      login
    }
    renderLogin()
    await act(async () => {})
    fill({ phone: '13800000000', captcha: '', sms: '123456' })
    await act(async () => fireEvent.submit(screen.getByRole('button', { name: '登录' }).closest('form')!))
    expect(screen.getByRole('status', { name: 'CONNECTING' })).toBeTruthy()
    expect(screen.queryByText(/138\*\*\*\*0000|MaaS 套餐/)).toBeNull()
    expect(window.hermesLogin.plan).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('手机号')).toBeNull()
    act(() => vi.advanceTimersByTime(60_000))
    expect((screen.getByLabelText('手机号') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('短信验证码') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('登录已到期，请重新登录。')).toBeTruthy()
    vi.useRealTimers()
  })

  it('恢复账号后进入同款启动画面且不取图或登录；到期再显示空表单', async () => {
    let resolve!: (result: LoginResult) => void

    const restore = vi.fn(
      () =>
        new Promise<LoginResult>(done => {
          resolve = done
        })
    )

    const captcha = vi.fn().mockResolvedValue({ ok: false })
    const login = vi.fn()
    window.hermesLogin = {
      openLegalDocument: vi.fn().mockResolvedValue(true),
      restore,
      plan: vi.fn().mockResolvedValue({ status: 'empty' }),
      captcha,
      sendSms: vi.fn(),
      login
    }
    renderLogin()
    expect(screen.queryByLabelText('手机号')).toBeNull()
    expect(captcha).not.toHaveBeenCalled()
    vi.useFakeTimers()
    await act(async () =>
      resolve({ ok: true, account: { maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 } })
    )
    expect(screen.getByRole('status', { name: 'CONNECTING' })).toBeTruthy()
    expect(window.hermesLogin.plan).toHaveBeenCalledTimes(1)
    expect(screen.queryByLabelText('手机号')).toBeNull()
    expect(captcha).not.toHaveBeenCalled()
    expect(login).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(60_000))
    expect((screen.getByLabelText('手机号') as HTMLInputElement).value).toBe('')
    expect(screen.getByText('登录已到期，请重新登录。')).toBeTruthy()
    expect(captcha).toHaveBeenCalledTimes(1)
  })

  it('恢复通信失败回到可用登录表单，不回显错误细节', async () => {
    const captcha = vi.fn().mockResolvedValue({ ok: false })
    window.hermesLogin = {
      openLegalDocument: vi.fn().mockResolvedValue(true),
      restore: vi.fn().mockRejectedValue(new Error('private-restore-detail')),
      plan: vi.fn().mockResolvedValue({ status: 'empty' }),
      captcha,
      sendSms: vi.fn(),
      login: vi.fn()
    }
    renderLogin()
    await screen.findByLabelText('手机号')
    expect(screen.queryByText('private-restore-detail')).toBeNull()
    expect(captcha).toHaveBeenCalledTimes(1)
  })

  it.each<PlanResult>([
    { status: 'available', models: [{ name: 'private-model-name', isDefault: true }] },
    { status: 'empty' },
    { status: 'failed' },
    { status: 'failed', reason: 'auth' }
  ])('套餐等待及 $status 结果都保留同一个启动画面，不展示卡片或追加请求', async result => {
    let finish!: (value: PlanResult) => void

    const plan = vi.fn(
      () =>
        new Promise<PlanResult>(resolve => {
          finish = resolve
        })
    )

    window.hermesLogin = {
      openLegalDocument: vi.fn().mockResolvedValue(true),
      restore: vi.fn().mockResolvedValue({
        ok: true,
        account: { maskedPhone: '138****0000', expiresAt: Date.now() + 60_000 }
      }),
      plan,
      captcha: vi.fn(),
      sendSms: vi.fn(),
      login: vi.fn()
    }
    renderLogin()
    const screenBeforePlan = await screen.findByRole('status', { name: 'CONNECTING' })
    expect(screen.queryByRole('heading')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    await act(async () => finish(result))
    expect(screen.getByRole('status', { name: 'CONNECTING' })).toBe(screenBeforePlan)
    expect(screen.queryByText(/MaaS|private-model-name|138\*\*\*\*0000/)).toBeNull()
    expect(plan).toHaveBeenCalledTimes(1)
  })
})
