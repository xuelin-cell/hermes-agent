import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import { registry } from '@/contrib/registry'
import { renderMediaTags } from '@/lib/chat-messages/parts'
import * as desktopFs from '@/lib/desktop-fs'
import { TRANSCRIPT_DIRECTIVE_AREA, type TranscriptDirectiveContribution } from '@/lib/transcript-directives'
import { artifactsForSession, clearArtifactRegistry } from '@/store/artifacts'
import { $previewTabs } from '@/store/preview'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'

import { InlinePreviewDirective } from './inline-preview-directive'
import { MarkdownTextContent } from './markdown-text'

const HTML_DOC = `<!doctype html>
<html>
<head><title>Pomodoro Timer</title></head>
<body>
<h1>Pomodoro</h1>
<p>A tiny focus timer that counts down twenty-five minutes.</p>
<script>let seconds = 25 * 60; setInterval(() => { seconds -= 1 }, 1000)</script>
</body>
</html>`

const SMALL_SNIPPET = 'const x = 1'

function fenced(language: string, body: string): string {
  return `Here you go:\n\n\`\`\`${language}\n${body}\n\`\`\`\n`
}

// End-to-end for the artifact path: a substantial ```html fence in assistant
// markdown must come out of preprocessMarkdown -> Streamdown -> SyntaxHighlighter
// as an artifact card (registered in the store), while small fences keep the
// plain code-card path.
describe('MarkdownTextContent artifacts', () => {
  beforeEach(() => {
    $activeSessionId.set('session-artifacts')
    $selectedStoredSessionId.set(null)
    window.localStorage.clear()
    clearArtifactRegistry()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    cleanup()
    $activeSessionId.set(null)
    $selectedStoredSessionId.set(null)
    clearArtifactRegistry()
    window.localStorage.clear()
  })

  it('renders a substantial html fence as an artifact card and registers it', async () => {
    render(<MarkdownTextContent isRunning={false} text={fenced('html', HTML_DOC)} />)

    const card = await screen.findByText('Pomodoro Timer')

    expect(card.closest('button')?.dataset.slot).toBe('aui_artifact-card')
    expect(artifactsForSession('session-artifacts')).toHaveLength(1)
    expect(artifactsForSession('session-artifacts')[0]?.kind).toBe('html')
    // Registration alone must not open the rail (offer, don't hijack).
    expect($previewTabs.get()).toHaveLength(0)
  })

  it('keeps a small fence as a plain code block', async () => {
    const { container } = render(<MarkdownTextContent isRunning={false} text={fenced('js', SMALL_SNIPPET)} />)

    // The code card mounts synchronously; Shiki may split tokens into spans,
    // so assert on the card slots rather than text content.
    expect(container.querySelector('[data-slot="code-card"]')).not.toBeNull()
    expect(container.querySelector('[data-slot="aui_artifact-card"]')).toBeNull()
    expect(artifactsForSession('session-artifacts')).toHaveLength(0)
  })

  it('does not register while the message is still streaming', async () => {
    render(<MarkdownTextContent isRunning text={fenced('html', HTML_DOC)} />)

    await screen.findByText('Pomodoro Timer')

    expect(artifactsForSession('session-artifacts')).toHaveLength(0)
  })

  it.each(['inline', 'unreadable', 'code'])('keeps one file card alongside %s HTML output', async mode => {
    const file = '/tmp/delivered-report.html'
    vi.spyOn(desktopFs, 'readDesktopFileText').mockResolvedValue(
      { path: file, text: mode === 'unreadable' ? '' : HTML_DOC, binary: false }
    )

    const dispose = registry.register({
      id: 'test:file-card-preview',
      area: TRANSCRIPT_DIRECTIVE_AREA,
      source: 'plugin:test',
      data: {
        name: 'preview',
        render: ({ attrs, streaming }) => <InlinePreviewDirective attrs={attrs} streaming={streaming} />
      } satisfies TranscriptDirectiveContribution
    })

    onTestFinished(dispose)

    const text = mode === 'code'
      ? `${fenced('html', HTML_DOC)}\nMEDIA:${file}`
      : `::preview{file="${file}"}`

    const { container } = render(<MarkdownTextContent isRunning={false} text={renderMediaTags(text)} />)

    if (mode === 'inline') {
      await waitFor(() => expect(container.querySelector('iframe')?.title).toBe(file))
      expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy()
    }

    expect(await screen.findByRole('button', { name: 'Download' })).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Open preview' })).toBeTruthy()

    if (mode === 'code') {
      expect(container.querySelector('[data-slot="aui_artifact-card"]')).not.toBeNull()
    }
  })
})
