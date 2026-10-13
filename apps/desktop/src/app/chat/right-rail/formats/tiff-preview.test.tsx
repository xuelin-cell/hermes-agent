import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as UTIF from 'utif2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readPreviewBytes } from './source'
import TiffPreview, { decodeTiffFirstPage } from './tiff-preview'

vi.mock('./source', () => ({ readPreviewBytes: vi.fn() }))

const rgba = Uint8Array.of(255, 0, 0, 255, 0, 255, 0, 255)
const singlePage = UTIF.encodeImage(rgba, 2, 1)
const read = vi.mocked(readPreviewBytes)

const target = {
  kind: 'file' as const,
  label: '中文.tiff',
  path: '/fixture/中文.tiff',
  source: '/fixture/中文.tiff',
  url: 'file:///fixture/中文.tiff'
}

const originalCreateUrl = URL.createObjectURL
const originalRevokeUrl = URL.revokeObjectURL

/** 在内存中生成两页真实 TIFF，第一页红绿、第二页蓝色，不依赖磁盘样例。 */
function twoPages() {
  const page = UTIF.decode(singlePage)[0]
  const header = new Uint8Array(UTIF.encode([page, { ...page, t273: [1008] }]))
  const bytes = new Uint8Array(1016)
  bytes.set(header)
  bytes.set(rgba, 1000)
  bytes.set(Uint8Array.of(0, 0, 255, 255, 0, 0, 255, 255), 1008)

  return bytes.buffer
}

describe('TIFF decoding', () => {
  it('decodes the real first page and preserves the original bytes and later pages', () => {
    const input = twoPages()
    const decoded = decodeTiffFirstPage(input)
    expect(decoded).toEqual({ width: 2, height: 1, multiplePages: true, rgba })
    expect(UTIF.decode(input)).toHaveLength(2)
    expect(decodeTiffFirstPage(singlePage).multiplePages).toBe(false)
  })

  it('rejects corrupt, truncated and unsupported TIFF instead of producing a blank picture', () => {
    expect(() => decodeTiffFirstPage(Uint8Array.of(1, 2, 3).buffer)).toThrow()
    expect(() => decodeTiffFirstPage(singlePage.slice(0, 1000))).toThrow()
    const page = UTIF.decode(singlePage)[0]
    const invalid = singlePage.slice(0)
    new Uint8Array(invalid).set(new Uint8Array(UTIF.encode([{ ...page, t259: [500] }])))
    expect(() => decodeTiffFirstPage(invalid)).toThrow()
  })

  it('rejects excessive image dimensions before allocating decoded pixels', () => {
    const page = UTIF.decode(singlePage)[0]
    const oversized = UTIF.encode([{ ...page, t256: [100000], t257: [100000] }])
    expect(() => decodeTiffFirstPage(oversized)).toThrow(expect.objectContaining({ code: 'too_large' }))
  })

  it('keeps an A3 scan at 300 dpi within the size limit and reports a clearly larger page as too large', () => {
    const page = UTIF.decode(singlePage)[0]

    /** 只改尺寸并让数据位置无效：通过尺寸检查的会停在数据校验，不分配像素。 */
    const sized = (width: number, height: number) =>
      UTIF.encode([{ ...page, t256: [width], t257: [height], t273: [4] }])

    expect(() => decodeTiffFirstPage(sized(3508, 4961))).toThrow(expect.objectContaining({ code: 'unsupported' }))
    expect(() => decodeTiffFirstPage(sized(5000, 5000))).toThrow(expect.objectContaining({ code: 'too_large' }))
  })
})

describe('TIFF preview', () => {
  const putImageData = vi.fn()

  beforeEach(() => {
    read.mockReset().mockResolvedValue(singlePage)
    putImageData.mockReset()
    URL.createObjectURL = vi.fn(() => 'blob:fixture-tiff')
    URL.revokeObjectURL = vi.fn()
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData } as never)
    vi.stubGlobal(
      'ImageData',
      class {
        constructor(
          readonly data: Uint8ClampedArray,
          readonly width: number,
          readonly height: number
        ) {}
      }
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback =>
      callback(new Blob(['png'], { type: 'image/png' }))
    )
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })
  afterEach(() => {
    cleanup()
    URL.createObjectURL = originalCreateUrl
    URL.revokeObjectURL = originalRevokeUrl
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('shows the converted image and notes multiple pages only when present', async () => {
    const onFailure = vi.fn()
    const view = render(<TiffPreview onFailure={onFailure} path={target.path} reloadKey={0} target={target} />)
    expect((await screen.findByRole('img', { name: target.label })).getAttribute('src')).toBe('blob:fixture-tiff')
    expect(screen.queryByRole('status')).toBeNull()
    const drawn = putImageData.mock.calls[0][0]
    expect([drawn.width, drawn.height, ...drawn.data]).toEqual([2, 1, ...rgba])
    read.mockResolvedValue(twoPages())
    view.rerender(<TiffPreview onFailure={onFailure} path={target.path} reloadKey={1} target={target} />)
    expect(await screen.findByText('This TIFF has multiple pages. Only the first page is shown.')).toBeTruthy()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fixture-tiff')
    view.unmount()
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('reports read limits and image failures through the shared failure callback', async () => {
    read.mockRejectedValue({ code: 'too_large' })
    const onFailure = vi.fn()
    const view = render(<TiffPreview onFailure={onFailure} path={target.path} reloadKey={0} target={target} />)
    await waitFor(() => expect(onFailure).toHaveBeenCalledWith({ code: 'too_large' }))
    read.mockResolvedValue(singlePage)
    view.rerender(<TiffPreview onFailure={onFailure} path={target.path} reloadKey={1} target={target} />)
    fireEvent.error(await screen.findByRole('img'))
    expect(onFailure).toHaveBeenLastCalledWith({ code: 'unsupported' })
  })

  it('ignores a read that finishes after closing without decoding or creating a URL', async () => {
    let finish!: (bytes: ArrayBuffer) => void
    read.mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    const onFailure = vi.fn()
    const view = render(<TiffPreview onFailure={onFailure} path={target.path} reloadKey={0} target={target} />)
    view.unmount()
    await act(async () => finish(singlePage))
    expect(URL.createObjectURL).not.toHaveBeenCalled()
    expect(onFailure).not.toHaveBeenCalled()
  })
})
