import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

const { cwd, normalize, preload, open } = vi.hoisted(() => ({
  cwd: { value: null as unknown },
  normalize: vi.fn(),
  preload: vi.fn(),
  open: vi.fn()
}))

vi.mock('@/app/chat/session-view', () => ({ useSessionView: () => ({ $cwd: cwd.value }) }))
vi.mock('@/lib/local-preview', async original => ({
  ...(await original<object>()),
  normalizeOrLocalPreviewTarget: normalize
}))
vi.mock('@/app/chat/right-rail/formats/registry', () => ({ preloadFormat: preload }))
vi.mock('./pdf-thumbnail', () => ({
  /** 这里仅核对卡片入口，真实可见性、读取和释放由缩略图测试与原生夹具验证。 */
  PdfThumbnail: function Thumbnail({ label }: { label: string }) {
    return <img alt={label} src="data:image/png;base64,fixture" />
  }
}))
vi.mock('@/store/preview', async original => ({ ...(await original<object>()), openPreview: open }))

import { PreviewAttachment } from './preview-attachment'

const originalBridge = window.hermesDesktop
const prepare = vi.fn<(path: string, requestId: string) => Promise<void>>(async () => undefined)
const cancel = vi.fn<(requestId: string) => Promise<void>>(async () => undefined)
const idle: (() => void)[] = []

beforeEach(() => {
  cwd.value = atom('/account/work')
  $connection.set(null)
  prepare.mockClear()
  cancel.mockClear()
  open.mockClear()
  normalize.mockReset()
  preload.mockReset().mockResolvedValue(undefined)
  idle.length = 0
  window.hermesDesktop = { prepareOfficePreview: prepare, cancelOfficePreview: cancel } as never
  vi.stubGlobal('requestIdleCallback', (callback: () => void) => idle.push(callback))
  vi.stubGlobal('cancelIdleCallback', vi.fn())
})

afterEach(() => {
  cleanup()
  $connection.set(null)
  window.hermesDesktop = originalBridge
  vi.unstubAllGlobals()
})

it('卡片挂载即准备 Word，空闲才加载显示器，不读正文、不打开面板', async () => {
  render(<PreviewAttachment target="report.docx" />)
  expect(prepare).toHaveBeenCalledWith('/account/work/report.docx', expect.any(String))
  expect(normalize).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  expect(preload).not.toHaveBeenCalled()
  await act(async () => idle.forEach(callback => callback()))
  await waitFor(() => expect(preload).toHaveBeenCalledWith('word', '/account/work/report.docx'))
})

it('PDF 附件接入首页缩略图，普通文件仍保留原图标', () => {
  const view = render(<PreviewAttachment target="report.pdf" />)
  expect(screen.queryByRole('img', { name: 'report.pdf' })).toBeTruthy()
  view.rerender(<PreviewAttachment target="report.txt" />)
  expect(screen.queryByRole('img')).toBeNull()
})

it('目标或连接变化取消自己的准备请求，远程文件不交给本机 Office', () => {
  const view = render(<PreviewAttachment target="report.pptx" />)
  const request = prepare.mock.calls[0]?.[1]
  view.rerender(<PreviewAttachment target="other.docx" />)
  expect(cancel).toHaveBeenCalledWith(request)
  const second = prepare.mock.calls[1]?.[1]
  act(() => $connection.set({ mode: 'remote', profile: 'remote' } as never))
  expect(cancel).toHaveBeenCalledWith(second)
  expect(prepare).toHaveBeenCalledTimes(2)
})

it.each(['report.xlsx', 'notes.md', 'https://example.com/report.docx'])(
  '非 Word/PPT 或网址不启动预转换：%s',
  target => {
    render(<PreviewAttachment target={target} />)
    expect(prepare).not.toHaveBeenCalled()
  }
)

it('预转换失败保持卡片可点击，不自动提示或放弃原有预览入口', async () => {
  prepare.mockRejectedValueOnce(new Error('controlled failure'))
  normalize.mockResolvedValueOnce({ kind: 'file', path: '/account/work/report.docx' })
  render(<PreviewAttachment target="report.docx" />)
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Open preview' }))
  })
  expect(open).toHaveBeenCalledWith({ kind: 'file', path: '/account/work/report.docx' })
})
