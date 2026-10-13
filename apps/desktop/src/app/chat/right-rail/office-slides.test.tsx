import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserShellCopy } from '@/lib/browser-shell'
import type { PreviewTarget } from '@/store/preview'

// The viewer reaches the bridge through lib/browser-shell.ts, which imports it only when a deck opens.
const bridge = vi.hoisted(() => ({
  officeSlideImageUrl: vi.fn((path: string, page: number, version: string) => `/slides/${page}?v=${version}`),
  officeSlidesInfo: vi.fn()
}))

vi.mock('@/dev/browser-bridge', () => bridge)

import { currentSlide, OfficeSlides } from './office-slides'

const deck: PreviewTarget = {
  kind: 'file',
  label: '新疆文旅.pptx',
  path: '/mnt/u/workspace/新疆文旅.pptx',
  previewKind: 'pdf',
  source: '/mnt/u/workspace/新疆文旅.pptx',
  url: 'file:///mnt/u/workspace/x.pptx'
}

const copy = browserShellCopy()
const counter = () => window.document.querySelector('[data-slide-counter]')?.textContent
const slideImages = () => screen.queryAllByAltText(/^Slide \d+$/).map(image => image.getAttribute('src'))
const list = () => window.document.querySelector('[data-slide="1"]')?.parentElement?.parentElement as HTMLElement

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('which slide the counter shows', () => {
  const slides = [
    { bottom: 316, top: 16 },
    { bottom: 632, top: 332 },
    { bottom: 948, top: 648 }
  ]

  it('is the slide filling most of the view, or the last one at the end', () => {
    expect(currentSlide(slides, { bottom: 500, top: 0 }, false)).toBe(1)
    expect(currentSlide(slides, { bottom: 750, top: 250 }, false)).toBe(2)
    expect(currentSlide(slides, { bottom: 964, top: 464 }, false)).toBe(3)
    expect(currentSlide(slides, { bottom: 600, top: 400 }, true)).toBe(3)
    // Two slides fully in view: the first of them.
    expect(currentSlide(slides, { bottom: 2000, top: 0 }, false)).toBe(1)
    expect(currentSlide([], { bottom: 500, top: 0 }, false)).toBe(1)
  })
})

describe('slide viewer', () => {
  it('lists every slide top to bottom', async () => {
    bridge.officeSlidesInfo.mockResolvedValue({ height: 405, pages: 3, version: 'v1', width: 720 })

    render(<OfficeSlides reloadKey={0} target={deck} />)

    expect(screen.getByRole('status', { name: copy.slides.preparing })).toBeTruthy()
    await waitFor(() => expect(counter()).toBe('1 / 3'))
    expect(bridge.officeSlidesInfo).toHaveBeenCalledWith('/mnt/u/workspace/新疆文旅.pptx')
    // Where IntersectionObserver is missing every slide is fetched at once.
    await waitFor(() => expect(slideImages()).toEqual(['/slides/1?v=v1', '/slides/2?v=v1', '/slides/3?v=v1']))
    expect(screen.queryByRole('button', { name: copy.slides.next })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Slide 2' })).toBeNull()
  })

  it('fetches a slide once it comes within a screen of view', async () => {
    const observers: { callback: IntersectionObserverCallback; options?: IntersectionObserverInit }[] = []

    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          observers.push({ callback, options })
        }

        disconnect() {}

        observe() {}
      }
    )
    bridge.officeSlidesInfo.mockResolvedValue({ height: 405, pages: 3, version: 'v1', width: 720 })

    render(<OfficeSlides reloadKey={0} target={deck} />)

    await waitFor(() => expect(observers).toHaveLength(1))
    expect(observers[0]?.options).toMatchObject({ root: list(), rootMargin: '100% 0px' })
    expect(slideImages()).toEqual([])

    const near = (...pages: number[]) =>
      observers[0]?.callback(
        pages.map(n => ({
          isIntersecting: true,
          target: window.document.querySelector(`[data-slide="${n}"]`)
        })) as unknown as IntersectionObserverEntry[],
        {} as IntersectionObserver
      )

    near(1, 2)
    await waitFor(() => expect(slideImages()).toEqual(['/slides/1?v=v1', '/slides/2?v=v1']))
    near(3)
    await waitFor(() => expect(slideImages()).toHaveLength(3))
  })

  it('counts the slide being read as the list scrolls', async () => {
    let scrolled = 0

    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const n = Number((this as HTMLElement).dataset?.slide || 0)
      const top = n ? 16 + (n - 1) * 316 - scrolled : 0

      return { bottom: n ? top + 300 : 500, top } as DOMRect
    })
    bridge.officeSlidesInfo.mockResolvedValue({ height: 405, pages: 3, version: 'v1', width: 720 })

    render(<OfficeSlides reloadKey={0} target={deck} />)

    await waitFor(() => expect(counter()).toBe('1 / 3'))

    const view = list()

    Object.defineProperty(view, 'scrollTop', { configurable: true, get: () => scrolled })
    Object.defineProperty(view, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(view, 'scrollHeight', { configurable: true, value: 964 })

    scrolled = 250
    fireEvent.scroll(view)
    expect(counter()).toBe('2 / 3')

    scrolled = 464
    fireEvent.scroll(view)
    expect(counter()).toBe('3 / 3')

    scrolled = 0
    fireEvent.scroll(view)
    expect(counter()).toBe('1 / 3')
  })

  it('presents one slide at a time in full screen, and the list picks up where it stopped', async () => {
    let fullscreenElement: Element | null = null
    const changed = () => window.document.dispatchEvent(new Event('fullscreenchange'))

    Object.defineProperty(window.document, 'fullscreenElement', {
      configurable: true,
      get: () => fullscreenElement
    })
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: function (this: HTMLElement) {
        fullscreenElement = this
        changed()

        return Promise.resolve()
      }
    })
    Object.defineProperty(window.document, 'exitFullscreen', {
      configurable: true,
      value: () => {
        fullscreenElement = null
        changed()

        return Promise.resolve()
      }
    })

    try {
      bridge.officeSlidesInfo.mockResolvedValue({ height: 405, pages: 3, version: 'v1', width: 720 })

      render(<OfficeSlides reloadKey={0} target={deck} />)

      await waitFor(() => expect(counter()).toBe('1 / 3'))
      fireEvent.click(screen.getByRole('button', { name: copy.slides.fullscreen }))

      expect(slideImages()).toEqual(['/slides/1?v=v1'])
      expect(screen.getByRole('button', { name: copy.slides.previous })).toHaveProperty('disabled', true)

      fireEvent.click(screen.getByRole('button', { name: copy.slides.next }))
      expect(slideImages()).toEqual(['/slides/2?v=v1'])

      const viewer = screen.getByRole('region', { name: '新疆文旅.pptx' })

      fireEvent.keyDown(viewer, { key: 'End' })
      expect(slideImages()).toEqual(['/slides/3?v=v1'])
      fireEvent.keyDown(viewer, { key: 'ArrowRight' })
      expect(slideImages()).toEqual(['/slides/3?v=v1'])
      fireEvent.keyDown(viewer, { key: 'Home' })
      fireEvent.keyDown(viewer, { key: 'PageDown' })
      expect(slideImages()).toEqual(['/slides/2?v=v1'])

      // A click anywhere on the slide moves on.
      fireEvent.click(screen.getByAltText('Slide 2'))
      expect(slideImages()).toEqual(['/slides/3?v=v1'])

      fireEvent.click(screen.getByRole('button', { name: copy.slides.exitFullscreen }))
      await waitFor(() => expect(counter()).toBe('3 / 3'))
      expect(slideImages()).toHaveLength(3)
    } finally {
      delete (window.document as { fullscreenElement?: unknown }).fullscreenElement
      delete (window.document as { exitFullscreen?: unknown }).exitFullscreen
      delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen
    }
  })

  it('says why there is no preview', async () => {
    bridge.officeSlidesInfo.mockRejectedValue(new Error(copy.officePreview.convert_failed))

    render(<OfficeSlides reloadKey={0} target={deck} />)

    expect(await screen.findByText(copy.officePreview.convert_failed)).toBeTruthy()
    expect(slideImages()).toEqual([])
  })

  it('asks again when the pane reloads', async () => {
    bridge.officeSlidesInfo.mockResolvedValue({ height: 540, pages: 2, version: 'v1', width: 960 })

    const { rerender } = render(<OfficeSlides reloadKey={0} target={deck} />)

    await waitFor(() => expect(slideImages()).toEqual(['/slides/1?v=v1', '/slides/2?v=v1']))
    bridge.officeSlidesInfo.mockResolvedValue({ height: 540, pages: 2, version: 'v2', width: 960 })
    rerender(<OfficeSlides reloadKey={1} target={deck} />)

    await waitFor(() => expect(slideImages()).toEqual(['/slides/1?v=v2', '/slides/2?v=v2']))
    expect(bridge.officeSlidesInfo).toHaveBeenCalledTimes(2)
  })
})
