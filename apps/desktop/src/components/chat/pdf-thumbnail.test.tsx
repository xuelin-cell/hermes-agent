import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

const mock = vi.hoisted(() => ({ read: vi.fn(), open: vi.fn(), normalize: vi.fn() }))
vi.mock('@/app/chat/right-rail/formats/source', () => ({ readPdfBytes: mock.read }))
vi.mock('@/app/chat/right-rail/formats/pdf-pages', () => ({ openPdfPages: mock.open }))
vi.mock('@/lib/local-preview', () => ({ normalizeOrLocalPreviewTarget: mock.normalize }))

import { PdfThumbnail } from './pdf-thumbnail'

afterEach(() => {
  cleanup()
  $connection.set(null)
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('可见才读首页，只绘制低分辨率一页，卸载释放资源', async () => {
  let intersect!: (entries: { isIntersecting: boolean }[]) => void
  const disconnect = vi.fn()

  /** 只控制可见性，文档目标和页读取经过正式组件。 */
  class Observer {
    /** 接收浏览器可见性回调。 */
    constructor(callback: typeof intersect) {
      intersect = callback
    }
    /** 测试只保存可见性回调，不自行触发读取。 */
    observe() {}
    /** 记录组件停止观察。 */
    disconnect = disconnect
  }
  vi.stubGlobal('IntersectionObserver', Observer)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ blob: async () => new Blob(['thumbnail']) }))
  )
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:owned-thumbnail')
  const revoke = vi.spyOn(URL, 'revokeObjectURL')
  const dispose = vi.fn(async () => undefined)
  const renderPage = vi.fn(async () => 'blob:first')
  mock.normalize.mockResolvedValue({ kind: 'file', path: '/a/file.pdf' })
  mock.read.mockResolvedValue(new Uint8Array([1]))
  mock.open.mockResolvedValue({ dispose, renderPage })
  const view = render(<PdfThumbnail cwd="/a" label="file.pdf" target="file.pdf" />)
  expect(mock.read).not.toHaveBeenCalled()
  act(() => intersect([{ isIntersecting: true }]))
  expect(await screen.findByRole('img', { name: 'file.pdf' })).toBeTruthy()
  expect(mock.open).toHaveBeenCalledWith(new Uint8Array([1]), 160)
  expect(renderPage).toHaveBeenCalledExactlyOnceWith(1)
  expect(dispose).toHaveBeenCalledOnce()
  view.unmount()
  expect(dispose).toHaveBeenCalledOnce()
  expect(revoke).toHaveBeenCalledWith('blob:owned-thumbnail')
})

it('切换连接后的迟到读取不启动旧 PDF Worker，读取失败保留图标', async () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  let finish!: (bytes: Uint8Array) => void
  mock.normalize.mockResolvedValue({ kind: 'file', path: '/a/file.pdf' })
  mock.read.mockImplementationOnce(
    () =>
      new Promise<Uint8Array>(resolve => {
        finish = resolve
      })
  )
  mock.read.mockRejectedValueOnce(new Error('missing'))
  const view = render(<PdfThumbnail cwd="/a" label="file.pdf" target="file.pdf" />)
  await waitFor(() => expect(finish).toBeDefined())
  act(() => $connection.set({ mode: 'remote', connectionId: 'other', profile: 'other' } as never))
  await act(async () => finish(new Uint8Array([1])))
  expect(mock.open).not.toHaveBeenCalled()
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.querySelector('svg')).toBeTruthy()
})
