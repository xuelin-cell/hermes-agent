import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PreviewTarget } from '@/store/preview'

const bridge = vi.hoisted(() => ({ officePreviewDataUrl: vi.fn() }))
const fs = vi.hoisted(() => ({ readDesktopFileDataUrl: vi.fn(), readDesktopFileText: vi.fn() }))

vi.mock('@/dev/browser-bridge', () => bridge)

vi.mock('@/lib/desktop-fs', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...fs
}))

import { LocalFilePreview } from './preview-file'

// Browser build (lib/browser-shell.ts): an Office file shows as the PDF the
// instance converts it to. A tab restored from before this release was opened
// as text (and found to be binary); it shows the PDF too, not the binary-file
// screen whose "preview anyway" printed the zip bytes.

const PDF = `data:application/pdf;base64,${btoa('%PDF-1.7 deck')}`

const restored: PreviewTarget = {
  binary: true,
  kind: 'file',
  label: '新疆文旅.pptx',
  path: '/mnt/u/workspace/新疆文旅.pptx',
  previewKind: 'text',
  source: '/mnt/u/workspace/新疆文旅.pptx',
  url: 'file:///mnt/u/workspace/%E6%96%B0%E7%96%86%E6%96%87%E6%97%85.pptx'
}

const { createObjectURL, revokeObjectURL } = URL

beforeEach(() => {
  window.document.documentElement.dataset.hermesBrowser = 'production'
  URL.createObjectURL = vi.fn(() => 'blob:office-pdf')
  URL.revokeObjectURL = vi.fn()
})

afterEach(() => {
  cleanup()
  delete window.document.documentElement.dataset.hermesBrowser
  URL.createObjectURL = createObjectURL
  URL.revokeObjectURL = revokeObjectURL
  vi.clearAllMocks()
})

describe('Office files in the browser build’s preview pane', () => {
  it('show the PDF the instance makes, also in a tab restored from before', async () => {
    bridge.officePreviewDataUrl.mockResolvedValue(PDF)

    const { container } = render(<LocalFilePreview reloadKey={0} target={restored} />)

    await waitFor(() => expect(container.querySelector('iframe')?.getAttribute('src')).toBe('blob:office-pdf'))
    expect(bridge.officePreviewDataUrl).toHaveBeenCalledWith('/mnt/u/workspace/新疆文旅.pptx')
    expect(fs.readDesktopFileDataUrl).not.toHaveBeenCalled()
    expect(fs.readDesktopFileText).not.toHaveBeenCalled()
  })

  it('say why there is no preview', async () => {
    bridge.officePreviewDataUrl.mockRejectedValue(new Error('文件太大，不能在线预览，请下载后查看。'))

    const { container } = render(<LocalFilePreview reloadKey={0} target={{ ...restored, previewKind: 'pdf' }} />)

    expect(await screen.findByText('文件太大，不能在线预览，请下载后查看。')).toBeTruthy()
    expect(container.querySelector('iframe')).toBeNull()
  })

  it('stay as they were in the desktop app', async () => {
    delete window.document.documentElement.dataset.hermesBrowser

    render(<LocalFilePreview reloadKey={0} target={restored} />)

    // Upstream: the binary-file screen with its "preview anyway" button.
    expect(await screen.findByRole('button')).toBeTruthy()
    expect(bridge.officePreviewDataUrl).not.toHaveBeenCalled()
  })
})
