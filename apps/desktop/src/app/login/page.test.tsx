import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'

import { LoginPage, type LoginPageProps } from './page'

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
    expect(screen.getByRole('status').textContent).toContain('登录服务尚未接通')
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
})
