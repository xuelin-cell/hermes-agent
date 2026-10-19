import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $previewTabs } from '@/store/preview'
import { $connection } from '@/store/session'

import { MessageTextContent } from './markdown-text'

const bridge = window.hermesDesktop

afterEach(() => {
  cleanup()
  $previewTabs.set([])
  $connection.set(null)
  window.hermesDesktop = bridge
  vi.restoreAllMocks()
})

it.each(['png', 'mp4', 'mp3'])('MEDIA %s 保留内嵌展示，并能点击打开同一文件的右侧预览', async extension => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  $connection.set({ mode: 'local' } as never)
  window.hermesDesktop = { readFileDataUrl: vi.fn(async () => 'data:image/png;base64,eA==') } as never
  const path = `C:/输出/样例.${extension}`
  render(<MessageTextContent text={`MEDIA:/${path}`} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Open preview' }))
  await waitFor(() => expect($previewTabs.get().at(-1)?.target.path).toBe(path))
})

it('音视频加载失败后的系统打开入口使用当前语言', async () => {
  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <MessageTextContent text="MEDIA:/tmp/样例.mp4" />
    </I18nProvider>
  )

  const video = await waitFor(() => {
    const element = view.container.querySelector('video')
    expect(element).not.toBeNull()

    return element!
  })

  fireEvent.error(video)
  expect(await screen.findByRole('button', { name: '打开视频文件' })).toBeTruthy()
})
