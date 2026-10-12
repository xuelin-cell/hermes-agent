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

// 重组件在收集阶段加载，避免把转译时间计入单个交互测试。
const { ArtifactsView } = await import('./index')

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  localStorage.clear()
})

it('云盘通过桌面身份加载分页数据，不消费旧 Web 登录记录', async () => {
  const legacyKeys = ['auth_token', 'user_info', 'api_token_info', 'auth_application']
  localStorage.setItem('auth_application', 'uniwork')
  localStorage.setItem('auth_token', 'legacy-token')
  localStorage.setItem('user_info', JSON.stringify({ phone: '13800000000', token: 'legacy-token' }))
  const reads = vi.spyOn(Storage.prototype, 'getItem')
  const removals = vi.spyOn(Storage.prototype, 'removeItem')
  const request = vi.fn().mockRejectedValue(new Error('Unexpected cloud request'))

  const drive = vi.fn(async ({ route }: { route: string }) =>
    route === '/asset-spaces'
      ? { items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }
        : route.includes('page_no=1')
          ? { items: [{ asset_id: 'cloud-report', kind: 'file', name: 'cloud-report.txt' }], page: { has_more: true } }
          : { items: [{ asset_id: 'second', kind: 'file', name: 'second-page.txt' }], page: { has_more: false } }
  )

  vi.stubGlobal('hermesDesktop', { api: request, cloudDriveRequest: drive })
  vi.stubGlobal('fetch', request)

  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter>
        <ArtifactsView />
      </MemoryRouter>
    </I18nProvider>
  )

  expect(await screen.findByRole('button', { name: 'cloud-report.txt' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'second-page.txt' })).toBeTruthy()
  const search = screen.getByRole('textbox', { name: '搜索当前文件夹' })
  expect(search.hasAttribute('disabled')).toBe(false)
  expect(drive.mock.calls.every(([input]) => !('login' in input) && !('phone' in input))).toBe(true)

  fireEvent.click(screen.getAllByRole('button', { name: '个人云盘' })[0])
  await Promise.resolve()
  expect(request).not.toHaveBeenCalled()
  expect(localApi.list).not.toHaveBeenCalled()
  expect(reads.mock.calls.filter(([key]) => legacyKeys.includes(key))).toEqual([])
  expect(removals.mock.calls.filter(([key]) => legacyKeys.includes(key))).toEqual([])
})

it('本地产物仍读取会话并展示文件，往返云盘能再次加载', async () => {
  const request = vi.fn().mockRejectedValue(new Error('Unexpected cloud request'))

  const drive = vi.fn(async ({ route }: { route: string }) =>
    route === '/asset-spaces'
      ? { items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }
      : { items: [{ asset_id: 'cloud-report', kind: 'file', name: 'cloud-report.txt' }], page: { has_more: false } }
  )

  vi.stubGlobal('hermesDesktop', { api: request, cloudDriveRequest: drive })
  vi.stubGlobal('fetch', request)
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
  expect(await screen.findByRole('button', { name: 'cloud-report.txt' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '本地产物' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'local-report.txt' })).toBeTruthy())
  expect(request).not.toHaveBeenCalled()
})
