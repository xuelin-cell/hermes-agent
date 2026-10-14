import { act, cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HTML_PREVIEW_SANDBOX } from '@/lib/browser-shell'

import { PreviewPane } from './preview-pane'

// The PDF viewer's pdf.js (which does not run in jsdom) and the bridge it reads the file through.
const pdfEngine = vi.hoisted(() => ({
  createPdfEngine: vi.fn(() => ({
    destroy: vi.fn(),
    endFind: vi.fn(),
    find: vi.fn(),
    fitWidth: vi.fn(),
    zoom: vi.fn()
  }))
}))

vi.mock('./pdf-engine', () => pdfEngine)
vi.mock('@/dev/browser-bridge', () => ({
  pdfDocumentSource: vi.fn(async () => ({ httpHeaders: {}, url: 'http://localhost/download', withCredentials: false }))
}))

// Browser build (lib/browser-shell.ts): an HTML file from the instance runs in the
// pane as it is, sandboxed without the app's origin. The desktop app's static copy
// is covered in preview-pane.test.tsx.
describe('PreviewPane in the browser build', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
    window.document.documentElement.dataset.hermesBrowser = 'production'
  })

  afterEach(() => {
    cleanup()
    delete window.document.documentElement.dataset.hermesBrowser
    vi.unstubAllGlobals()
  })

  it('runs an HTML file from the instance with its scripts, in a frame without the app’s origin', async () => {
    const html =
      '<!doctype html><h1 id="h">static</h1><script>document.getElementById("h").textContent = "ran"</script>'

    const dataUrl = `data:text/html;base64,${btoa(html)}`

    let rendered!: ReturnType<typeof render>
    await act(async () => {
      rendered = render(
        <PreviewPane
          target={{
            dataUrl,
            kind: 'file',
            label: 'game.html',
            path: '/opt/data/workspace/game.html',
            previewKind: 'html',
            source: '/opt/data/workspace/game.html',
            url: 'file:///opt/data/workspace/game.html'
          }}
        />
      )
    })

    const iframe = rendered.container.querySelector('iframe')

    expect(rendered.container.querySelector('webview')).toBeNull()
    expect(iframe?.getAttribute('sandbox')).toBe(HTML_PREVIEW_SANDBOX)
    expect(iframe?.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(iframe?.getAttribute('srcdoc')).toBe(html)
  })

  it('opens a PDF in the PDF viewer, not in a frame of the browser’s own viewer', async () => {
    let rendered!: ReturnType<typeof render>
    await act(async () => {
      rendered = render(
        <PreviewPane
          target={{
            kind: 'file',
            label: '论文.pdf',
            path: '/opt/data/workspace/论文.pdf',
            previewKind: 'pdf',
            source: '/opt/data/workspace/论文.pdf',
            url: 'file:///opt/data/workspace/paper.pdf'
          }}
        />
      )
    })

    expect(rendered.container.querySelector('[data-pdf-viewer] .pdfViewer')).not.toBeNull()
    expect(rendered.container.querySelector('iframe')).toBeNull()
    await waitFor(() => expect(pdfEngine.createPdfEngine).toHaveBeenCalledTimes(1))
  })
})
