import { afterEach, expect, it, vi } from 'vitest'

import { renderMediaTags } from '@/lib/chat-messages/parts'
import { $connection } from '@/store/session'

import { filePathFromMediaPath, mediaMarkdownHref, mediaPathFromMarkdownHref, mediaStreamUrl } from './media'

afterEach(() => {
  $connection.set(null)
  vi.restoreAllMocks()
})

it.each([
  ['Win32', 'local', 'C:\\输出\\样例.mp4'],
  ['MacIntel', 'local', '/C:\\输出\\样例.mp4'],
  ['Linux x86_64', 'local', '/C:\\输出\\样例.mp4'],
  ['Win32', 'remote', '/C:\\输出\\样例.mp4']
])('媒体路径修正只适用于 Windows 本机：%s / %s', (platform, mode, expected) => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
  $connection.set({ mode } as never)
  const raw = '/C:\\输出\\样例.mp4'
  const href = mediaMarkdownHref(raw)
  expect(mediaPathFromMarkdownHref(href)).toBe(expected)
  expect(filePathFromMediaPath(raw)).toBe(expected)
  expect(renderMediaTags(`MEDIA:${raw}`)).toContain(encodeURIComponent(expected))
  expect(mediaStreamUrl(raw)).toBe(`hermes-media://stream/${encodeURIComponent(expected)}`)
})

it('Windows 本机同时接受正斜杠和文件 URL，不改普通路径、网络地址或 UNC', () => {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32')
  $connection.set({ mode: 'local' } as never)
  expect(filePathFromMediaPath('/X:/输出/a.png')).toBe('X:/输出/a.png')
  expect(filePathFromMediaPath('file:///X:/a%20b.png')).toBe('X:/a b.png')

  for (const path of ['C:/a.png', '/tmp/a.png', 'https://host/C:/a.png', '\\\\host\\share\\a.png']) {
    expect(filePathFromMediaPath(path)).toBe(path)
  }
})
