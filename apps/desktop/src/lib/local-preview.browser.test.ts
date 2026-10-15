import { afterEach, describe, expect, it, vi } from 'vitest'

const fs = vi.hoisted(() => ({ readDesktopFileDataUrl: vi.fn(), readDesktopFileText: vi.fn() }))

vi.mock('@/lib/desktop-fs', () => ({ isDesktopFsRemoteMode: () => true, ...fs }))

import { localPreviewTarget, normalizeOrLocalPreviewTarget } from './local-preview'

// Browser build (lib/browser-shell.ts): the pane has no Office viewer, so Word,
// PowerPoint and Excel files open as the PDF the instance converts them to,
// instead of a binary file read as text.

const originalBridge = window.hermesDesktop

afterEach(() => {
  delete document.documentElement.dataset.hermesBrowser
  window.hermesDesktop = originalBridge
  vi.clearAllMocks()
})

describe('Office files in the browser build', () => {
  it('open as PDF previews', () => {
    expect(localPreviewTarget('/mnt/u/workspace/deck.pptx')).toMatchObject({ previewKind: 'text' })

    document.documentElement.dataset.hermesBrowser = 'production'

    for (const name of ['deck.pptx', 'report.DOCX', 'sheet.xlsx', 'old.ppt']) {
      expect(localPreviewTarget(`/mnt/u/workspace/${name}`)).toMatchObject({
        path: `/mnt/u/workspace/${name}`,
        previewKind: 'pdf'
      })
    }

    expect(localPreviewTarget('/mnt/u/workspace/notes.md')).toMatchObject({ previewKind: 'text' })
  })

  it('are not read as text before the pane loads them', async () => {
    document.documentElement.dataset.hermesBrowser = 'production'
    window.hermesDesktop = { normalizePreviewTarget: vi.fn(async () => null) } as never

    await expect(normalizeOrLocalPreviewTarget('/mnt/u/workspace/deck.pptx')).resolves.toMatchObject({
      previewKind: 'pdf'
    })
    expect(fs.readDesktopFileText).not.toHaveBeenCalled()
    expect(fs.readDesktopFileDataUrl).not.toHaveBeenCalled()
  })
})
