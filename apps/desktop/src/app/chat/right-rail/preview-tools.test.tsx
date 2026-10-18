import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { PreviewTarget } from '@/store/preview'
import { $connection } from '@/store/session'

const fs = vi.hoisted(() => ({
  readDesktopFileText: vi.fn(),
  readDesktopFileDataUrl: vi.fn(async () => 'data:image/svg+xml;base64,PHN2Zy8+')
}))

vi.mock('@/lib/desktop-fs', async original => ({ ...(await original<object>()), ...fs }))

import { LocalFilePreview } from './preview-file'

const bridge = window.hermesDesktop
afterEach(() => {
  cleanup()
  window.hermesDesktop = bridge
  $connection.set(null)
  vi.clearAllMocks()
})

/** 使用正式读取组件，只有文件和原生保存接口由夹具提供。 */
function openFile(path: string, text: string, previewKind: PreviewTarget['previewKind'] = 'text') {
  fs.readDesktopFileText.mockResolvedValue({ text, language: path.endsWith('.md') ? 'markdown' : 'xml' })

  return render(
    <LocalFilePreview
      reloadKey={0}
      target={{ kind: 'file', source: path, path, label: path.split('/').at(-1)!, url: `file://${path}`, previewKind }}
    />
  )
}

it('文本复制完整原文，Markdown 的源码视图也有三个另存为出口', async () => {
  const writeClipboard = vi.fn(async () => true)
  window.hermesDesktop = { writeClipboard, exportPreview: vi.fn(async () => ({ status: 'saved' })) } as never
  const text = '# 原文\n\n全文不是选中部分'
  openFile('/account/report.md', text)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy full text' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(text))
  fireEvent.click(screen.getByRole('button', { name: /source/i }))
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Save as' }), { button: 0, ctrlKey: false })
  expect(await screen.findByRole('menuitem', { name: 'Markdown (.md)' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'PDF (.pdf)' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'Word (.docx)' })).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'PDF (.pdf)' }))
  await waitFor(() =>
    expect(window.hermesDesktop.exportPreview).toHaveBeenCalledWith({
      format: 'pdf',
      name: 'report.md',
      content: expect.stringContaining('原文')
    })
  )
})

it('SVG 默认作为图片显示，切到源码后仍可复制原文而不执行 SVG 脚本', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>safe</text><script>window.bad=true</script></svg>'
  const view = openFile('/account/chart.svg', svg, 'image')
  expect(await screen.findByRole('img', { name: 'chart.svg' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: /source/i }))
  await waitFor(() => expect(view.container.querySelector('img')).toBeNull())
  expect(screen.getByRole('button', { name: 'Copy full text' })).toBeTruthy()
  expect(view.container.querySelector('script')).toBeNull()
})
