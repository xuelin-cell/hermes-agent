import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { CloudLibrary } from './cloud-library'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('切换和重复点击筛选立即显示缓存并后台刷新，合并在途扫描；五分钟同步及卸载清理', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let round = 0
  let release: ((value: unknown) => void) | undefined

  const request = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }
    }

    if (route === '/drive/capabilities') {
      return { create_folder: true, rename: true, trash: true, download: true }
    }

    if (route.endsWith('/usage')) {
      return { used_bytes: 1, total_bytes: 2 }
    }

    const params = new URLSearchParams(route.split('?')[1])

    if (params.get('parent_asset_id') !== 'root' || params.get('page_no') !== '1') {
      return { items: [] }
    }

    round++

    if (round === 2) {
      return new Promise(resolve => {
        release = resolve
      })
    }

    return { items: [{ asset_id: 'file', kind: 'file', name: round === 1 ? '缓存资料.txt' : '已更新资料.txt' }] }
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: request })

  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )

  await screen.findByRole('button', { name: '缓存资料.txt' })
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: '刷新' })[0]!.getAttribute('aria-busy')).toBe('false')
  )
  fireEvent.click(screen.getByRole('button', { name: '文件' }))
  expect(screen.getByRole('button', { name: '缓存资料.txt' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '刷新' })[0]!.getAttribute('aria-busy')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: '全部' }))
  expect(round).toBe(2)
  await act(async () => release!({ items: [{ asset_id: 'file', kind: 'file', name: '已更新资料.txt' }] }))
  await screen.findByRole('button', { name: '已更新资料.txt' })
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: '刷新' })[0]!.getAttribute('aria-busy')).toBe('false')
  )
  expect(screen.queryByRole('button', { name: '缓存资料.txt' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '全部' }))
  await waitFor(() => expect(round).toBe(3))
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: '刷新' })[0]!.getAttribute('aria-busy')).toBe('false')
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  })
  expect(round).toBe(4)
  view.unmount()
  const before = request.mock.calls.length
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000)
  expect(request).toHaveBeenCalledTimes(before)
  expect(vi.getTimerCount()).toBe(0)
})

it('离页后重进立即展示缓存并刷新，后台失败保留文件，下一次重进继续获取新目录', async () => {
  let round = 0
  let release!: (value: unknown) => void
  let reject!: (reason: Error) => void

  const request = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }
    }

    if (route === '/drive/capabilities') {
      return { create_folder: true, rename: true, trash: true, download: true }
    }

    if (route.endsWith('/usage')) {
      return { used_bytes: 1, total_bytes: 2 }
    }

    const params = new URLSearchParams(route.split('?')[1])

    if (params.get('parent_asset_id') !== 'root' || params.get('page_no') !== '1') {
      return { items: [] }
    }

    round++

    if (round === 1) {
      return { items: [{ asset_id: 'file', kind: 'file', name: '缓存资料.txt' }] }
    }

    return new Promise((resolve, fail) => {
      release = resolve
      reject = fail
    })
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: request })

  const page = (
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )

  let view = render(page)
  expect(screen.getByText('正在连接云盘')).toBeTruthy()
  await screen.findByRole('button', { name: '缓存资料.txt' })
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: '刷新' })[0]!.getAttribute('aria-busy')).toBe('false')
  )
  view.unmount()
  view = render(page)
  expect(screen.getByRole('button', { name: '缓存资料.txt' })).toBeTruthy()
  expect(screen.queryByText('正在连接云盘')).toBeNull()
  expect(screen.queryByText('正在加载目录')).toBeNull()
  await waitFor(() => expect(round).toBe(2))
  expect(screen.getAllByRole('button', { name: '刷新' })[0]!.getAttribute('aria-busy')).toBe('true')
  await act(async () => reject(new Error('offline')))
  expect(screen.getByRole('button', { name: '缓存资料.txt' })).toBeTruthy()
  expect(screen.getAllByRole('button', { name: '刷新' })[0]!.getAttribute('aria-busy')).toBe('false')
  view.unmount()
  render(page)
  expect(screen.getByRole('button', { name: '缓存资料.txt' })).toBeTruthy()
  await waitFor(() => expect(round).toBe(3))
  await act(async () => release({ items: [{ asset_id: 'file', kind: 'file', name: '最新资料.txt' }] }))
  await screen.findByRole('button', { name: '最新资料.txt' })
  await waitFor(() => expect(screen.queryByRole('button', { name: '缓存资料.txt' })).toBeNull())
  expect(request.mock.calls.filter(([input]) => input.route === '/asset-spaces')).toHaveLength(1)
})

it('已确认的空目录也使用缓存；离页后的迟到结果不能覆盖缓存，新账号窗口不读旧目录', async () => {
  let round = 0
  let release!: (value: unknown) => void

  const request = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }
    }

    if (route === '/drive/capabilities') {
      return { create_folder: true, rename: true, trash: true, download: true }
    }

    if (route.endsWith('/usage')) {
      return { used_bytes: 0, total_bytes: 2 }
    }

    round++

    if (round === 1) {
      return { items: [] }
    }

    return new Promise(resolve => {
      release = resolve
    })
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: request })

  const page = (
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )

  let view = render(page)
  await screen.findByText('文件夹为空')
  view.unmount()
  view = render(page)
  expect(screen.getByText('文件夹为空')).toBeTruthy()
  expect(screen.queryByText('正在连接云盘')).toBeNull()
  expect(screen.queryByText('正在加载目录')).toBeNull()
  await waitFor(() => expect(round).toBe(2))
  view.unmount()
  await act(async () => release({ items: [{ asset_id: 'late', kind: 'file', name: '迟到资料.txt' }] }))
  view = render(page)
  expect(screen.getByText('文件夹为空')).toBeTruthy()
  expect(screen.queryByRole('button', { name: '迟到资料.txt' })).toBeNull()
  view.unmount()
  const newRequest = vi.fn(() => new Promise(() => {}))
  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: newRequest })
  render(page)
  expect(screen.getByText('正在连接云盘')).toBeTruthy()
  expect(screen.queryByText('文件夹为空')).toBeNull()
  expect(screen.queryByRole('button', { name: '迟到资料.txt' })).toBeNull()
})

it('能力暂不可用的缓存也不会在重连失败时被错误页替换', async () => {
  let offline = false

  const request = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/drive/capabilities' || (offline && route === '/asset-spaces')) {
      throw new Error('offline')
    }

    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }
    }

    if (route.endsWith('/usage')) {
      return { used_bytes: 0, total_bytes: 2 }
    }

    return { items: route.includes('page_no=1') ? [{ asset_id: 'file', kind: 'file', name: '离线资料.txt' }] : [] }
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: request })

  const page = (
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )

  const view = render(page)
  await screen.findByRole('button', { name: '离线资料.txt' })
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: '刷新' })[0]!.getAttribute('aria-busy')).toBe('false')
  )
  view.unmount()
  offline = true
  render(page)
  expect(screen.getByRole('button', { name: '离线资料.txt' })).toBeTruthy()
  await waitFor(() => expect(request.mock.calls.filter(([input]) => input.route === '/asset-spaces')).toHaveLength(2))
  expect(screen.getByRole('button', { name: '离线资料.txt' })).toBeTruthy()
  expect(screen.queryByText('正在连接云盘')).toBeNull()
})
