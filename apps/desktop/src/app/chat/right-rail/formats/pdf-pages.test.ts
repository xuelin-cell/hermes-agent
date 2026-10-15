import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { openPdfPages } from './pdf-pages'

const mock = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: mock.getDocument, GlobalWorkerOptions: {} }))

const draw = vi.fn()
const cleanup = vi.fn()
const getPage = vi.fn()
const destroy = vi.fn()
const sizes: number[][] = []

beforeEach(() => {
  sizes.length = 0
  draw.mockReset().mockImplementation(({ canvas, viewport }) => {
    sizes.push([canvas.width, canvas.height, viewport.scale])

    return { promise: Promise.resolve() }
  })
  cleanup.mockReset()
  destroy.mockReset().mockResolvedValue(undefined)
  getPage.mockReset().mockImplementation(async (number: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({
      width: (number === 2 ? 300 : 100) * scale,
      height: 200 * scale,
      scale
    }),
    render: draw,
    cleanup
  }))
  mock.getDocument.mockReset().mockReturnValue({ promise: Promise.resolve({ numPages: 9, getPage }), destroy })
  let url = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:pdf-${++url}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(callback =>
    callback(new Blob(['png'], { type: 'image/png' }))
  )
})

afterEach(() => vi.restoreAllMocks())

it('保留原字节，打开时只读第一页尺寸，画图按各页真实尺寸、长边统一 1600，完成后归还画布与页面', async () => {
  const bytes = new Uint8Array([1, 2, 3])
  const reader = await openPdfPages(bytes)
  const options = mock.getDocument.mock.calls[0][0]
  expect(options.data).toEqual(bytes)
  expect(options.data).not.toBe(bytes)
  expect(options.useSystemFonts).toBe(true)
  expect(options.cMapUrl).toMatch(/\/pdfjs\/cmaps\/$/)
  // 几百页的文稿不必先逐页读尺寸：其余页先沿用第一页的比例占位。
  expect(getPage).toHaveBeenCalledTimes(1)
  expect(reader.pages).toHaveLength(9)
  expect(reader.pages[1]).toEqual({ width: 100, height: 200 })
  await reader.renderPage(1)
  await reader.renderPage(2)
  expect(sizes[0].slice(0, 2)).toEqual([800, 1600])
  expect(sizes[1][0]).toBe(1600)
  expect(sizes[1][1]).toBeCloseTo(1067, 0)
  expect(draw.mock.calls.every(([{ canvas }]) => canvas.width === 0 && canvas.height === 0)).toBe(true)
  await reader.dispose()
  expect(cleanup).toHaveBeenCalled()
  expect(destroy).toHaveBeenCalledTimes(1)
})

it('同页并发只画一次，重复访问更新 LRU，超过上限仅撤销最早未用的页', async () => {
  const reader = await openPdfPages(new Uint8Array([1]))
  const [first, second] = await Promise.all([reader.renderPage(1), reader.renderPage(1)])
  expect(first).toBe(second)
  expect(draw).toHaveBeenCalledTimes(1)

  for (let number = 2; number <= 6; number++) {
    await reader.renderPage(number)
  }

  await reader.renderPage(1)
  const before = draw.mock.calls.length
  await reader.renderPage(7)
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:pdf-2')
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(first)
  expect(await reader.renderPage(1)).toBe(first)
  expect(draw).toHaveBeenCalledTimes(before + 1)
  expect(await reader.renderPage(2)).not.toBe('blob:pdf-2')
  await reader.dispose()
  expect(URL.revokeObjectURL).toHaveBeenCalledTimes(8)
  await reader.dispose()
  expect(destroy).toHaveBeenCalledTimes(1)
})

it('串行处理不同页，一页失败不阻塞后续，也不缓存失败结果', async () => {
  let fail!: (error: Error) => void
  draw.mockImplementationOnce(() => ({
    promise: new Promise((_resolve, reject) => {
      fail = reject
    })
  }))
  const reader = await openPdfPages(new Uint8Array([1]))
  const first = reader.renderPage(1)
  const failure = expect(first).rejects.toThrow('draw failed')
  const second = reader.renderPage(2)
  await vi.waitFor(() => expect(draw).toHaveBeenCalledTimes(1))
  fail(new Error('draw failed'))
  await failure
  await second
  expect(draw).toHaveBeenCalledTimes(2)
  await reader.renderPage(1)
  expect(draw).toHaveBeenCalledTimes(3)
  await reader.dispose()
})

it('编码期间关闭不会发布图片，排队任务不再启动，关闭可以重复等待', async () => {
  let finish!: BlobCallback
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback => {
    finish = callback
  })
  const reader = await openPdfPages(new Uint8Array([1]))
  const first = reader.renderPage(1)
  const second = reader.renderPage(2)

  const failures = Promise.all([
    expect(first).rejects.toEqual({ code: 'unavailable' }),
    expect(second).rejects.toEqual({ code: 'unavailable' })
  ])

  await vi.waitFor(() => expect(finish).toBeDefined())
  const close = reader.dispose()
  expect(reader.dispose()).toBe(close)
  finish(new Blob(['png']))
  await failures
  await close
  expect(draw).toHaveBeenCalledTimes(1)
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  await expect(reader.renderPage(1)).rejects.toEqual({ code: 'unavailable' })
})

it('非法页码和空编码结果明确失败，不留图片或画布', async () => {
  const reader = await openPdfPages(new Uint8Array([1]))

  for (const number of [0, -1, 1.2, NaN, 10]) {
    await expect(reader.renderPage(number)).rejects.toEqual({ code: 'unsupported' })
  }

  expect(draw).not.toHaveBeenCalled()
  vi.mocked(HTMLCanvasElement.prototype.toBlob).mockImplementation(callback => callback(null))
  await expect(reader.renderPage(1)).rejects.toEqual({ code: 'unsupported' })
  expect(URL.createObjectURL).not.toHaveBeenCalled()
  expect(draw.mock.calls[0][0].canvas.width).toBe(0)
  await reader.dispose()
})

it('解析或尺寸异常关闭 Worker，不暴露 PDF.js 内部错误', async () => {
  mock.getDocument.mockReturnValueOnce({ promise: Promise.reject(new Error('private path')), destroy })
  await expect(openPdfPages(new Uint8Array([1]))).rejects.toEqual({ code: 'unsupported' })
  getPage.mockRejectedValueOnce(new Error('bad geometry'))
  await expect(openPdfPages(new Uint8Array([1]))).rejects.toEqual({ code: 'unsupported' })
  expect(destroy).toHaveBeenCalledTimes(2)
})
