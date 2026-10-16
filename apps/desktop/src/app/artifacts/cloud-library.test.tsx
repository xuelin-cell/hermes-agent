import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const { CloudLibrary } = await import('./cloud-library')

const capabilities = { create_folder: true, rename: true, trash: true, download: true }

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
      : route === '/drive/capabilities'
        ? capabilities
        : route.includes('page_no=1')
          ? { items: [{ asset_id: 'cloud-report', kind: 'file', name: 'cloud-report.txt' }], page: { has_more: true } }
          : route.includes('page_no=2')
            ? { items: [{ asset_id: 'second', kind: 'file', name: 'second-page.txt' }], page: { has_more: false } }
            : { items: [] }
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
  expect(await screen.findByRole('button', { name: 'second-page.txt' })).toBeTruthy()
  const search = screen.getByRole('textbox', { name: '搜索文件和文件夹' })
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
      : route === '/drive/capabilities'
        ? capabilities
        : route.includes('page_no=1')
          ? { items: [{ asset_id: 'cloud-report', kind: 'file', name: 'cloud-report.txt' }], page: { has_more: false } }
          : { items: [] }
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

it('搜索发现子目录文件，目录跳转保留完整路径并按服务权限限制操作', async () => {
  const drive = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }
    }

    if (route === '/drive/capabilities') {
      return { ...capabilities, create_folder: false, trash: false }
    }

    const params = new URLSearchParams(route.split('?')[1])

    if (params.get('page_no') !== '1') {
      return { items: [] }
    }

    const parent = params.get('parent_asset_id')

    return {
      items:
        parent === 'root'
          ? [{ asset_id: 'parent', name: '部门', kind: 'directory' }]
          : parent === 'parent'
            ? [{ asset_id: 'child', name: '报告目录', kind: 'directory' }]
            : [{ asset_id: 'report', name: '季度报告.pdf', kind: 'file', permissions: { write: false } }]
    }
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: drive })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )
  await screen.findByRole('button', { name: '部门' })
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  const calls = drive.mock.calls.length
  fireEvent.change(screen.getByRole('textbox', { name: '搜索文件和文件夹' }), { target: { value: '报告' } })
  expect(screen.getByRole('button', { name: '季度报告.pdf' })).toBeTruthy()
  expect(drive).toHaveBeenCalledTimes(calls)
  fireEvent.click(screen.getByRole('button', { name: '报告目录' }))
  expect(screen.getByRole('button', { name: '部门' })).toBeTruthy()
  expect(screen.getByRole('button', { name: '报告目录' })).toBeTruthy()
  expect((screen.getByRole('button', { name: '新建文件夹' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '删除' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: '重命名' }) as HTMLButtonElement).disabled).toBe(true)
})

it('扫描失败保留结果并提示不完整，离开页面后丢弃迟到文件且不继续扫描', async () => {
  let resolveLate: ((value: unknown) => void) | undefined
  let retry = false

  const drive = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }
    }

    if (route === '/drive/capabilities') {
      return capabilities
    }

    if (retry) {
      return new Promise(resolve => {
        resolveLate = resolve
      })
    }

    if (route.includes('page_no=1')) {
      return { items: [{ asset_id: 'report', name: '已有报告.pdf', kind: 'file' }] }
    }

    throw new Error('Network unavailable')
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: drive })

  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )

  expect(await screen.findByRole('button', { name: '已有报告.pdf' })).toBeTruthy()
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('可能不完整或不是最新')
  )
  retry = true
  fireEvent.click(screen.getAllByRole('button', { name: '刷新' })[0])
  await waitFor(() => expect(resolveLate).toBeDefined())
  const calls = drive.mock.calls.length
  view.unmount()
  resolveLate!({ items: [{ asset_id: 'late', name: '其他账号文件', kind: 'directory' }] })
  await Promise.resolve()
  await Promise.resolve()
  expect(drive).toHaveBeenCalledTimes(calls)
})

it('首次连接和读目录显示原版提示，空文件夹与搜索无结果分开；缓存空目录刷新时不闪加载提示', async () => {
  let connect!: (value: unknown) => void
  let list!: (value: unknown) => void
  let refreshing = false
  let directoryLoaded = false
  let finishRefresh!: (value: unknown) => void

  const drive = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return await new Promise(resolve => {
        connect = resolve
      })
    }

    if (route === '/drive/capabilities') {
      return capabilities
    }

    if (route.endsWith('/usage')) {
      return { used_bytes: 0, total_bytes: 1024 }
    }

    if (refreshing) {
      return await new Promise(resolve => {
        finishRefresh = resolve
      })
    }

    if (directoryLoaded) {
      return { items: [] }
    }

    return await new Promise(resolve => {
      list = resolve
    })
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: drive })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )
  expect(await screen.findByText('正在连接云盘')).toBeTruthy()
  expect(screen.queryByText('正在获取你的资料，请稍候。')).toBeNull()
  await act(async () => connect({ items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }))
  expect(await screen.findByText('正在加载…')).toBeTruthy()
  await act(async () => list({ items: [] }))
  directoryLoaded = true
  expect(await screen.findByText('文件夹为空')).toBeTruthy()
  expect(screen.queryByText('没有找到相关资料')).toBeNull()

  // 类型筛选后为空仍是目录空态；只有实际搜索无结果才展示搜索提示。
  for (const name of ['文件', '文件夹', '全部']) {
    fireEvent.click(screen.getByRole('button', { name }))
    await waitFor(() => expect(screen.getByRole('button', { name: '刷新' }).getAttribute('aria-busy')).toBe('false'))
    expect(screen.getByText('文件夹为空')).toBeTruthy()
    expect(screen.queryByText('没有找到相关资料')).toBeNull()
  }

  fireEvent.change(screen.getByRole('textbox', { name: '搜索文件和文件夹' }), { target: { value: 'missing' } })
  expect(screen.getByText('没有找到相关资料')).toBeTruthy()
  expect(screen.queryByText('文件夹为空')).toBeNull()
  fireEvent.change(screen.getByRole('textbox', { name: '搜索文件和文件夹' }), { target: { value: '  ' } })
  expect(screen.getByText('文件夹为空')).toBeTruthy()
  refreshing = true
  const refresh = screen.getByRole('button', { name: '刷新' })
  fireEvent.click(refresh)
  await waitFor(() => expect(finishRefresh).toBeDefined())
  expect(refresh.getAttribute('aria-busy')).toBe('true')
  expect(screen.getByText('文件夹为空')).toBeTruthy()
  expect(screen.queryByText('正在加载…')).toBeNull()
  expect(screen.queryByText(/正在加载目录/)).toBeNull()
  await act(async () => finishRefresh({ items: [] }))
  await waitFor(() => expect(refresh.getAttribute('aria-busy')).toBe('false'))
})

it('缓存文件刷新时保留列表，仅显示刷新状态；进入尚未加载的空子目录后才显示目录加载', async () => {
  let pendingFolder!: (value: unknown) => void
  let finishRefresh!: (value: unknown) => void
  let refreshing = false

  const drive = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }
    }

    if (route === '/drive/capabilities') {
      return capabilities
    }

    const params = new URLSearchParams(route.split('?')[1])

    if (refreshing) {
      return await new Promise(resolve => {
        finishRefresh = resolve
      })
    }

    if (params.get('parent_asset_id') === 'empty') {
      return await new Promise(resolve => {
        pendingFolder = resolve
      })
    }

    return {
      items:
        params.get('page_no') === '1'
          ? [
              { asset_id: 'empty', kind: 'directory', name: '空目录' },
              { asset_id: 'file', kind: 'file', name: '已有文件.txt' }
            ]
          : []
    }
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: drive })

  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )

  await screen.findByRole('button', { name: '已有文件.txt' })
  await waitFor(() => expect(pendingFolder).toBeDefined())
  expect(screen.queryByText('正在加载…')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '空目录' }))
  expect(await screen.findByText('正在加载…')).toBeTruthy()
  expect(screen.queryByText('文件夹为空')).toBeNull()
  await act(async () => pendingFolder({ items: [] }))
  expect(await screen.findByText('文件夹为空')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '个人云盘' }))
  refreshing = true
  const refresh = screen.getByRole('button', { name: '刷新' })
  fireEvent.click(refresh)
  await waitFor(() => expect(finishRefresh).toBeDefined())
  expect(screen.getByRole('button', { name: '已有文件.txt' })).toBeTruthy()
  expect(screen.queryByText('正在加载…')).toBeNull()
  expect(refresh.getAttribute('aria-busy')).toBe('true')
  view.unmount()
  await act(async () => finishRefresh({ items: [] }))
})
