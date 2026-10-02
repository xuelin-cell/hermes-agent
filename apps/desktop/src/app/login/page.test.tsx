import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'

import { LoginPage, type LoginPageProps } from './page'

afterEach(() => {
  delete window.hermesLogin
})

/** 以无配置读取能力的中文环境挂载真实登录组件。 */
function renderLogin(props: LoginPageProps = {}) {
  return render(
    <I18nProvider configClient={null} initialLocale="zh">
      <LoginPage {...props} />
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

  it('依次显示字段错误，不把不合格输入传给登录动作', () => {
    const submit = vi.fn()
    renderLogin({ onSubmit: submit })
    const form = screen.getByRole('button', { name: '登录' }).closest('form')!
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toContain('11 位手机号')
    fill({ phone: '13800000000', captcha: '', sms: '' })
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toContain('图形验证码')
    fill({ phone: '13800000000', captcha: 'abcd', sms: '123' })
    fireEvent.submit(form)
    expect(screen.getByRole('alert').textContent).toContain('6 位数字')
    expect(submit).not.toHaveBeenCalled()
  })

  it('提交期间禁用输入并合并重复提交，失败后展示安全错误并可重试', async () => {
    let reject!: (reason: Error) => void

    const submit = vi.fn(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail
        })
    )

    renderLogin({ onSubmit: submit })
    fill()
    const button = screen.getByRole('button', { name: '登录' })
    const form = button.closest('form')!
    fireEvent.submit(form)
    fireEvent.submit(form)
    expect(submit).toHaveBeenCalledTimes(1)
    expect(submit).toHaveBeenCalledWith({ phone: '13800000000', captchaCode: 'abcd', smsCode: '123456' })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByLabelText('手机号') as HTMLInputElement).disabled).toBe(true)
    await act(async () => reject(new Error('secret-response-must-not-render')))
    expect(screen.getByRole('alert').textContent).toContain('登录失败，请重试')
    expect(screen.queryByText('secret-response-must-not-render')).toBeNull()
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('短信验证码'), { target: { value: '654321' } })
    expect(screen.getByRole('alert').textContent).toBe('')
  })

  it('点击验证码图片刷新并清空旧输入，失败后原位置可以重试', async () => {
    const imageDataUrl = 'data:image/png;base64,aGVsbG8='
    const captcha = vi.fn().mockResolvedValue({ ok: true, captcha: { captchaId: 'first', imageDataUrl } })
    window.hermesLogin = { captcha }
    renderLogin()
    const image = await screen.findByRole('img', { name: '图形验证码' })
    fill()
    captcha.mockResolvedValueOnce({ ok: false })
    fireEvent.click(image)
    await waitFor(() => expect(captcha).toHaveBeenCalledTimes(2))
    expect((screen.getByLabelText('图形验证码') as HTMLInputElement).value).toBe('')
    await screen.findByText('图形验证码获取失败，请点击刷新图片重试。')
    fireEvent.click(screen.getByRole('button', { name: '刷新图片' }))
    await screen.findByRole('img', { name: '图形验证码' })
    expect(captcha).toHaveBeenCalledTimes(3)
  })
})
