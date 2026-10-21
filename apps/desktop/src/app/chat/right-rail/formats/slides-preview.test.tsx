import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useLayoutEffect } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $connection } from '@/store/session'

import { FormatPreview } from './format-preview'
import type { PdfPages } from './pdf-pages'
import { currentSlide } from './slides-preview'

const mock = vi.hoisted(() => ({ open: vi.fn(), local: vi.fn() }))
vi.mock('./pdf-pages', () => ({ openPdfPages: mock.open }))
vi.mock('./pptx-pages', () => ({ openPptxPages: mock.local }))
vi.mock('@/hooks/use-resize-observer', () => ({
  // jsdom 没有布局；固定为窄而高的面板，确认预绘制按高度而非宽度计算。
  useResizeObserver: (callback: () => void, ref: { current: HTMLElement | null }) => {
    useLayoutEffect(() => {
      Object.defineProperty(ref.current, 'clientHeight', { configurable: true, value: 700 })
      callback()
    }, [callback, ref])
  }
}))
const originalBridge = window.hermesDesktop
const doc = window.document
const oldFullscreen = Object.getOwnPropertyDescriptor(doc, 'fullscreenElement')
const oldRequest = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'requestFullscreen')
const oldExit = Object.getOwnPropertyDescriptor(doc, 'exitFullscreen')
const convert = vi.fn()
const draw = vi.fn()
const dispose = vi.fn()
const exit = vi.fn()
const request = vi.fn()
let book: PdfPages
let fullscreen: Element | null
let observer: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit }
const observers: (typeof observer)[] = []

/** 构造三类共享幻灯片扩展名，沿用正式文件入口。 */
function target(extension = 'pptx') {
  return {
    kind: 'file' as const,
    label: `中文.${extension}`,
    path: `/fixture/中文.${extension}`,
    source: `/fixture/中文.${extension}`,
    url: `file:///fixture/中文.${extension}`,
    previewKind: 'binary' as const
  }
}

/** 在有尺寸的占位页上发送可见性通知，不用源码字符串检查按需加载。 */
function near(number: number, visible: boolean) {
  act(() =>
    observer.callback(
      [
        {
          target: doc.querySelector(`[data-slide="${number}"]`)!,
          isIntersecting: visible
        } as IntersectionObserverEntry
      ],
      {} as IntersectionObserver
    )
  )
}

/** 离开保留区才发送释放通知，区分预绘制与回看保留两个边界。 */
function far(number: number) {
  act(() =>
    observers
      .at(-1)!
      .callback(
        [
          { target: doc.querySelector(`[data-slide="${number}"]`)!, isIntersecting: false } as IntersectionObserverEntry
        ],
        {} as IntersectionObserver
      )
  )
}

/** 取得真实滚动容器，几何与浏览器全屏权限在组件测试中受控。 */
function list() {
  return doc.querySelector('[data-slide="1"]')!.parentElement!.parentElement!
}

beforeEach(() => {
  observers.length = 0
  fullscreen = null
  // 不在无布局的 jsdom 中运行装饰动画；真实几何由人工验收。
  vi.stubGlobal('requestAnimationFrame', () => 0)
  vi.stubGlobal('cancelAnimationFrame', () => undefined)
  $connection.set(null)
  draw.mockReset().mockImplementation(async (number: number) => `blob:cache-${number}`)
  dispose.mockReset().mockResolvedValue(undefined)
  book = {
    pages: Array.from({ length: 32 }, () => ({ width: 960, height: 540 })),
    renderPage: draw,
    cachedPage: () => undefined,
    dispose
  }
  mock.open.mockReset().mockResolvedValue(book)
  mock.local.mockReset().mockResolvedValue(book)
  convert.mockReset().mockResolvedValue({ ok: true, pdf: new Uint8Array([1, 2]), version: 'fixture', converter: 'wps' })
  window.hermesDesktop = {
    convertOfficePreview: convert,
    cancelOfficePreview: vi.fn(async () => undefined),
    readFileDataUrl: vi.fn(async () => 'data:application/octet-stream;base64,UEsDBA=='),
    revealPath: vi.fn(),
    saveGatewayFile: vi.fn(async () => ({ saved: false, canceled: true }))
  } as never
  let address = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:owned-${++address}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ blob: async () => new Blob(['png'], { type: 'image/png' }) }))
  )
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      /** 保留正式订阅参数供测试发送边界事件。 */
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        observers.push({ callback, options })
        observer = observers.at(-2) || observers[0]
      }
      /** 不自动让所有页可见。 */
      observe() {}
      /** 卸载时允许正式生命周期解除订阅。 */
      disconnect() {}
    }
  )
  Object.defineProperty(doc, 'fullscreenElement', { configurable: true, get: () => fullscreen })
  request.mockReset().mockImplementation(function (this: HTMLElement) {
    fullscreen = this
    doc.dispatchEvent(new Event('fullscreenchange'))

    return Promise.resolve()
  })
  exit.mockReset().mockImplementation(async () => {
    fullscreen = null
    doc.dispatchEvent(new Event('fullscreenchange'))
  })
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', { configurable: true, value: request })
  Object.defineProperty(doc, 'exitFullscreen', { configurable: true, value: exit })
})

afterEach(() => {
  cleanup()
  $connection.set(null)
  window.hermesDesktop = originalBridge

  for (const [object, key, descriptor] of [
    [doc, 'fullscreenElement', oldFullscreen],
    [doc, 'exitFullscreen', oldExit],
    [HTMLElement.prototype, 'requestFullscreen', oldRequest]
  ] as const) {
    if (descriptor) {
      Object.defineProperty(object, key, descriptor)
    } else {
      Reflect.deleteProperty(object, key)
    }
  }

  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('计数取可见最多的页，平局取前页，滚到底取末页', () => {
  const pages = [
    { top: 16, bottom: 316 },
    { top: 332, bottom: 632 },
    { top: 648, bottom: 948 }
  ]

  expect(currentSlide(pages, { top: 0, bottom: 500 }, false)).toBe(1)
  expect(currentSlide(pages, { top: 250, bottom: 750 }, false)).toBe(2)
  expect(currentSlide(pages, { top: 0, bottom: 2000 }, false)).toBe(1)
  expect(currentSlide(pages, { top: 400, bottom: 600 }, true)).toBe(3)
  expect(currentSlide([], { top: 0, bottom: 100 }, false)).toBe(1)
})

it.each(['pptx', 'ppt', 'odp'])('%s 从正式预览中心接入，保留 32 页占位但不画远处的页', async extension => {
  const file = target(extension)
  render(<FormatPreview reloadKey={0} target={file} />)
  await screen.findByRole('button', { name: 'Present full screen' })
  expect(doc.querySelectorAll('[data-slide]')).toHaveLength(book.pages.length)
  await screen.findByAltText('Slide 1')
  expect(draw).toHaveBeenCalledTimes(1)
  expect(convert).toHaveBeenCalledWith(file.path, expect.any(String))
  expect(mock.open).toHaveBeenCalledWith(new Uint8Array([1, 2]))
  // DOM 带有 React 循环引用，只核对容器身份，不对整棵节点做深比较。
  expect(observer.options?.root).toBe(list())
  expect(observer.options?.rootMargin).toBe('700px 0px')
})

it('接近才画图，离开预绘制区保留旧图，超过五屏才释放自己的地址', async () => {
  render(<FormatPreview reloadKey={0} target={target()} />)
  const first = await screen.findByAltText('Slide 1')
  const address = first.getAttribute('src')
  expect(address).toMatch(/^blob:owned-/)
  near(2, true)
  await screen.findByAltText('Slide 2')
  near(1, false)
  expect(screen.getByAltText('Slide 1').getAttribute('src')).toBe(address)
  near(1, true)
  expect(draw).toHaveBeenCalledTimes(2)
  expect(observers.at(-1)!.options?.rootMargin).toBe('3500px 0px')
  far(1)
  await waitFor(() => expect(screen.queryByAltText('Slide 1')).toBeNull())
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(address)
  expect(draw).not.toHaveBeenCalledWith(32)
})

it('全屏翻页期间保留旧图，下一页就绪后才替换和释放，不闪加载占位', async () => {
  let finish!: (value: string) => void
  draw.mockImplementation((number: number) =>
    number === 2
      ? new Promise(resolve => {
          finish = resolve
        })
      : Promise.resolve(`blob:cache-${number}`)
  )
  render(<FormatPreview reloadKey={0} target={target()} />)
  await screen.findByAltText('Slide 1')
  fireEvent.click(screen.getByRole('button', { name: 'Present full screen' }))
  const first = await screen.findByAltText('Slide 1')
  const old = first.getAttribute('src')
  fireEvent.click(screen.getByRole('button', { name: 'Next slide' }))
  expect(screen.getByAltText('Slide 2').getAttribute('src')).toBe(old)
  expect(URL.revokeObjectURL).not.toHaveBeenCalledWith(old)
  await act(async () => finish('blob:cache-2'))
  await waitFor(() => expect(screen.getByAltText('Slide 2').getAttribute('src')).not.toBe(old))
  expect(URL.revokeObjectURL).toHaveBeenCalledWith(old)
})

it('离开保留区后重回已缓存页，在首帧显示缓存图，不先显示加载占位', async () => {
  render(<FormatPreview reloadKey={0} target={target()} />)
  await screen.findByAltText('Slide 1')
  far(1)
  expect(screen.queryByAltText('Slide 1')).toBeNull()
  book.cachedPage = () => 'blob:cache-1'
  near(1, true)
  expect(screen.getByAltText('Slide 1').getAttribute('src')).toBe('blob:cache-1')
})

it('滚动更新当前页，全屏从该页开始，键盘翻页并在退出时恢复所在页', async () => {
  let scrolled = 0
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const number = Number((this as HTMLElement).dataset?.slide || 0)
    const top = number ? 16 + (number - 1) * 316 - scrolled : 0

    return { top, bottom: number ? top + 300 : 500 } as DOMRect
  })
  render(<FormatPreview reloadKey={0} target={target()} />)
  await screen.findByRole('button', { name: 'Present full screen' })
  const view = list()
  Object.defineProperties(view, {
    scrollTop: {
      configurable: true,
      get: () => scrolled,
      set: value => {
        scrolled = value
      }
    },
    clientHeight: { configurable: true, value: 500 },
    scrollHeight: { configurable: true, value: 10128 }
  })
  scrolled = 250
  fireEvent.scroll(view)
  expect(screen.getByText('2 / 32')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Present full screen' }))
  const region = screen.getByRole('region', { name: target().label })
  await screen.findByAltText('Slide 2')
  expect(screen.queryAllByAltText(/^Slide \d+$/)).toHaveLength(1)
  fireEvent.keyDown(region, { key: 'End' })
  expect(screen.getByText('32 / 32')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Next slide' })).toHaveProperty('disabled', true)
  fireEvent.keyDown(region, { key: 'ArrowRight' })
  expect(screen.getByText('32 / 32')).toBeTruthy()
  fireEvent.keyDown(region, { key: 'Home' })
  expect(screen.getByRole('button', { name: 'Previous slide' })).toHaveProperty('disabled', true)

  for (const key of ['ArrowRight', ' ', 'ArrowDown', 'PageDown']) {
    fireEvent.keyDown(region, { key })
  }

  expect(screen.getByText('5 / 32')).toBeTruthy()

  for (const key of ['ArrowLeft', 'ArrowUp', 'PageUp']) {
    fireEvent.keyDown(region, { key })
  }

  fireEvent.keyDown(region, { key: ' ', shiftKey: true })
  expect(screen.getByText('1 / 32')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Next slide' }))
  expect(screen.getByText('2 / 32')).toBeTruthy()
  const escaped = vi.fn()
  window.addEventListener('keydown', escaped)
  fireEvent.keyDown(region, { key: 'Escape' })
  window.removeEventListener('keydown', escaped)
  expect(escaped).not.toHaveBeenCalled()
  await screen.findByRole('button', { name: 'Present full screen' })
  expect(scrolled).toBe(316)
  fireEvent.keyDown(region, { key: 'End' })
  expect(screen.getByText('2 / 32')).toBeTruthy()
})

it('全屏被拒绝保留预览，修饰键和按钮 Space 不误翻页，卸载退出自己的全屏', async () => {
  const view = render(<FormatPreview reloadKey={0} target={target()} />)
  const toggle = await screen.findByRole('button', { name: 'Present full screen' })
  request.mockRejectedValueOnce(new Error('denied'))
  fireEvent.click(toggle)
  expect(await screen.findByText('Could not enter or exit full screen. You can still read the slides.')).toBeTruthy()
  fireEvent.click(toggle)
  await screen.findByRole('button', { name: 'Exit full screen' })
  fireEvent.keyDown(screen.getByRole('region', { name: target().label }), { key: 'End', ctrlKey: true })
  fireEvent.keyDown(screen.getByRole('button', { name: 'Next slide' }), { key: ' ' })
  expect(screen.getByText('1 / 32')).toBeTruthy()
  view.unmount()
  await waitFor(() => expect(exit).toHaveBeenCalled())
  expect(dispose).toHaveBeenCalled()
})

it('换文件后关闭迟到的解析器，刷新也重新取 PDF 并收尾旧解析器', async () => {
  let resolve!: (source: PdfPages) => void
  mock.open.mockImplementationOnce(
    () =>
      new Promise(done => {
        resolve = done
      })
  )
  const view = render(<FormatPreview reloadKey={0} target={target()} />)
  await waitFor(() => expect(mock.open).toHaveBeenCalledTimes(1))
  view.rerender(<FormatPreview reloadKey={0} target={target('ppt')} />)
  await screen.findByRole('region', { name: target('ppt').label })
  const old = { ...book, dispose: vi.fn(async () => undefined) }
  await act(async () => resolve(old))
  expect(old.dispose).toHaveBeenCalledTimes(1)
  view.rerender(<FormatPreview reloadKey={1} target={target('ppt')} />)
  await waitFor(() => expect(convert).toHaveBeenCalledTimes(3))
  expect(dispose).toHaveBeenCalled()
})

it('某一页画不出来只在该页显示说明，其它页照常，整份不转入失败页', async () => {
  draw.mockImplementation(async (number: number) => {
    if (number === 2) {
      throw { code: 'unsupported' }
    }

    return `blob:cache-${number}`
  })
  const view = render(<FormatPreview reloadKey={0} target={target()} />)
  await screen.findByAltText('Slide 1')
  near(2, true)
  expect(await screen.findByText('Slide 2 could not be shown.')).toBeTruthy()
  expect(screen.getByAltText('Slide 1')).toBeTruthy()
  expect(screen.queryByText('This format or media encoding is not supported.')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Open containing folder' })).toBeNull()
  expect(dispose).not.toHaveBeenCalled()
  view.unmount()
  expect(dispose).toHaveBeenCalled()
})

it('pptx 没有转换软件时改在本机解析，沿用同一查看器并在关闭时释放', async () => {
  convert.mockResolvedValue({ ok: false, code: 'unavailable' })
  const view = render(<FormatPreview reloadKey={0} target={target()} />)
  await screen.findByAltText('Slide 1')
  expect(mock.open).not.toHaveBeenCalled()
  expect(new Uint8Array(mock.local.mock.calls[0][0])).toEqual(new Uint8Array([0x50, 0x4b, 3, 4]))
  expect(screen.queryByText('If no conversion software is available, install LibreOffice and try again.')).toBeNull()
  view.unmount()
  expect(dispose).toHaveBeenCalled()
})

it('pptx 本机也解析不了时仍提示安装转换软件', async () => {
  convert.mockResolvedValue({ ok: false, code: 'unavailable' })
  mock.local.mockRejectedValue({ code: 'unavailable' })
  render(<FormatPreview reloadKey={0} target={target()} />)
  expect(
    await screen.findByText('If no conversion software is available, install LibreOffice and try again.')
  ).toBeTruthy()
})

it('本机不可用提示安装，远程不调用本机转换并保留原连接下载', async () => {
  convert.mockResolvedValue({ ok: false, code: 'unavailable' })
  // 旧版 ppt 本机解析不了，只走转换。
  const view = render(<FormatPreview reloadKey={0} target={target('ppt')} />)
  expect(
    await screen.findByText('If no conversion software is available, install LibreOffice and try again.')
  ).toBeTruthy()
  act(() => $connection.set({ connectionId: 'slides-remote', mode: 'remote', profile: 'team' } as never))
  fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
  expect(window.hermesDesktop.saveGatewayFile).toHaveBeenCalledWith({
    connectionId: 'slides-remote',
    profile: 'team',
    path: target('ppt').path,
    suggestedName: target('ppt').label
  })
  expect(convert).toHaveBeenCalledTimes(1)
  expect(mock.open).not.toHaveBeenCalled()
  expect(mock.local).not.toHaveBeenCalled()
  expect(screen.queryByText('If no conversion software is available, install LibreOffice and try again.')).toBeNull()
  view.unmount()
})
