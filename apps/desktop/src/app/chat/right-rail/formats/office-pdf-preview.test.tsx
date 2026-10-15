import { Blob as NodeBlob } from 'node:buffer'

import type { OfficePreviewResult } from '@hermes/shared'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { FormatPreview } from './format-preview'
import OfficePdfPreview from './office-pdf-preview'
import { readOfficePreviewPdf } from './source'

const originalBridge = window.hermesDesktop
const originalCreate = URL.createObjectURL
const originalRevoke = URL.revokeObjectURL
const pdf = Uint8Array.from(new TextEncoder().encode('%PDF-1.7\ncontrolled conversion\n%%EOF'))
const success: OfficePreviewResult = { ok: true, pdf, converter: 'wps', version: 'fixture-version' }
const convert = vi.fn<(path: string) => Promise<OfficePreviewResult>>()
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
  $connection.set(null)
  convert.mockReset().mockResolvedValue(success)
  onFailure.mockReset()
  window.hermesDesktop = {
    convertOfficePreview: convert,
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

it.each(['docx', 'doc', 'odt'])('预览中心把 %s 转成 PDF，以 Blob iframe 显示并在关闭时释放', async extension => {
  const file = target(extension)
  const view = render(<FormatPreview reloadKey={0} target={file} />)
  const frame = await screen.findByTitle(file.label)
  expect(frame.tagName).toBe('IFRAME')
  expect(frame.getAttribute('src')).toBe('blob:word-preview')
  expect(convert).toHaveBeenCalledWith(file.path)
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob
  expect(blob.type).toBe('application/pdf')
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(pdf)
  view.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:word-preview')
})

it('等待转换显示公共加载器和说明，刷新重新请求并释放旧 Blob', async () => {
  let resolve!: (result: OfficePreviewResult) => void
  convert.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const file = target()
  const view = render(<OfficePdfPreview onFailure={onFailure} path={file.path} reloadKey={0} target={file} />)
  expect(screen.getByRole('status', { name: 'Converting document' })).toBeTruthy()
  expect(screen.getByText('The first preview may take a few seconds.')).toBeTruthy()
  await act(async () => resolve(success))
  await screen.findByTitle(file.label)
  view.rerender(<OfficePdfPreview onFailure={onFailure} path={file.path} reloadKey={1} target={file} />)
  await waitFor(() => expect(convert).toHaveBeenCalledTimes(2))
  await screen.findByTitle(file.label)
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1)
  expect(onFailure).not.toHaveBeenCalled()
  vi.mocked(URL.createObjectURL).mockImplementationOnce(() => { throw new Error('private Blob error') })
  view.rerender(<OfficePdfPreview onFailure={onFailure} path={file.path} reloadKey={2} target={file} />)
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

it('换文件后旧转换不覆盖新文件，也不创建额外的 Blob 地址', async () => {
  let resolve!: (result: OfficePreviewResult) => void
  convert.mockImplementationOnce(() => new Promise(done => { resolve = done }))
  const view = render(<FormatPreview reloadKey={0} target={target()} />)
  await waitFor(() => expect(convert).toHaveBeenCalledTimes(1))
  view.rerender(<FormatPreview reloadKey={0} target={target('doc')} />)
  await screen.findByTitle(target('doc').label)
  await act(async () => resolve(success))
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1)
  expect(screen.queryByTitle(target().label)).toBeNull()
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
  expect(screen.queryByTitle(target('odt').label)).toBeNull()
  view.unmount()
  $connection.set(null)
  window.hermesDesktop = {} as never
  await expect(readOfficePreviewPdf(target().path)).rejects.toEqual({ code: 'unavailable' })
  window.hermesDesktop = {
    convertOfficePreview: vi.fn().mockRejectedValue(new Error('private paths and secrets'))
  } as never
  await expect(readOfficePreviewPdf(target().path)).rejects.toEqual({ code: 'unavailable' })
})
