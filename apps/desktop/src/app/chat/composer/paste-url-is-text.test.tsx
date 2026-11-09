// @vitest-environment jsdom
import { AssistantRuntimeProvider, useExternalStoreRuntime } from '@assistant-ui/react'
import type { ThreadMessageLike } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { clearSessionDraft, mainComposerScope } from '@/store/composer'

import { copyMessageWithAttachments } from './message-clipboard'
import { composerPlainText, RICH_INPUT_SLOT } from './rich-editor'
import type { ChatBarProps, ChatBarState } from './types'

import { ChatBar } from './index'

// desktop-mt: 剪贴板夹具不查询模型配置；圆环的真实用量链路另有定向测试。
vi.mock('./model-mt/model-meta', () => ({
  useComposerModelMeta: () => ({ rows: [], find: () => undefined, loading: false, error: false })
}))

afterEach(() => {
  cleanup()
  mainComposerScope.clear()
  clearSessionDraft(null)
  vi.unstubAllGlobals()
})

// THE INVARIANT: a pasted URL is never swallowed.
//
// A GitHub PR-comment deep link (`…/pull/1#issuecomment-2`) used to be
// special-cased inside ChatBar's paste handler: it called
// `onAttachPrCommentUrl`, ran `event.preventDefault()`, and returned — so the
// clipboard payload never reached the editor (proven: with this harness the
// editor ends up EMPTY and the hook is called once) and the user saw only an
// attachment pill above the composer. Removing that interception is what makes
// the two URLs behave identically again.
//
// The handler is driven through the REAL ChatBar with a real paste event on the
// contentEditable, focused first (an unfocused ⌘V routes through paste-to-focus,
// which shares this insertion path). jsdom has no clipboard, so the event
// carries the fake DataTransfer shape the sibling paste-to-focus tests use.
//
// `onAttachPrCommentUrl` is spread in under a cast deliberately: the prop was
// deleted along with the interception, and passing it anyway is what proves the
// handler no longer consults it. On the pre-fix tree it is called once and the
// payload is dropped; here it must never be called and the URL must survive.
//
// `composerPlainText` round-trips a `@url:` chip to its directive text, so the
// assertions hold whether the link lands chipped or raw — the chip form is
// url-refs.test.ts's contract, this file's is only that the paste survives.
const PR_COMMENT_URL = 'https://github.com/o/r/pull/1#issuecomment-2'

const state: ChatBarState = {
  model: { canSwitch: false, model: '', provider: '' },
  tools: { enabled: false, label: '' },
  voice: { enabled: false, active: false }
}

function Harness({
  onAttachPrCommentUrl,
  onSubmit = vi.fn(async () => true)
}: {
  onAttachPrCommentUrl: (url: string) => boolean
  onSubmit?: ChatBarProps['onSubmit']
}) {
  // The adapter's message generic infers to `never` from an empty array, so the
  // empty store is typed explicitly. The runtime itself is only here to satisfy
  // ChatBar's provider; nothing in this test reads it.
  const runtime = useExternalStoreRuntime({
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: false,
    messages: [] as ThreadMessageLike[],
    onNew: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MemoryRouter>
        <I18nProvider configClient={null} initialLocale="en">
          <ChatBar
            busy={false}
            disabled={false}
            gateway={null}
            onCancel={vi.fn()}
            onSubmit={onSubmit}
            state={state}
            {...({ onAttachPrCommentUrl } as Record<string, unknown>)}
          />
        </I18nProvider>
      </MemoryRouter>
    </AssistantRuntimeProvider>
  )
}

/** Focus `editor` and fire the paste event a ⌘V into the composer produces. */
function pasteInto(editor: HTMLElement, text: string, html = '') {
  // jsdom does not implement isContentEditable, so the app's window-level paste
  // router would treat this target as page chrome and insert through the
  // composer bus instead of the editor's own handler. Pin it.
  Object.defineProperty(editor, 'isContentEditable', { configurable: true, value: true })
  editor.focus()

  const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent

  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (type: string) => (type === 'text/html' ? html : type === 'text' || type === 'text/plain' ? text : ''),
      files: [],
      items: []
    }
  })

  act(() => {
    fireEvent(editor, event)
  })

  return event
}

describe('a pasted URL survives the paste', () => {
  it('keeps a GitHub PR-comment deep link in the composer and attaches nothing', () => {
    const onAttachPrCommentUrl = vi.fn(() => true)

    const { container } = render(<Harness onAttachPrCommentUrl={onAttachPrCommentUrl} />)

    const editor = container.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!

    const event = pasteInto(editor, PR_COMMENT_URL)

    // The payload reached the editor instead of being consumed by the handler…
    expect(composerPlainText(editor)).toContain(PR_COMMENT_URL)
    // …nothing was attached above the composer…
    expect(mainComposerScope.$attachments.get()).toEqual([])
    // …and the interception hook was never consulted.
    expect(onAttachPrCommentUrl).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('粘贴已发送的消息', () => {
  it.each(['这两个文件一起看', ''])('把文件和图片作为附件加入目标输入框：caption=%s', async caption => {
    const writeClipboard = vi.fn(async (_text: string, _html?: string) => true)
    vi.stubGlobal('hermesDesktop', { writeClipboard })
    await copyMessageWithAttachments(caption, ['@file:`report (1).docx`', '@image:chart.png'], '/source/workspace')
    const [text, html] = writeClipboard.mock.calls[0]
    const onSubmit = vi.fn<ChatBarProps['onSubmit']>(async () => true)
    const { container } = render(<Harness onAttachPrCommentUrl={vi.fn()} onSubmit={onSubmit} />)
    const editor = container.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!

    pasteInto(editor, text, html)

    expect(composerPlainText(editor).trim()).toBe(caption)
    expect(mainComposerScope.$attachments.get()).toMatchObject([
      { kind: 'file', path: '/source/workspace/report (1).docx' },
      { kind: 'image', path: '/source/workspace/chart.png' }
    ])
    expect(container.querySelectorAll('[data-slot="composer-attachments"] button')).not.toHaveLength(0)

    await act(async () => fireEvent.submit(editor.closest('form')!))
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith(
        caption,
        expect.objectContaining({
          attachments: [
            expect.objectContaining({ kind: 'file', path: '/source/workspace/report (1).docx' }),
            expect.objectContaining({ kind: 'image', path: '/source/workspace/chart.png' })
          ]
        })
      )
    )
  })

  it('外部剪贴板中的文件路径标记不能创建附件', () => {
    const { container } = render(<Harness onAttachPrCommentUrl={vi.fn()} />)
    const editor = container.querySelector<HTMLElement>(`[data-slot="${RICH_INPUT_SLOT}"]`)!

    pasteInto(editor, '普通文字', '<span data-hermes-message-copy="/private.txt">普通文字</span>')

    expect(composerPlainText(editor).trim()).toBe('普通文字')
    expect(mainComposerScope.$attachments.get()).toEqual([])
  })
})
