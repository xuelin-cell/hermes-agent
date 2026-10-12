import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

const localApi = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue({ sessions: [{ id: 'local-session', title: 'Local', profile: 'default' }] }),
  messages: vi.fn().mockResolvedValue({
    messages: [{ role: 'assistant', timestamp: 1000, content: 'MEDIA:/tmp/local-report.txt' }]
  })
}))

vi.mock('@/hermes', async () => ({
  ...(await vi.importActual('@/hermes')),
  listAllProfileSessions: localApi.list,
  getAllSessionMessages: localApi.messages
}))

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  localStorage.clear()
})

it('云盘保留待接入界面和禁用操作，不请求接口或消费旧 Web 登录记录', async () => {
  const legacyKeys = ['auth_token', 'user_info', 'api_token_info', 'auth_application']
  localStorage.setItem('auth_application', 'uniwork')
  localStorage.setItem('auth_token', 'legacy-token')
  localStorage.setItem('user_info', JSON.stringify({ phone: '13800000000', token: 'legacy-token' }))
  const reads = vi.spyOn(Storage.prototype, 'getItem')
  const removals = vi.spyOn(Storage.prototype, 'removeItem')
  const request = vi.fn().mockRejectedValue(new Error('Unexpected cloud request'))
  vi.stubGlobal('hermesDesktop', { api: request })
  vi.stubGlobal('fetch', request)
  const { ArtifactsView } = await import('./index')

  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <ArtifactsView />
      </MemoryRouter>
    </I18nProvider>
  )

  expect(screen.getByText('云盘接口待接入')).toBeTruthy()
  const search = screen.getByRole('textbox', { name: '搜索当前文件夹' })
  expect(search.hasAttribute('disabled')).toBe(true)

  for (const name of ['新建文件夹', '刷新', '重命名', '移入回收站', '预览', '下载']) {
    const button = screen.getByRole('button', { name })
    expect(button.hasAttribute('disabled')).toBe(true)
    fireEvent.click(button)
  }

  fireEvent.click(screen.getByRole('button', { name: '个人云盘' }))
  await Promise.resolve()
  expect(request).not.toHaveBeenCalled()
  expect(localApi.list).not.toHaveBeenCalled()
  expect(reads.mock.calls.filter(([key]) => legacyKeys.includes(key))).toEqual([])
  expect(removals.mock.calls.filter(([key]) => legacyKeys.includes(key))).toEqual([])
})

it('本地产物仍读取会话并展示文件，往返云盘不触发云盘接口', async () => {
  const request = vi.fn().mockRejectedValue(new Error('Unexpected cloud request'))
  vi.stubGlobal('hermesDesktop', { api: request })
  vi.stubGlobal('fetch', request)
  const { ArtifactsView } = await import('./index')
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <ArtifactsView />
      </MemoryRouter>
    </I18nProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: '本地产物' }))
  expect(await screen.findByRole('button', { name: 'local-report.txt' })).toBeTruthy()
  expect(localApi.list).toHaveBeenCalled()
  expect(localApi.messages).toHaveBeenCalledWith('local-session', 'default')
  fireEvent.click(screen.getByRole('button', { name: '个人云盘' }))
  expect(screen.getByText('云盘接口待接入')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '本地产物' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'local-report.txt' })).toBeTruthy())
  expect(request).not.toHaveBeenCalled()
})
