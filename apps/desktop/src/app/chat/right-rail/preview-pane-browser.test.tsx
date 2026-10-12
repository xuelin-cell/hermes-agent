import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { HTML_PREVIEW_SANDBOX } from '@/lib/browser-shell'

import { PreviewPane } from './preview-pane'

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
})
