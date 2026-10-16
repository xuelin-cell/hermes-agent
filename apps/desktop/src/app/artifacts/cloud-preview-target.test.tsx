import type { Settings } from '@fortune-sheet/core'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { utils, write } from 'xlsx'

import { PreviewPane } from '@/app/chat/right-rail/preview-pane'
import { I18nProvider } from '@/i18n'
import { $previewTabs, openPreview } from '@/store/preview'
import { $connection } from '@/store/session'

import { cloudPreviewTarget } from './cloud-preview-target'

const mock = vi.hoisted(() => ({ workbook: vi.fn(), pages: vi.fn() }))
vi.mock('@fortune-sheet/react', () => ({
  /** 仅替换依赖真实布局的画布，正式格式选择、工作簿解析和降级不替换。 */
  Workbook: function Workbook(props: Settings) {
    mock.workbook(props)

    return (
      <div data-testid="cloud-workbook">
        {props.data.map(sheet => (
          <span key={sheet.id}>{sheet.name}</span>
        ))}
      </div>
    )
  }
}))
vi.mock('../chat/right-rail/formats/pdf-pages', () => ({ openPdfPages: mock.pages }))

afterEach(() => {
  cleanup()
  $previewTabs.set([])
  $connection.set(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  mock.workbook.mockClear()
  mock.pages.mockReset()
})

/** 正式规范化桥返回真实文件类型，资料库不得覆盖成 PDF 或创建另一套渲染顺序。 */
async function target(name: string) {
  const path = '/account/cloud-drive-preview/original/' + name

  const normalize = vi.fn(async () => ({
    kind: 'file' as const,
    label: name,
    path,
    source: path,
    url: 'file://' + path,
    previewKind: 'binary' as const
  }))

  window.hermesDesktop.normalizePreviewTarget = normalize

  const result = await cloudPreviewTarget(
    'personal',
    { asset_id: 'asset', kind: 'file', name },
    { status: 'succeeded', name, preview: { kind: 'file', path } }
  )

  expect(normalize).toHaveBeenCalledWith(path)
  expect(result).toMatchObject({ path, previewKind: 'binary', shareOrigin: null })

  return result!
}

it('云盘 Excel 原文件进入现有工作簿显示器，不提前转 PDF，不持久化预览文件', async () => {
  const book = utils.book_new()
  utils.book_append_sheet(
    book,
    utils.aoa_to_sheet([
      ['名称', '数量'],
      ['原文件', 3]
    ]),
    '云盘工作表'
  )

  const read = vi
    .fn()
    .mockResolvedValue('data:application/octet-stream;base64,' + write(book, { type: 'base64', bookType: 'xlsx' }))

  const convert = vi.fn().mockRejectedValue(new Error('No converter should be needed for a readable sheet'))
  vi.stubGlobal('hermesDesktop', { readFileDataUrl: read, convertOfficePreview: convert })
  vi.stubGlobal(
    'ResizeObserver',
    class {
      /** 测试布局观察器占位，不改变业务请求。 */
      observe() {}
      /** 测试结束时允许组件释放观察器。 */
      disconnect() {}
    }
  )
  $connection.set({ mode: 'remote', connectionId: 'remote', profile: 'work' } as never)
  const file = await target('budget.xlsx')
  openPreview(file)
  expect(localStorage.getItem('hermes.desktop.previewTabs.v2') || '').not.toContain('cloud-drive-preview')
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <PreviewPane target={file} />
    </I18nProvider>
  )
  expect(await screen.findByText('云盘工作表')).toBeTruthy()
  expect(read).toHaveBeenCalledWith(file.path)
  expect(convert).not.toHaveBeenCalled()
  expect(mock.workbook).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Share artifact' })).toBeNull()
})

it('云盘 PPT 原文件由既有转换入口处理并显示原放映界面，关闭释放页资源', async () => {
  const convert = vi
    .fn()
    .mockResolvedValue({ ok: true, pdf: Uint8Array.of(37, 80, 68, 70), converter: 'libreoffice', version: 'fixture' })

  const dispose = vi.fn()

  const pages = {
    pages: [{ width: 100, height: 60 }],
    renderPage: vi.fn().mockResolvedValue('data:image/png;base64,aGVsbG8='),
    dispose
  }

  mock.pages.mockResolvedValue(pages)
  vi.stubGlobal('hermesDesktop', { convertOfficePreview: convert, cancelOfficePreview: vi.fn() })
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      /** 测试布局观察器占位，不改变业务请求。 */
      observe() {}
      /** 测试结束时允许组件释放观察器。 */
      disconnect() {}
    }
  )
  $connection.set({ mode: 'remote', connectionId: 'remote', profile: 'work' } as never)
  const file = await target('slides.pptx')

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <PreviewPane target={file} />
    </I18nProvider>
  )

  expect(await screen.findByRole('button', { name: 'Present full screen' })).toBeTruthy()
  expect(screen.getByText('1 / 1')).toBeTruthy()
  expect(convert).toHaveBeenCalledWith(file.path, expect.any(String))
  expect(mock.pages).toHaveBeenCalledWith(Uint8Array.of(37, 80, 68, 70))
  view.unmount()
  await waitFor(() => expect(dispose).toHaveBeenCalled())
})
