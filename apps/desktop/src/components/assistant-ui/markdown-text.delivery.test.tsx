import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { renderMediaTags } from '@/lib/chat-messages/parts'
import { mediaMarkdownHref } from '@/lib/media'
import { $previewTabs } from '@/store/preview'
import { $connection } from '@/store/session'

import { MarkdownTextContent, MessageTextContent } from './markdown-text'

afterEach(() => {
  cleanup()
  $previewTabs.set([])
  $connection.set(null)
  vi.restoreAllMocks()
})

it('历史与流式回复统一去重路径别名，重复说明保留，下一条回复仍可重新交付', async () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  $connection.set({ mode: 'local' } as never)
  const target = 'C:/work/报告 (1).md'
  const first = `MEDIA:/${target}`
  const text = `${first}\n\n[第二处说明](${mediaMarkdownHref('C:\\work\\报告 (1).md')})\n\n[第三处说明](file:///C:/work/%E6%8A%A5%E5%91%8A%20%281%29.md)`
  const view = render(<MarkdownTextContent isRunning text={renderMediaTags(first)} />)
  expect(await screen.findAllByRole('button', { name: 'Open preview' })).toHaveLength(1)
  view.rerender(<MarkdownTextContent isRunning text={renderMediaTags(text)} />)
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'Open preview' })).toHaveLength(1))
  view.rerender(<MarkdownTextContent isRunning={false} text={renderMediaTags(text)} />)
  expect(screen.getByText('第二处说明')).toBeTruthy()
  expect(screen.getByText('第三处说明')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open preview' }))
  await waitFor(() => expect($previewTabs.get().at(-1)?.target.path).toBe(target))
  view.unmount()
  $previewTabs.set([])
  render(<MessageTextContent text={text} />)
  expect(await screen.findAllByRole('button', { name: 'Open preview' })).toHaveLength(1)
})

it('临时文件引用不出卡，正式文件、不同格式和代码示例保持原行为', async () => {
  const source = [
    'MEDIA:/work/.tmp/draft.pptx',
    '[临时图](#preview/%2Fwork%2F.tmp%2Fchart.html)',
    'MEDIA:/work/final.pptx',
    'MEDIA:/work/final.pdf',
    '```text\nMEDIA:/work/.tmp/example.pdf\n```'
  ].join('\n\n')

  render(<MessageTextContent text={source} />)
  expect(await screen.findAllByRole('button', { name: 'Open preview' })).toHaveLength(2)
  expect(screen.getByText('临时图')).toBeTruthy()
  expect(screen.getByText('final.pptx')).toBeTruthy()
  expect(screen.getByText('final.pdf')).toBeTruthy()
})
