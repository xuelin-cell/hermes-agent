import { Buffer, Blob as NodeBlob } from 'node:buffer'

import type { Settings } from '@fortune-sheet/core'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { type BookType, utils, write } from 'xlsx'

import { setApiRequestConnection } from '@/api/client'
import { I18nProvider } from '@/i18n'
import { $connection } from '@/store/session'

import { createImageWorkbook } from '../../../../../scripts/sheet-images.fixture'
import { createStyledWorkbook } from '../../../../../scripts/sheet-styles.fixture'

import { FormatPreview } from './format-preview'

const mock = vi.hoisted(() => ({ props: vi.fn(), crash: false }))
vi.mock('@fortune-sheet/react', () => ({
  /** 只替换画布组件；读取、解析、登记和降级仍走正式代码。 */
  Workbook: function Workbook(props: Settings) {
    mock.props(props)

    if (mock.crash) {
      throw new Error('controlled canvas failure')
    }

    return (
      <div data-testid="workbook">
        {props.data.map(sheet => (
          <span key={sheet.id}>{sheet.name}</span>
        ))}
      </div>
    )
  }
}))
const bridge = window.hermesDesktop
const read = vi.fn()
const convert = vi.fn()
const disconnect = vi.fn()
let resize: ResizeObserverCallback

/** 生成真实工作簿字节并经既有 Data URL 读取入口，避免绕过文件来源模块。 */
function dataUrl(name = '中文表', rows = 1, bookType: BookType = 'xlsx') {
  const book = utils.book_new()
  utils.book_append_sheet(book, utils.aoa_to_sheet(Array.from({ length: rows }, (_, row) => [`值 ${row}`])), name)
  const bytes = write(book, { type: 'base64', bookType })

  return `data:application/octet-stream;base64,${bytes}`
}

/** 与文件树、聊天文件卡片相同的预览目标。 */
function target(extension = 'xlsx') {
  return {
    kind: 'file' as const,
    label: `中文.${extension}`,
    path: `/fixture/中文.${extension}`,
    source: `/fixture/中文.${extension}`,
    url: `file:///fixture/中文.${extension}`,
    previewKind: 'binary' as const
  }
}

beforeEach(() => {
  mock.props.mockClear()
  mock.crash = false
  $connection.set(null)
  setApiRequestConnection(null)
  read.mockReset().mockResolvedValue(dataUrl())
  convert.mockReset().mockResolvedValue({ ok: true, pdf: Uint8Array.of(1, 2), converter: 'wps', version: 'fixture' })
  window.hermesDesktop = {
    readFileDataUrl: read,
    convertOfficePreview: convert,
    cancelOfficePreview: vi.fn(async () => undefined),
    revealPath: vi.fn(),
    saveGatewayFile: vi.fn(async () => ({ saved: false, canceled: true }))
  } as never
  vi.stubGlobal('Blob', NodeBlob)
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:sheet-pdf')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0))
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  disconnect.mockClear()
  vi.stubGlobal(
    'ResizeObserver',
    class {
      /** 保存正式回调，测试分隔条尺寸变化。 */
      constructor(callback: ResizeObserverCallback) {
        resize = callback
      }
      /** 不捏造浏览器布局。 */
      observe() {}
      /** 记录组件卸载是否解除订阅。 */
      disconnect() {
        disconnect()
      }
    }
  )
})

afterEach(() => {
  cleanup()
  $connection.set(null)
  setApiRequestConnection(null)
  window.hermesDesktop = bridge
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each([
  ['xlsx', 'xlsx'],
  ['xls', 'biff8'],
  ['ods', 'ods']
] as const)('%s 经过正式入口和真实解析，不调用 Office', async (extension, format) => {
  read.mockResolvedValue(dataUrl('中文表', 1, format))
  render(<FormatPreview reloadKey={0} target={target(extension)} />)
  expect(await screen.findByText('中文表')).toBeTruthy()
  expect(read).toHaveBeenCalledWith(target(extension).path)
  expect(convert).not.toHaveBeenCalled()
  expect(mock.props.mock.lastCall?.[0]).toMatchObject({
    allowEdit: false,
    forceCalculation: false,
    showToolbar: false,
    showFormulaBar: false,
    showSheetTabs: true,
    cellContextMenu: [],
    headerContextMenu: [],
    sheetTabContextMenu: [],
    filterContextMenu: []
  })
})

it('超过 500 行显示说明，繁体中文使用库实际支持的语言标识', async () => {
  read.mockResolvedValue(dataUrl('长表', 503))
  render(
    <I18nProvider configClient={null} initialLocale="zh-hant">
      <FormatPreview reloadKey={0} target={target()} />
    </I18nProvider>
  )
  expect(await screen.findByText('部分工作表超過 500 列，僅顯示其前 500 列。')).toBeTruthy()
  expect(mock.props.mock.lastCall?.[0].lang).toBe('zh-TW')
  expect(mock.props.mock.lastCall?.[0].data[0].row).toBe(500)
})

it('损坏内容和组件异常均进入现有 PDF 候选，关闭后释放 PDF 地址', async () => {
  read.mockResolvedValue('data:application/octet-stream;base64,UEsDBAA=')
  const view = render(<FormatPreview reloadKey={0} target={target()} />)
  expect(await screen.findByTitle(target().label)).toHaveProperty('tagName', 'IFRAME')
  expect(convert).toHaveBeenCalledWith(target().path, expect.any(String))
  view.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:sheet-pdf')
  mock.crash = true
  read.mockResolvedValue(dataUrl())
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  render(<FormatPreview reloadKey={0} target={target('xls')} />)
  expect(await screen.findByTitle(target('xls').label)).toBeTruthy()
  expect(convert).toHaveBeenCalledWith(target('xls').path, expect.any(String))
})

it('内嵌图片解码失败经过正式预览入口降级，不挂载空白表格', async () => {
  const bytes = createImageWorkbook(createStyledWorkbook())
  read.mockResolvedValue(`data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`)
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      /** jsdom 不解码图片，只控制解码失败，字节、XML 和降级仍真实执行。 */
      decode() {
        return Promise.reject(new Error('controlled bad image'))
      }
    }
  )
  render(<FormatPreview reloadKey={0} target={target()} />)
  await waitFor(() => expect(convert).toHaveBeenCalledTimes(1))
  expect(mock.props).not.toHaveBeenCalled()
})

it('明确文件不存在时停止降级，不启动本机转换', async () => {
  read.mockRejectedValue({ code: 'ENOENT' })
  render(<FormatPreview reloadKey={0} target={target()} />)
  expect(await screen.findByText('This file is no longer available.')).toBeTruthy()
  expect(convert).not.toHaveBeenCalled()
})

it('切文件忽略旧读取，刷新重新读取，卸载解除尺寸订阅', async () => {
  let resolve!: (data: string) => void
  read.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const view = render(<FormatPreview reloadKey={0} target={target()} />)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  read.mockResolvedValue(dataUrl('新表'))
  view.rerender(<FormatPreview reloadKey={0} target={target('xls')} />)
  await screen.findByText('新表')
  await act(async () => resolve(dataUrl('旧表')))
  expect(screen.queryByText('旧表')).toBeNull()
  view.rerender(<FormatPreview reloadKey={1} target={target('xls')} />)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3))
  view.unmount()
  expect(disconnect).toHaveBeenCalled()
})

it('分隔条连续改变尺寸时合并一次原版 resize 通知', async () => {
  render(<FormatPreview reloadKey={0} target={target()} />)
  await screen.findByText('中文表')
  const listener = vi.fn()
  window.addEventListener('resize', listener)
  act(() => {
    for (const width of [700, 720, 720]) {
      resize([{ contentRect: { width, height: 500 } } as ResizeObserverEntry], {} as ResizeObserver)
    }
  })
  await waitFor(() => expect(listener).toHaveBeenCalledTimes(1))
  window.removeEventListener('resize', listener)
})

it('窗口本身改变尺寸时表格组件已收到通知，不再补发', async () => {
  render(<FormatPreview reloadKey={0} target={target()} />)
  await screen.findByText('中文表')
  const listener = vi.fn()
  window.addEventListener('resize', listener)
  act(() => {
    window.dispatchEvent(new Event('resize'))
    resize([{ contentRect: { width: 640, height: 500 } } as ResizeObserverEntry], {} as ResizeObserver)
  })
  await new Promise(resolve => setTimeout(resolve, 300))
  expect(listener).toHaveBeenCalledTimes(1)
  window.removeEventListener('resize', listener)
})

it('表格组件的样式只放在预览区域内，不影响应用其它部分', async () => {
  const page = render(<FormatPreview reloadKey={0} target={target()} />).baseElement.ownerDocument
  await screen.findByText('中文表')

  // 测试环境不加载样式表正文（vitest 只保留指定的 CSS），这里核对包装和位置，正文由生产构建检查。
  const styles = Array.from(page.querySelectorAll('style')).filter(style => style.textContent?.startsWith('@scope {'))

  expect(styles).toHaveLength(1)
  expect(styles[0].parentElement?.getAttribute('role')).toBe('region')
  expect(page.head.contains(styles[0])).toBe(false)
})

it('远程字节使用原连接与 Profile；失败只提供该连接下载，不启动本机 Office', async () => {
  $connection.set({ connectionId: 'sheet-remote', mode: 'remote', profile: 'team' } as never)
  setApiRequestConnection('sheet-remote')
  const api = vi.fn(async () => ({ dataUrl: dataUrl('远程表') }))
  window.hermesDesktop = { ...window.hermesDesktop, api } as never
  const view = render(<FormatPreview reloadKey={0} target={target()} />)
  await screen.findByText('远程表')
  expect(api).toHaveBeenCalledWith({
    connectionId: 'sheet-remote',
    profile: 'team',
    path: '/api/fs/read-data-url?path=%2Ffixture%2F%E4%B8%AD%E6%96%87.xlsx'
  })
  expect(read).not.toHaveBeenCalled()
  api.mockResolvedValue({ dataUrl: 'data:application/octet-stream;base64,UEsDBAA=' })
  view.rerender(<FormatPreview reloadKey={1} target={target()} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
  expect(convert).not.toHaveBeenCalled()
  expect(window.hermesDesktop.saveGatewayFile).toHaveBeenCalledWith({
    connectionId: 'sheet-remote',
    profile: 'team',
    path: target().path,
    suggestedName: target().label
  })
})
