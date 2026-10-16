import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { I18nProvider } from '@/i18n'
import { clearSessionDraft, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $newChatProfile, $newChatRoute } from '@/store/profile'
import { $connection, $selectedStoredSessionId } from '@/store/session'

const local = vi.hoisted(() => ({
  list: vi.fn().mockResolvedValue({ sessions: [{ id: 'local', profile: 'default', title: 'Local' }] }),
  messages: vi
    .fn()
    .mockResolvedValue({ messages: [{ role: 'assistant', timestamp: 1000, content: 'MEDIA:/tmp/report.txt' }] })
}))

vi.mock('@/hermes', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAllProfileSessions: local.list,
  getAllSessionMessages: local.messages
}))

const { ArtifactsView } = await import('./index')

/** 跟随真实路由观察添加引用后的导航，避免用模拟导航掩盖入口漏传回调。 */
function RouteProbe() {
  const location = useLocation()

  return <output aria-label="当前路由">{location.pathname}</output>
}

/** 两种宿主共用真实页面，只替换原生服务响应及本地产物的会话来源。 */
function setup() {
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $apiRequestScope.set({ connectionId: null, profile: 'default' })
  $selectedStoredSessionId.set(null)
  $newChatProfile.set(null)
  $newChatRoute.set(null)

  const request = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'space', root_asset_id: 'root' }] }
    }

    if (route === '/drive/capabilities') {
      return { upload: true, download: true, create_folder: true, rename: true, trash: true }
    }

    if (route.endsWith('/usage')) {
      return { used_bytes: 5, total_bytes: 1024 }
    }

    const params = new URLSearchParams(route.split('?')[1])

    return {
      items:
        params.get('page_no') === '1' && params.get('parent_asset_id') === 'root'
          ? [{ asset_id: 'file', kind: 'file', name: 'cloud-report.txt' }]
          : []
    }
  })

  const transfer = vi.fn()

  const api = vi.fn(async ({ path }: { path: string }) =>
    path.endsWith('/test')
      ? { ok: true, tools: [{ name: 'download' }] }
      : { servers: [{ name: 'UniWork-Drive', enabled: true }] }
  )

  vi.stubGlobal('hermesDesktop', {
    cloudDriveRequest: request,
    cloudDriveTransfer: transfer,
    cloudDriveAgentReady: vi.fn().mockResolvedValue(true),
    api,
    onCloudDriveProgress: vi.fn(() => () => {})
  })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsView />
        <RouteProbe />
      </MemoryRouter>
    </I18nProvider>
  )

  return { request, transfer, api }
}

afterEach(() => {
  cleanup()
  delete window.document.documentElement.dataset.hermesBrowser
  clearSessionDraft(null)
  $connection.set(null)
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  localStorage.clear()
})

it('浏览器默认展示实例产物，切换云盘保留占位，即使连接标为本地也不开放原生上传', async () => {
  window.document.documentElement.dataset.hermesBrowser = 'production'
  const fixture = setup()
  expect(await screen.findByRole('button', { name: 'report.txt' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '上传到云盘 · report.txt' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '个人云盘' }))
  expect(await screen.findByText('功能开发中')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '本地产物' }))
  expect(await screen.findByRole('button', { name: 'report.txt' })).toBeTruthy()
  expect(fixture.request).not.toHaveBeenCalled()
  expect(fixture.transfer).not.toHaveBeenCalled()
  expect(fixture.api).not.toHaveBeenCalled()
})

it('桌面默认展示云盘，添加到会话保留原草稿及附件卡片并返回聊天，不发送或下载', async () => {
  stashSessionDraft(null, '已有问题', [])
  const fixture = setup()
  await screen.findByRole('button', { name: 'cloud-report.txt' })
  fireEvent.click(screen.getByRole('button', { name: '添加到会话' }))
  await waitFor(() => expect(screen.getByLabelText('当前路由').textContent).toBe('/'))
  const draft = takeSessionDraft(null)
  expect(draft.text).toBe('已有问题')
  expect(draft.attachments).toEqual([
    expect.objectContaining({ kind: 'file', label: 'cloud-report.txt', cloudAssetId: 'file' })
  ])
  expect(fixture.transfer).not.toHaveBeenCalled()
  expect(
    fixture.api.mock.calls.every(([input]) =>
      ['/api/mcp/servers', '/api/mcp/servers/UniWork-Drive/test'].includes(input.path)
    )
  ).toBe(true)
})
