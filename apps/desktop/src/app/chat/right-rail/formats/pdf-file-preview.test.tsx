import { Blob as NodeBlob } from 'node:buffer'

import type { OfficePreviewResult } from '@hermes/shared'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { FormatPreview } from './format-preview'
import PdfFilePreview from './pdf-file-preview'
import { readOfficePreviewPdf } from './source'

const opened = vi.hoisted(() => ({ sources: [] as { data: Uint8Array }[], destroy: vi.fn() }))
vi.mock('../pdf-engine', () => ({
  // 仅替代 jsdom 无法绘制的 pdf.js 层，正式读取、分页组件与字节交接均执行。
  createPdfEngine: (_container: unknown, _viewer: unknown, source: { data: Uint8Array }) => {
    opened.sources.push(source)

    return { destroy: opened.destroy }
  }
}))

const originalBridge = window.hermesDesktop
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
const pdf = Uint8Array.from(new TextEncoder().encode('%PDF-1.7\ncontrolled conversion\n%%EOF'))
const success: OfficePreviewResult = { ok: true, pdf, converter: 'wps', version: 'fixture-version' }
const convert = vi.fn<(path: string, requestId: string) => Promise<OfficePreviewResult>>()
const onFailure = vi.fn()

/** 文件树与聊天卡片交给预览中心的同一种目标，不另造 Word 专属路径。 */
function target(extension = 'docx') {
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
  opened.sources.length = 0
  opened.destroy.mockClear()
  $connection.set(null)
  convert.mockReset().mockResolvedValue(success)
  onFailure.mockReset()
  window.hermesDesktop = {
    convertOfficePreview: convert,
    cancelOfficePreview: vi.fn(async () => undefined),
    revealPath: vi.fn(async () => true),
    saveGatewayFile: vi.fn(async () => ({ canceled: true, saved: false }))
  } as never
  URL.createObjectURL = vi.fn(() => 'blob:word-preview')
  URL.revokeObjectURL = vi.fn()
  vi.stubGlobal('Blob', NodeBlob)
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(Date.now()), 0)
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
})
afterEach(() => {
  cleanup()
  $connection.set(null)
  window.hermesDesktop = originalBridge
  URL.createObjectURL = originalCreate
  URL.revokeObjectURL = originalRevoke
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it.each(['docx', 'doc', 'odt'])('预览中心把 %s 转成 PDF 字节，交给分页查看器，关闭后释放引擎', async extension => {
  const file = target(extension)
  const view = render(<FormatPreview reloadKey={0} target={file} />)
  await waitFor(() => expect(opened.sources).toHaveLength(1))
  expect(screen.getByRole('region', { name: file.label }).hasAttribute('data-pdf-viewer')).toBe(true)
  expect(convert).toHaveBeenCalledWith(file.path, expect.any(String))
  expect(opened.sources[0].data).toEqual(pdf)
  expect(view.container.querySelector('iframe')).toBeNull()
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  view.unmount()
  expect(opened.destroy).toHaveBeenCalledTimes(1)
})

it('PDF 已随目标提供字节时直接显示，不重新读取可能已失效的临时路径', async () => {
  const readFileDataUrl = vi.fn().mockRejectedValue(new Error('temporary file gone'))
  window.hermesDesktop.readFileDataUrl = readFileDataUrl
  render(
    <FormatPreview reloadKey={0} target={{ ...target('pdf'), dataUrl: 'data:application/pdf;base64,JVBERi0xLjQ=' }} />
  )
  await waitFor(() => expect(opened.sources).toHaveLength(1))
  expect(new TextDecoder().decode(opened.sources[0].data)).toBe('%PDF-1.4')
  expect(readFileDataUrl).not.toHaveBeenCalled()
  expect(convert).not.toHaveBeenCalled()
})

it('等待转换显示公共加载器和说明，刷新重新请求并收尾旧引擎', async () => {
  let resolve!: (result: OfficePreviewResult) => void
  convert.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const file = target()
  const view = render(<PdfFilePreview onFailure={onFailure} path={file.path} reloadKey={0} target={file} />)
  expect(screen.getByRole('status', { name: 'Converting document' })).toBeTruthy()
  expect(screen.getByText('The first preview may take a few seconds.')).toBeTruthy()
  await act(async () => resolve(success))
  await waitFor(() => expect(opened.sources).toHaveLength(1))
  view.rerender(<PdfFilePreview onFailure={onFailure} path={file.path} reloadKey={1} target={file} />)
  await waitFor(() => expect(convert).toHaveBeenCalledTimes(2))
  await waitFor(() => expect(opened.sources).toHaveLength(2))
  expect(opened.destroy).toHaveBeenCalledTimes(1)
  expect(onFailure).not.toHaveBeenCalled()
  convert.mockRejectedValueOnce(new Error('private conversion error'))
  view.rerender(<PdfFilePreview onFailure={onFailure} path={file.path} reloadKey={2} target={file} />)
  await waitFor(() => expect(onFailure).toHaveBeenCalledWith({ code: 'unavailable' }))
})

it.each([
  ['not_found', 'This file is no longer available.'],
  ['too_large', 'This file or image is too large to preview. You can still access the original file.'],
  ['unsupported', 'This format or media encoding is not supported.'],
  ['unavailable', 'Could not preview this file. You can still access the original file.'],
  ['timeout', 'Document conversion timed out. You can still access the original file.'],
  ['convert_failed', 'Could not convert this document. You can still access the original file.']
] as const)('解释 %s，保留原文件出口，不显示内部详情', async (code, message) => {
  convert.mockResolvedValue({ ok: false, code })
  const file = target('doc')
  render(<FormatPreview reloadKey={0} target={file} />)
  expect(await screen.findByText(message)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open containing folder' }))
  expect(window.hermesDesktop.revealPath).toHaveBeenCalledWith(file.path)
  expect(
    Boolean(screen.queryByText('If no conversion software is available, install LibreOffice and try again.'))
  ).toBe(code === 'unavailable')
})

it('远程不调用本机转换，只保留原连接下载，也不提示安装本机软件', async () => {
  $connection.set({ connectionId: 'remote-office', mode: 'remote', profile: 'team' } as never)
  await expect(readOfficePreviewPdf('/work/source.docx')).rejects.toEqual({ code: 'unavailable' })
  render(<FormatPreview reloadKey={0} target={target('doc')} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
  expect(window.hermesDesktop.saveGatewayFile).toHaveBeenCalledWith({
    connectionId: 'remote-office',
    profile: 'team',
    path: target('doc').path,
    suggestedName: target('doc').label
  })
  expect(convert).not.toHaveBeenCalled()
  expect(screen.queryByText('If no conversion software is available, install LibreOffice and try again.')).toBeNull()
})

it('换文件后旧转换不覆盖新文件，也不创建额外的 PDF 引擎', async () => {
  let resolve!: (result: OfficePreviewResult) => void
  convert.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const view = render(<FormatPreview reloadKey={0} target={target()} />)
  await waitFor(() => expect(convert).toHaveBeenCalledTimes(1))
  view.rerender(<FormatPreview reloadKey={0} target={target('doc')} />)
  await waitFor(() => expect(opened.sources).toHaveLength(1))
  await act(async () => resolve(success))
  expect(opened.sources).toHaveLength(1)
  expect(screen.queryByRole('region', { name: target().label })).toBeNull()
  // 离开旧文件时取消它自己的那次请求，排队中的旧转换不再挡住新文件。
  const [, firstRequest] = convert.mock.calls[0]
  expect(window.hermesDesktop.cancelOfficePreview).toHaveBeenCalledWith(firstRequest)
  expect(window.hermesDesktop.cancelOfficePreview).toHaveBeenCalledTimes(1)
})

it('切换连接后忽略旧转换，缺少桥接和未知异常统一为不可用', async () => {
  let resolve!: (result: OfficePreviewResult) => void
  convert.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const view = render(<FormatPreview reloadKey={0} target={target('odt')} />)
  await waitFor(() => expect(convert).toHaveBeenCalledTimes(1))
  act(() => $connection.set({ connectionId: 'remote-office', mode: 'remote' } as never))
  await screen.findByRole('button', { name: 'Download' })
  await act(async () => resolve(success))
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(screen.queryByRole('region', { name: target('odt').label })).toBeNull()
  view.unmount()
  $connection.set(null)
  window.hermesDesktop = {} as never
  await expect(readOfficePreviewPdf(target().path)).rejects.toEqual({ code: 'unavailable' })
  window.hermesDesktop = {
    cancelOfficePreview: vi.fn(async () => undefined),
    convertOfficePreview: vi.fn().mockRejectedValue(new Error('private paths and secrets'))
  } as never
  await expect(readOfficePreviewPdf(target().path)).rejects.toEqual({ code: 'unavailable' })
})
