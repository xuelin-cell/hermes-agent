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

import { OfficeSlides } from './office-slides'

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
const shown = () => screen.getByAltText(/^Slide \d+$/).getAttribute('src')

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('slide viewer', () => {
  it('shows one slide at a time and pages with buttons, keys and thumbnails', async () => {
    bridge.officeSlidesInfo.mockResolvedValue({ height: 405, pages: 3, version: 'v1', width: 720 })

    render(<OfficeSlides reloadKey={0} target={deck} />)

    expect(screen.getByRole('status', { name: copy.slides.preparing })).toBeTruthy()
    await waitFor(() => expect(counter()).toBe('1 / 3'))
    expect(bridge.officeSlidesInfo).toHaveBeenCalledWith('/mnt/u/workspace/新疆文旅.pptx')
    expect(shown()).toBe('/slides/1?v=v1')
    expect(screen.getAllByRole('button', { name: /^Slide \d$/ })).toHaveLength(3)
    expect(screen.getByRole('button', { name: copy.slides.previous })).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('button', { name: copy.slides.next }))
    expect(counter()).toBe('2 / 3')
    expect(shown()).toBe('/slides/2?v=v1')

    const viewer = screen.getByRole('region', { name: '新疆文旅.pptx' })

    fireEvent.keyDown(viewer, { key: 'End' })
    expect(counter()).toBe('3 / 3')
    fireEvent.keyDown(viewer, { key: 'ArrowRight' })
    expect(counter()).toBe('3 / 3')
    fireEvent.keyDown(viewer, { key: 'Home' })
    expect(counter()).toBe('1 / 3')
    fireEvent.keyDown(viewer, { key: 'PageDown' })
    expect(counter()).toBe('2 / 3')

    fireEvent.click(screen.getByRole('button', { name: 'Slide 3' }))
    expect(counter()).toBe('3 / 3')
    expect(screen.getByRole('button', { name: 'Slide 3' }).getAttribute('aria-current')).toBe('true')
  })

  it('says why there is no preview', async () => {
    bridge.officeSlidesInfo.mockRejectedValue(new Error(copy.officePreview.convert_failed))

    render(<OfficeSlides reloadKey={0} target={deck} />)

    expect(await screen.findByText(copy.officePreview.convert_failed)).toBeTruthy()
    expect(screen.queryByAltText(/^Slide \d+$/)).toBeNull()
  })

  it('asks again when the pane reloads, and starts from the first slide', async () => {
    bridge.officeSlidesInfo.mockResolvedValue({ height: 540, pages: 2, version: 'v1', width: 960 })

    const { rerender } = render(<OfficeSlides reloadKey={0} target={deck} />)

    await waitFor(() => expect(counter()).toBe('1 / 2'))
    fireEvent.click(screen.getByRole('button', { name: 'Slide 2' }))
    bridge.officeSlidesInfo.mockResolvedValue({ height: 540, pages: 2, version: 'v2', width: 960 })
    rerender(<OfficeSlides reloadKey={1} target={deck} />)

    await waitFor(() => expect(shown()).toBe('/slides/1?v=v2'))
    expect(bridge.officeSlidesInfo).toHaveBeenCalledTimes(2)
  })
})
