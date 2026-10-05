import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n/context'

import { AccountExitPage } from './exit-page'

it('只显示本地化退出状态和官方加载动效，不挂载登录表单或调用登录桥接', () => {
  const restore = vi.fn()
  window.hermesLogin = { restore, plan: vi.fn(), captcha: vi.fn(), sendSms: vi.fn(), login: vi.fn() }
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <AccountExitPage />
    </I18nProvider>
  )
  expect(screen.getByRole('status', { name: '正在退出账号…' })).toBeTruthy()
  expect(window.document.querySelector('.decode-cursor-blink')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(restore).not.toHaveBeenCalled()
  delete window.hermesLogin
})
