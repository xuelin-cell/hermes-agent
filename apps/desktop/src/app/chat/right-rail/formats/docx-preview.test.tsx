import { Blob as NodeBlob } from 'node:buffer'

import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { strToU8, zipSync } from 'fflate'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { setApiRequestConnection } from '@/api/client'
import { $connection } from '@/store/session'

import DocxPreview, { renderDocxPage } from './docx-preview'
import { FormatPreview } from './format-preview'

const originalBridge = window.hermesDesktop
const convert = vi.fn()
const read = vi.fn()
const onFailure = vi.fn()
const disconnect = vi.fn()
let resize: () => void
let panelWidth = 420

/** 用真实 OOXML 压缩包覆盖中文、表格、分页、链接与应禁止的内嵌 HTML，不替换解析库。 */
function sample(
  text = '中文文档',
  section = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:bottom="1440" w:left="1440" w:right="1440"/></w:sectPr>'
) {
  const archive = zipSync({
    '[Content_Types].xml': strToU8(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'
    ),
    '_rels/.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
    ),
    'word/document.xml': strToU8(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body><w:p><w:r><w:t>${text}</w:t></w:r><w:hyperlink r:id="external"><w:r><w:t>危险链接</w:t></w:r></w:hyperlink></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格内容</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:br w:type="page"/><w:t>第二页</w:t></w:r></w:p><w:altChunk r:id="html"/>${section}</w:body></w:document>`
    ),
    'word/_rels/document.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="external" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/><Relationship Id="html" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/aFChunk" Target="chunk.html"/></Relationships>'
    ),
    'word/chunk.html': strToU8(
      '<script>window.parent.hermesDesktop.revealPath("private")</script><img src="https://external.invalid/tracking">'
    )
  })

  return new Uint8Array(archive).buffer
}

/** 模拟正式读文件通道的 data URL，实际解码和 Word 渲染仍使用产品实现。 */
function dataUrl(text = '中文文档') {
  return `data:application/octet-stream;base64,${Buffer.from(sample(text)).toString('base64')}`
}

/** 原文件目标与预览中心保持一致。 */
function target(name = '中文.docx') {
  return {
    kind: 'file' as const,
    label: name,
    path: `/fixture/${name}`,
    source: `/fixture/${name}`,
    url: `file:///fixture/${name}`,
    previewKind: 'binary' as const
  }
}

beforeEach(() => {
  $connection.set(null)
  setApiRequestConnection(null)
  convert.mockReset().mockResolvedValue({ ok: false, code: 'unavailable' })
  read.mockReset().mockResolvedValue(dataUrl())
  onFailure.mockReset()
  disconnect.mockReset()
  panelWidth = 420
  window.hermesDesktop = {
    convertOfficePreview: convert,
    cancelOfficePreview: vi.fn(async () => undefined),
    readFileDataUrl: read,
    revealPath: vi.fn(),
    saveGatewayFile: vi.fn()
  } as never
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      /** 保存实际订阅，检查面板改变尺寸后的缩放。 */
      constructor(callback: () => void) {
        resize = callback
      }
      /** 不伪造浏览器排版；只提供可控尺寸通知。 */
      observe() {}
      disconnect = disconnect
    }
  )
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => panelWidth)
})

afterEach(() => {
  cleanup()
  $connection.set(null)
  setApiRequestConnection(null)
  window.hermesDesktop = originalBridge
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('真实解析按页保留中文和表格，清除链接且不渲染 altChunk', async () => {
  const result = await renderDocxPage(sample())
  const doc = new DOMParser().parseFromString(result.html, 'text/html')
  expect(doc.body.textContent).toContain('中文文档')
  expect(doc.body.textContent).toContain('第二页')
  expect(doc.querySelector('table')?.textContent).toContain('表格内容')
  expect(doc.body.querySelector('style')?.textContent).toContain('flex-flow: column nowrap')
  expect(doc.querySelectorAll('section.docx').length).toBeGreaterThan(1)
  expect(doc.querySelector('a')?.textContent).toBe('危险链接')
  expect(doc.querySelector('[href], [target], script, iframe, object, embed')).toBeNull()
  expect(doc.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain("default-src 'none'")
  expect(result.html).not.toContain('external.invalid')
  expect(result.width).toBeGreaterThan(0)
})

it('没写页面尺寸的文档按 A4 宽度显示，而不是判为不支持', async () => {
  const result = await renderDocxPage(sample('程序生成', ''))
  const doc = new DOMParser().parseFromString(result.html, 'text/html')
  expect(result.width).toBe(794)
  expect(doc.body.textContent).toContain('程序生成')
  expect(doc.querySelector<HTMLElement>('section.docx')?.style.width).toBe('794px')
})

it('转换不可用后真实落到 docx，使用原读取接口并随面板缩放，关闭解除监听', async () => {
  const file = target()
  const view = render(<FormatPreview reloadKey={0} target={file} />)
  const frame = (await screen.findByTitle(file.label)) as HTMLIFrameElement
  expect(frame.srcdoc).toContain('中文文档')
  expect(frame.getAttribute('sandbox')).toBe('')
  expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
  expect(convert).toHaveBeenCalledWith(file.path, expect.any(String))
  expect(read).toHaveBeenCalledWith(file.path)
  expect(frame.style.transform).toBe(`scale(${396 / 816})`)
  act(() => {
    panelWidth = 840
    resize()
  })
  expect(frame.style.transform).toBe('scale(1)')
  expect(frame.srcdoc).toContain('中文文档')
  view.unmount()
  expect(disconnect).toHaveBeenCalled()
})

it('远程 docx 使用既有鉴权文件接口，不调用本机转换和本机读取', async () => {
  $connection.set({ connectionId: 'docx-remote', mode: 'remote', profile: 'team' } as never)
  setApiRequestConnection('docx-remote')
  window.hermesDesktop.api = vi.fn(async () => ({ dataUrl: dataUrl() })) as never
  const file = target()
  render(<FormatPreview reloadKey={0} target={file} />)
  const frame = (await screen.findByTitle(file.label)) as HTMLIFrameElement
  expect(frame.srcdoc).toContain('中文文档')
  expect(window.hermesDesktop.api).toHaveBeenCalledWith({
    connectionId: 'docx-remote',
    path: `/api/fs/read-data-url?path=${encodeURIComponent(file.path)}`,
    profile: 'team'
  })
  expect(convert).not.toHaveBeenCalled()
  expect(read).not.toHaveBeenCalled()
})

it('已有 PDF 转换成功时不读取源文件，也不执行 Word 兜底', async () => {
  const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:converted')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  convert.mockResolvedValue({ ok: true, pdf: new Uint8Array([1]), version: 'fixture', converter: 'wps' })
  render(<FormatPreview reloadKey={0} target={target()} />)
  expect((await screen.findByRole('region', { name: target().label })).hasAttribute('data-pdf-viewer')).toBe(true)
  expect(read).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
})

it.each(['timeout', 'convert_failed'])('本机 %s 后也能用前端显示正文', async code => {
  convert.mockResolvedValue({ ok: false, code })
  render(<FormatPreview reloadKey={0} target={target()} />)
  expect(((await screen.findByTitle(target().label)) as HTMLIFrameElement).srcdoc).toContain('中文文档')
})

it.each(['doc', 'odt'])('%s 不尝试 docx 解析，保留原转换失败与安装提示', async extension => {
  render(<FormatPreview reloadKey={0} target={target(`中文.${extension}`)} />)
  expect(await screen.findByText('Could not preview this file. You can still access the original file.')).toBeTruthy()
  expect(screen.getByText('If no conversion software is available, install LibreOffice and try again.')).toBeTruthy()
  expect(read).not.toHaveBeenCalled()
})

it.each([
  [{ code: 'EFBIG' }, 'This file or image is too large to preview. You can still access the original file.'],
  [{ code: 'ENOENT' }, 'This file is no longer available.'],
  [new Error('private details'), 'Could not preview this file. You can still access the original file.']
])('源文件读取失败保留原因和原文件出口 %#', async (error, message) => {
  read.mockRejectedValue(error)
  render(<FormatPreview reloadKey={0} target={target()} />)
  expect(await screen.findByText(message)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Open containing folder' })).toBeTruthy()
})

it('损坏的压缩包不会无限加载，也不显示库的内部错误', async () => {
  read.mockResolvedValue('data:application/octet-stream;base64,AQID')
  render(<FormatPreview reloadKey={0} target={target()} />)
  expect(await screen.findByRole('button', { name: 'Open containing folder' })).toBeTruthy()
  expect(screen.queryByTitle(target().label)).toBeNull()
})

it('刷新重新解析，换文件后迟到的读取不覆盖新内容', async () => {
  let resolve!: (value: string) => void
  read.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const view = render(<DocxPreview onFailure={onFailure} path={target().path} reloadKey={0} target={target()} />)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  view.rerender(
    <DocxPreview onFailure={onFailure} path={target('新.docx').path} reloadKey={0} target={target('新.docx')} />
  )
  const frame = (await screen.findByTitle('新.docx')) as HTMLIFrameElement
  await act(async () => resolve(dataUrl('不该显示的旧正文')))
  expect(frame.srcdoc).not.toContain('不该显示的旧正文')
  read.mockResolvedValue(dataUrl('修改后的正文'))
  view.rerender(
    <DocxPreview onFailure={onFailure} path={target('新.docx').path} reloadKey={1} target={target('新.docx')} />
  )
  await waitFor(() => expect((screen.getByTitle('新.docx') as HTMLIFrameElement).srcdoc).toContain('修改后的正文'))
  expect(onFailure).not.toHaveBeenCalled()
})
