import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserShellCopy } from '@/lib/browser-shell'
import type { PreviewTarget } from '@/store/preview'

import type { PdfEngineEvents } from './pdf-engine'

interface Opened {
  container: HTMLDivElement
  engine: {
    destroy: ReturnType<typeof vi.fn>
    endFind: ReturnType<typeof vi.fn>
    find: ReturnType<typeof vi.fn>
    fitWidth: ReturnType<typeof vi.fn>
    zoom: ReturnType<typeof vi.fn>
  }
  events: PdfEngineEvents
  source: unknown
  viewer: HTMLDivElement
}

// The viewer reaches the bridge through lib/browser-shell.ts, which imports it only when a PDF opens.
const bridge = vi.hoisted(() => ({
  pdfDocumentSource: vi.fn(async (path: string) => ({
    httpHeaders: {},
    url: `http://localhost/__hermes_backend/api/fs/download?path=${encodeURIComponent(path)}`,
    withCredentials: false
  }))
}))

// pdf.js does not run in jsdom: a stand-in records what the viewer asks of it,
// and the tests play pdf.js's side (pages laid out, zoom, matches, password).
const opened = vi.hoisted(() => [] as Opened[])

vi.mock('@/dev/browser-bridge', () => bridge)
vi.mock('./pdf-engine', () => ({
  createPdfEngine: vi.fn(
    (container: HTMLDivElement, viewer: HTMLDivElement, source: unknown, events: PdfEngineEvents) => {
      const engine = { destroy: vi.fn(), endFind: vi.fn(), find: vi.fn(), fitWidth: vi.fn(), zoom: vi.fn() }

      opened.push({ container, engine, events, source, viewer })

      return engine
    }
  )
}))

import { PdfPreview } from './pdf-preview'

const report: PreviewTarget = {
  kind: 'file',
  label: '年度报告.pdf',
  path: '/mnt/u/workspace/年度报告.pdf',
  previewKind: 'pdf',
  source: '/mnt/u/workspace/年度报告.pdf',
  url: 'file:///mnt/u/workspace/report.pdf'
}

const copy = browserShellCopy()
const counter = () => window.document.querySelector('[data-pdf-counter]')?.textContent
const zoom = () => window.document.querySelector('[data-pdf-zoom]')?.textContent
const matches = () => window.document.querySelector('[data-pdf-matches]')?.textContent
const findBox = () => screen.queryByRole('textbox', { name: copy.pdf.find }) as HTMLInputElement | null

async function engineFor(count = 1): Promise<Opened> {
  await waitFor(() => expect(opened).toHaveLength(count))

  return opened[count - 1]!
}

// pdf.js laid the pages out (and set the zoom that fits the pane).
function laidOut({ events }: Opened, pages: number, scale = 1) {
  act(() => {
    events.onScale(scale)
    events.onPages(pages)
  })
}

afterEach(() => {
  cleanup()
  opened.length = 0
  vi.clearAllMocks()
  vi.restoreAllMocks()
})

describe('PDF viewer', () => {
  it('opens the PDF with pdf.js, then counts the pages and shows the zoom', async () => {
    render(<PdfPreview reloadKey={0} target={report} />)

    expect(screen.getByRole('status', { name: copy.pdf.loading })).toBeTruthy()

    const pdf = await engineFor()

    expect(bridge.pdfDocumentSource).toHaveBeenCalledWith('/mnt/u/workspace/年度报告.pdf')
    expect(pdf.source).toMatchObject({ url: expect.stringContaining('/api/fs/download?path=') })
    // pdf.js draws into a .pdfViewer, the only child of the box that scrolls.
    expect(pdf.viewer.className).toBe('pdfViewer')
    expect(pdf.viewer.parentElement).toBe(pdf.container)
    expect(pdf.container.className).toMatch(/\babsolute\b/)
    expect(counter()).toBe('')

    laidOut(pdf, 12, 0.59)

    expect(counter()).toBe('1 / 12')
    expect(zoom()).toBe('59%')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('region', { name: '年度报告.pdf' }).hasAttribute('data-pdf-viewer')).toBe(true)
  })

  it('counts the page being read as the PDF scrolls', async () => {
    let scrolled = 0

    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const n = Number((this as HTMLElement).dataset?.pageNumber || 0)
      const top = n ? 16 + (n - 1) * 316 - scrolled : 0

      return { bottom: n ? top + 300 : 500, top } as DOMRect
    })

    render(<PdfPreview reloadKey={0} target={report} />)

    const pdf = await engineFor()

    for (const n of [1, 2, 3]) {
      const page = window.document.createElement('div')

      page.className = 'page'
      page.dataset.pageNumber = String(n)
      pdf.viewer.append(page)
    }

    laidOut(pdf, 3)
    Object.defineProperty(pdf.container, 'scrollTop', { configurable: true, get: () => scrolled })
    Object.defineProperty(pdf.container, 'clientHeight', { configurable: true, value: 500 })
    Object.defineProperty(pdf.container, 'scrollHeight', { configurable: true, value: 964 })

    scrolled = 250
    fireEvent.scroll(pdf.container)
    expect(counter()).toBe('2 / 3')

    scrolled = 464
    fireEvent.scroll(pdf.container)
    expect(counter()).toBe('3 / 3')
  })

  it('zooms with the buttons; the percentage fits the page to the pane again', async () => {
    render(<PdfPreview reloadKey={0} target={report} />)

    const pdf = await engineFor()

    laidOut(pdf, 3)
    fireEvent.click(screen.getByRole('button', { name: copy.pdf.zoomIn }))
    fireEvent.click(screen.getByRole('button', { name: copy.pdf.zoomOut }))
    fireEvent.click(screen.getByTitle(copy.pdf.fitWidth))

    expect(pdf.engine.zoom.mock.calls).toEqual([[1], [-1]])
    expect(pdf.engine.fitWidth).toHaveBeenCalledTimes(1)

    act(() => pdf.events.onScale(5))
    expect(zoom()).toBe('500%')
    expect(screen.getByRole('button', { name: copy.pdf.zoomIn })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: copy.pdf.zoomOut })).toHaveProperty('disabled', false)
  })

  it('searches the whole PDF from the search box', async () => {
    render(<PdfPreview reloadKey={0} target={report} />)

    const pdf = await engineFor()

    laidOut(pdf, 3)
    fireEvent.click(screen.getByRole('button', { name: copy.pdf.find }))

    const input = findBox()!

    await waitFor(() => expect(window.document.activeElement).toBe(input))

    fireEvent.change(input, { target: { value: '客流' } })
    expect(pdf.engine.find).toHaveBeenLastCalledWith('客流')

    act(() => pdf.events.onFind({ current: 0, status: 'pending', total: 0 }))
    expect(matches()).toBe('')
    expect(screen.getByRole('button', { name: copy.pdf.findNext })).toHaveProperty('disabled', true)

    act(() => pdf.events.onFind({ current: 2, status: 'found', total: 5 }))
    expect(matches()).toBe('2 / 5')

    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
    fireEvent.click(screen.getByRole('button', { name: copy.pdf.findPrevious }))
    fireEvent.click(screen.getByRole('button', { name: copy.pdf.findNext }))
    expect(pdf.engine.find.mock.calls.slice(1)).toEqual([
      ['客流', { again: true, previous: false }],
      ['客流', { again: true, previous: true }],
      ['客流', { again: true, previous: true }],
      ['客流', { again: true, previous: false }]
    ])

    act(() => pdf.events.onFind({ current: 0, status: 'none', total: 0 }))
    expect(matches()).toBe(copy.pdf.findNone)

    fireEvent.keyDown(input, { key: 'Escape' })
    expect(pdf.engine.endFind).toHaveBeenCalledTimes(1)
    expect(findBox()).toBeNull()
    expect(window.document.activeElement).toBe(pdf.container)
  })

  it('opens the search on Ctrl+F; text an input method is still composing is not searched', async () => {
    render(<PdfPreview reloadKey={0} target={report} />)

    const pdf = await engineFor()

    laidOut(pdf, 3)
    fireEvent.keyDown(screen.getByRole('region', { name: '年度报告.pdf' }), { ctrlKey: true, key: 'f' })

    const input = (await screen.findByRole('textbox', { name: copy.pdf.find })) as HTMLInputElement

    await waitFor(() => expect(window.document.activeElement).toBe(input))

    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: 'ke' } })
    fireEvent.keyDown(input, { isComposing: true, key: 'Enter' })
    expect(pdf.engine.find).not.toHaveBeenCalled()

    fireEvent.change(input, { target: { value: '客' } })
    fireEvent.compositionEnd(input)
    expect(pdf.engine.find.mock.calls).toEqual([['客']])

    // ⌘F again selects what was typed, for a new search.
    input.setSelectionRange(1, 1)
    fireEvent.keyDown(input, { key: 'f', metaKey: true })
    await waitFor(() => expect([input.selectionStart, input.selectionEnd]).toEqual([0, 1]))
  })

  it('asks for the password of a protected PDF', async () => {
    render(<PdfPreview reloadKey={0} target={report} />)

    const pdf = await engineFor()
    const retry = vi.fn()

    act(() => pdf.events.onPassword(retry, false))

    expect(screen.getByText(copy.pdf.password)).toBeTruthy()
    expect(screen.queryByText(copy.pdf.passwordIncorrect)).toBeNull()

    const input = screen.getByLabelText(copy.pdf.passwordLabel)

    await waitFor(() => expect(window.document.activeElement).toBe(input))
    expect(screen.getByRole('button', { name: copy.pdf.passwordOpen })).toHaveProperty('disabled', true)

    fireEvent.change(input, { target: { value: 'secret' } })
    fireEvent.submit(input.closest('form')!)
    expect(retry).toHaveBeenCalledWith('secret')
    expect(screen.getByRole('status', { name: copy.pdf.loading })).toBeTruthy()

    const again = vi.fn()

    act(() => pdf.events.onPassword(again, true))
    expect(screen.getByText(copy.pdf.passwordIncorrect)).toBeTruthy()

    fireEvent.change(screen.getByLabelText(copy.pdf.passwordLabel), { target: { value: 'right' } })
    fireEvent.click(screen.getByRole('button', { name: copy.pdf.passwordOpen }))
    expect(again).toHaveBeenCalledWith('right')

    laidOut(pdf, 2)
    expect(counter()).toBe('1 / 2')
  })

  it('says why a PDF does not open', async () => {
    const { rerender } = render(<PdfPreview reloadKey={0} target={report} />)
    const broken = await engineFor()

    act(() =>
      broken.events.onError(Object.assign(new Error('Invalid PDF structure.'), { name: 'InvalidPDFException' }))
    )
    expect(screen.getByText(copy.pdf.invalid)).toBeTruthy()

    rerender(<PdfPreview reloadKey={1} target={report} />)

    const missing = await engineFor(2)

    act(() =>
      missing.events.onError(Object.assign(new Error('Missing PDF'), { name: 'ResponseException', status: 404 }))
    )
    expect(screen.getByText(copy.fileErrors.not_found)).toBeTruthy()

    bridge.pdfDocumentSource.mockRejectedValueOnce(new Error('offline'))
    rerender(<PdfPreview reloadKey={2} target={report} />)
    expect(await screen.findByText(copy.pdf.failed)).toBeTruthy()
    expect(opened).toHaveLength(2)
  })

  it('lets go of pdf.js when another file opens or the pane closes', async () => {
    const { rerender, unmount } = render(<PdfPreview reloadKey={0} target={report} />)
    const first = await engineFor()

    // What pdf.js drew goes with the file.
    first.viewer.append(window.document.createElement('div'))

    rerender(
      <PdfPreview reloadKey={0} target={{ ...report, label: '附件.pdf', path: '/w/附件.pdf', source: '/w/附件.pdf' }} />
    )

    const second = await engineFor(2)

    expect(first.engine.destroy).toHaveBeenCalledTimes(1)
    expect(second.viewer.childElementCount).toBe(0)
    expect(bridge.pdfDocumentSource).toHaveBeenLastCalledWith('/w/附件.pdf')

    unmount()
    expect(second.engine.destroy).toHaveBeenCalledTimes(1)

    // Closed before pdf.js was even loaded: nothing is started.
    render(<PdfPreview reloadKey={0} target={report} />).unmount()
    await vi.dynamicImportSettled()
    expect(opened).toHaveLength(2)
  })
})
