import { Blob as NodeBlob } from 'node:buffer'

import { AssistantRuntimeProvider, ExportedMessageRepository, type ThreadMessage } from '@assistant-ui/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

import { readCopiedMessageAttachments } from '@/app/chat/composer/message-clipboard'
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

const spreadsheet = String.raw`C:\Users\stan\AppData\Local\uniwork\account\home\attachments\示例表格 (6).xlsx`
const pdf = String.raw`C:\Users\stan\AppData\Local\uniwork\account\home\attachments\示例文档.pdf`
const normalize = vi.fn(async () => null)
const writeClipboard = vi.fn(async (_text: string, _html?: string) => true)
const saveImageBuffer = vi.fn(async () => '/account/home/composer-images/copied.png')
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
function renderSentFiles(caption: string, refs: string[], restored = false, inlineFiles = false) {
  const messages = restored
    ? toChatMessages([{ role: 'user', content: [...refs, '', caption].join('\n') }])
    : [
        {
          id: 'sent-user',
          role: 'user' as const,
          parts: [
            {
              type: 'text' as const,
              text: inlineFiles
                ? [refs.filter(ref => ref.startsWith('@file:')).join('\n'), caption].filter(Boolean).join('\n\n')
                : caption
            }
          ],
          attachmentRefs: inlineFiles ? refs.filter(ref => !ref.startsWith('@file:')) : refs
        }
      ]

  window.hermesDesktop = {
    normalizePreviewTarget: normalize,
    saveImageBuffer,
    writeClipboard
  } as unknown as Window['hermesDesktop']

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
  saveImageBuffer.mockClear()
  writeClipboard.mockClear()
  editedPlan.mockClear()
  window.hermesDesktop = bridge
  vi.unstubAllGlobals()
})

it.each([
  ['', false],
  ['请整理', false],
  ['请整理', true]
] as const)('正文中的上传文件也显示卡片，混合图片不会留下路径：caption=%s restored=%s', async (caption, restored) => {
  vi.stubGlobal('Blob', NodeBlob)

  const refs = [
    '@image:data:image/png;base64,iVBORw0KGgo=',
    '@file:`C:\\Docs\\IDEA-11.md`',
    `@file:${formatRefValue(pdf)}`,
    `@file:${formatRefValue(spreadsheet)}`
  ]

  const view = renderSentFiles(caption, refs, restored, true)
  expect(await screen.findByRole('button', { name: 'Preview IDEA-11.md' })).toBeTruthy()
  expect(view.container.querySelectorAll('[data-slot="message-attachment-tile"]')).toHaveLength(4)
  expect(view.container.querySelector('[data-slot="aui_user-message-text"]')?.textContent ?? '').toBe(caption)
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(1))
  const [copiedText, html] = writeClipboard.mock.calls[0]
  expect(copiedText).toBe(caption)
  expect(readCopiedMessageAttachments({ getData: () => html ?? '' } as unknown as DataTransfer)).toHaveLength(4)

  fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
  const editor = await screen.findByRole('textbox', { name: 'Edit message' })
  const editRoot = editor.closest('[data-slot="aui_edit-composer-root"]')!
  expect(editRoot.querySelectorAll('[data-slot="message-attachment-tile"]')).toHaveLength(4)
  expect(editor.textContent).toBe(caption)
  editor.textContent = '请重新整理'
  fireEvent.input(editor)
  await act(async () => fireEvent.keyDown(editor, { key: 'Enter' }))

  expect(editedPlan.mock.calls[0][0]).toMatchObject({
    text: refs.filter(ref => ref.startsWith('@file:')).join('\n') + '\n\n请重新整理',
    imageRefs: [refs[0]],
    editedMessage: { attachmentRefs: expect.arrayContaining(refs) }
  })
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

  expect(view.container.querySelectorAll('[data-slot="message-attachment-tile"]')).toHaveLength(2)
  expect(screen.getByText('你好')).toBeTruthy()
  expect(within(cards[0]).getByText('示例表格 (6).xlsx')).toBeTruthy()
  expect(within(cards[0]).getByText('XLSX')).toBeTruthy()
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

it('发送态和编辑态共用等大卡片，重发时原图仍作为图片附件', async () => {
  const pasted = '/account/home/attachments/pasted_content_2026-10-27_abc123.txt'
  const image = 'data:image/png;base64,iVBORw0KGgo='
  const refs = [`@file:${pasted}`, `@image:${image}`, `@file:${formatRefValue(pdf)}`]
  const view = renderSentFiles('看一下', refs)

  const card = await screen.findByRole('button', { name: 'Preview Pasted content' })
  expect(within(card).getByText('Pasted content')).toBeTruthy()
  const thumbnail = screen.getByRole('img', { name: 'image.png' })
  expect(thumbnail?.getAttribute('src')).toBe(image)
  expect(thumbnail?.closest('.composer-human-message')).toBe(card.closest('.composer-human-message'))
  const sentTiles = Array.from(view.container.querySelectorAll('[data-slot="message-attachment-tile"]'))
  expect(sentTiles).toHaveLength(3)
  expect(sentTiles.every(tile => tile.classList.contains('size-[92px]'))).toBe(true)
  expect(thumbnail.classList.contains('object-cover')).toBe(true)
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Preview image.png' })))
  expect(
    within(await screen.findByRole('dialog'))
      .getByRole('img')
      .getAttribute('src')
  ).toBe(image)
  fireEvent.keyDown(await screen.findByRole('dialog'), { key: 'Escape' })

  fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
  const editor = await screen.findByRole('textbox', { name: 'Edit message' })
  const editRoot = editor.closest('[data-slot="aui_edit-composer-root"]')!
  const editTiles = Array.from(editRoot.querySelectorAll('[data-slot="message-attachment-tile"]'))

  expect(editTiles.map(tile => tile.textContent)).toEqual(sentTiles.map(tile => tile.textContent))
  expect(
    within(editRoot as HTMLElement)
      .getByRole('img', { name: 'image.png' })
      .getAttribute('src')
  ).toBe(image)
  editor.textContent = '重新看一下'
  fireEvent.input(editor)
  await act(async () => fireEvent.keyDown(editor, { key: 'Enter' }))

  expect(editedPlan).toHaveBeenCalledWith(
    expect.objectContaining({
      imageRefs: [`@image:${image}`],
      editedMessage: expect.objectContaining({ attachmentRefs: refs })
    })
  )
})

it.each(['请听这段录音', ''])('复制历史消息时带上原会话的音频与文档：caption=%s', async caption => {
  renderSentFiles(caption, ['@file:`录音/问题 12.wav`', `@file:${formatRefValue(pdf)}`], true)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(1))

  const [text, html] = writeClipboard.mock.calls[0]
  expect(text).toBe(caption)
  expect(html).not.toContain('问题 12.wav')
  const clipboard = { getData: () => html ?? '' } as unknown as DataTransfer

  expect(readCopiedMessageAttachments(clipboard)).toMatchObject([
    { kind: 'file', path: '/this-session/workspace/录音/问题 12.wav' },
    { kind: 'file', path: pdf }
  ])
})

it('只有图片数据的消息也能复制为可重新发送的附件', async () => {
  vi.stubGlobal('Blob', NodeBlob)
  renderSentFiles('', ['@image:data:image/png;base64,iVBORw0KGgo='])
  fireEvent.click(await screen.findByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(1))

  const [, html] = writeClipboard.mock.calls[0]
  const clipboard = { getData: () => html ?? '' } as unknown as DataTransfer

  expect(saveImageBuffer).toHaveBeenCalledWith(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10), '.png')
  expect(readCopiedMessageAttachments(clipboard)).toMatchObject([
    { kind: 'image', path: '/account/home/composer-images/copied.png' }
  ])
})

it.each(['', '整理目录里的材料'])('文件夹与正文共用卡片区域，复制和编辑后仍保留目录引用：%s', async caption => {
  const folder = '@folder:`documents/测试文件夹.v1/`'
  const view = renderSentFiles(caption, [folder, `@file:${formatRefValue(pdf)}`], true)
  const folderCard = await screen.findByRole('button', { name: '测试文件夹.v1' })
  const documentCard = screen.getByRole('button', { name: 'Preview 示例文档.pdf' })
  const bubble = folderCard.closest('.composer-human-message')

  expect(bubble).toBeTruthy()
  expect(documentCard.closest('.composer-human-message')).toBe(bubble)
  expect(view.container.querySelector('[data-slot="aui_user-attachments"]')).toBeNull()
  expect(view.container.querySelectorAll('[data-slot="message-attachment-tile"]')).toHaveLength(2)
  expect(within(folderCard).queryByText('V1')).toBeNull()
  expect(view.container.querySelector('[data-slot="aui_user-message-text"]')?.textContent ?? '').toBe(caption)
  fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledTimes(1))
  const [text, html] = writeClipboard.mock.calls[0]
  expect(text).toBe(caption)
  expect(readCopiedMessageAttachments({ getData: () => html ?? '' } as unknown as DataTransfer)).toMatchObject([
    { kind: 'folder', path: '/this-session/workspace/documents/测试文件夹.v1' },
    { kind: 'file', path: pdf }
  ])

  fireEvent.click(screen.getByRole('button', { name: 'Edit message' }))
  const editor = await screen.findByRole('textbox', { name: 'Edit message' })
  expect(
    editor.closest('[data-slot="aui_edit-composer-root"]')?.querySelectorAll('[data-slot="message-attachment-tile"]')
  ).toHaveLength(2)
  expect(editor.textContent).toBe(caption)
  editor.textContent = '重新整理目录'
  fireEvent.input(editor)
  await act(async () => fireEvent.keyDown(editor, { key: 'Enter' }))
  expect(editedPlan).toHaveBeenCalledWith(
    expect.objectContaining({
      text: [folder, `@file:${formatRefValue(pdf)}`].join('\n') + '\n\n重新整理目录'
    })
  )
})
