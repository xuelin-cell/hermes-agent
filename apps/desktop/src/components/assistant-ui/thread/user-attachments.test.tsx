import { AssistantRuntimeProvider, ExportedMessageRepository, type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

import { PRIMARY_SESSION_VIEW, SessionViewProvider } from '@/app/chat/session-view'
import { planEdit } from '@/app/session/hooks/use-prompt-actions/rewind'
import { formatRefValue } from '@/components/assistant-ui/directive-text'
import { I18nProvider } from '@/i18n'
import { type ChatMessage, toChatMessages } from '@/lib/chat-messages'
import { toRuntimeMessage } from '@/lib/chat-runtime'
import { useIncrementalExternalStoreRuntime } from '@/lib/incremental-external-store-runtime'
import { $previewTabs, closeRightRail } from '@/store/preview'

import { stubThreadEnvironment, stubThreadViewportSize } from '../test-utils'

import { Thread } from '.'

stubThreadEnvironment()
stubThreadViewportSize()

const spreadsheet = String.raw`C:\Users\stan\AppData\Local\uniworker\account\home\attachments\示例表格 (6).xlsx`
const pdf = String.raw`C:\Users\stan\AppData\Local\uniworker\account\home\attachments\示例文档.pdf`
const normalize = vi.fn(async () => null)
const bridge = window.hermesDesktop
const editedPlan = vi.fn()

/** 使用桌面实际的增量运行时，验证原消息编辑器也能从附件消息打开。 */
function SentFilesThread({ messages }: { messages: ChatMessage[] }) {
  const runtime = useIncrementalExternalStoreRuntime<ThreadMessage>({
    messageRepository: ExportedMessageRepository.fromArray(messages.map(toRuntimeMessage)),
    isRunning: false,
    setMessages: () => {},
    onNew: async () => {},
    onEdit: async edited => {
      editedPlan(planEdit(messages, edited))
    },
    onCancel: async () => {},
    onReload: async () => {}
  })

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <Thread />
    </AssistantRuntimeProvider>
  )
}

/** 通过正式消息转换、完整聊天组件和会话目录验证发送后的附件入口。 */
function renderSentFiles(caption: string, refs: string[], restored = false) {
  const messages = restored
    ? toChatMessages([{ role: 'user', content: [...refs, '', caption].join('\n') }])
    : [
        {
          id: 'sent-user',
          role: 'user' as const,
          parts: [{ type: 'text' as const, text: caption }],
          attachmentRefs: refs
        }
      ]

  window.hermesDesktop = { normalizePreviewTarget: normalize } as unknown as Window['hermesDesktop']

  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <SessionViewProvider value={{ ...PRIMARY_SESSION_VIEW, $cwd: atom('/this-session/workspace') }}>
        <SentFilesThread messages={messages} />
      </SessionViewProvider>
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  closeRightRail()
  normalize.mockClear()
  editedPlan.mockClear()
  window.hermesDesktop = bridge
})

it.each([false, true])('发送后和历史重开均显示可预览的同款文档卡片：restored=%s', async restored => {
  const view = renderSentFiles(
    '你好',
    [spreadsheet, pdf].map(path => `@file:${formatRefValue(path)}`),
    restored
  )

  const cards = [
    await screen.findByRole('button', { name: 'Preview 示例表格 (6).xlsx' }),
    screen.getByRole('button', { name: 'Preview 示例文档.pdf' })
  ]

  expect(view.container.querySelectorAll('[data-slot="composer-attachments"]')).toHaveLength(2)
  expect(screen.getByText('你好')).toBeTruthy()
  expect(within(cards[0]).getByText('示例表格 (6).xlsx')).toBeTruthy()
  expect(within(cards[0]).getByText(spreadsheet)).toBeTruthy()
  const bubble = cards[0].closest('.composer-human-message')
  expect(bubble).toBeTruthy()
  expect(cards[1].closest('.composer-human-message')).toBe(bubble)
  expect(screen.getByText('你好').closest('.composer-human-message')).toBe(bubble)
  expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  expect(normalize).not.toHaveBeenCalled()

  for (const [index, card] of cards.entries()) {
    await act(async () => fireEvent.click(card))
    expect(normalize).toHaveBeenLastCalledWith([spreadsheet, pdf][index], '/this-session/workspace')
    expect($previewTabs.get().at(-1)?.target.path).toBe([spreadsheet, pdf][index])
  }

  expect(view.container.querySelector('[data-slot="aui_edit-composer-root"]')).toBeNull()
})

it('只发送文件时预览与编辑入口并存，带空格的相对路径按所属会话打开', async () => {
  const view = renderSentFiles('', ['@file:`documents/项目周报 (1).md`'], true)
  const card = await screen.findByRole('button', { name: 'Preview 项目周报 (1).md' })

  expect(card.parentElement?.closest('button')).toBeNull()
  expect(screen.getByRole('button', { name: 'Edit message' })).toBeTruthy()
  await act(async () => fireEvent.click(card))
  expect(normalize).toHaveBeenCalledWith('documents/项目周报 (1).md', '/this-session/workspace')
  expect($previewTabs.get().at(-1)?.target.path).toBe('/this-session/workspace/documents/项目周报 (1).md')
  expect(view.container.querySelector('[data-slot="aui_edit-composer-root"]')).toBeNull()
})

it('只发送文件仍能打开原编辑器，取消编辑后卡片和预览入口保留', async () => {
  const view = renderSentFiles('', [`@file:${formatRefValue(pdf)}`], true)
  const edit = await screen.findByRole('button', { name: 'Edit message' })

  fireEvent.click(edit)
  const editor = await screen.findByRole('textbox', { name: 'Edit message' })

  expect(view.container.querySelector('[data-slot="aui_edit-composer-root"]')).toBeTruthy()
  expect(normalize).not.toHaveBeenCalled()
  fireEvent.keyDown(editor, { key: 'Escape' })
  expect(await screen.findByRole('button', { name: 'Preview 示例文档.pdf' })).toBeTruthy()
  expect(view.container.querySelector('[data-slot="aui_edit-composer-root"]')).toBeNull()
})

it.each(['你好', ''])('统一编辑只修改文字并在重发时保留原文档：caption=%s', async caption => {
  const refs = [spreadsheet, pdf].map(path => `@file:${formatRefValue(path)}`)
  renderSentFiles(caption, refs, true)
  fireEvent.click(await screen.findByRole('button', { name: 'Edit message' }))
  const editor = await screen.findByRole('textbox', { name: 'Edit message' })

  expect(editor.textContent).toBe(caption)
  expect(
    screen.getByRole('button', { name: 'Preview 示例文档.pdf' }).closest('[data-slot="aui_edit-composer-root"]')
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  editor.textContent = '请重新总结这两份文档'
  fireEvent.input(editor)
  await act(async () => fireEvent.keyDown(editor, { key: 'Enter' }))

  expect(editedPlan).toHaveBeenCalledTimes(1)
  expect(editedPlan.mock.calls[0][0]).toMatchObject({
    text: `${refs.join('\n')}\n\n请重新总结这两份文档`,
    sourceText: [refs.join('\n'), caption].filter(Boolean).join('\n\n'),
    editedMessage: { parts: [{ type: 'text', text: '请重新总结这两份文档' }], attachmentRefs: refs }
  })
})

it('文档与图片混发保留图片缩略图，长粘贴文件保留可读名称', async () => {
  const pasted = '/account/home/attachments/pasted_content_2026-10-27_abc123.txt'
  const image = 'data:image/png;base64,iVBORw0KGgo='
  const view = renderSentFiles('看一下', [`@file:${pasted}`, `@image:${image}`])

  const card = await screen.findByRole('button', { name: 'Preview Pasted content' })
  expect(within(card).getByText('Pasted content')).toBeTruthy()
  expect(view.container.querySelector('[data-slot="aui_directive-image"] img')?.getAttribute('src')).toBe(image)
  expect(view.container.querySelectorAll('[data-slot="composer-attachments"]')).toHaveLength(1)
})

it('仅文件夹引用仍保留原来的消息编辑入口，不改成文档卡片', async () => {
  const view = renderSentFiles('', ['@folder:documents/'])

  expect(await screen.findByRole('button', { name: 'Edit message' })).toBeTruthy()
  expect(screen.getByTitle('documents/')).toBeTruthy()
  expect(view.container.querySelector('[data-slot="composer-attachments"]')).toBeNull()
})
