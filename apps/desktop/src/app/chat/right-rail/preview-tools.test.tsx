import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { artifactShareFilePath } from '@/lib/artifact-share-source'
import type { PreviewTarget } from '@/store/preview'
import { $activeSessionId, $connection, $currentCwd, $selectedStoredSessionId } from '@/store/session'

const fs = vi.hoisted(() => ({
  readDesktopFileText: vi.fn(),
  readDesktopFileDataUrl: vi.fn(async () => 'data:image/svg+xml;base64,PHN2Zy8+')
}))

vi.mock('@/lib/desktop-fs', async original => ({ ...(await original<object>()), ...fs }))

import { LocalFilePreview } from './preview-file'

const bridge = window.hermesDesktop
afterEach(() => {
  cleanup()
  document.querySelectorAll('style[data-export-test]').forEach(style => style.remove())
  window.hermesDesktop = bridge
  $connection.set(null)
  $activeSessionId.set(null)
  $selectedStoredSessionId.set(null)
  $currentCwd.set('')
  delete document.documentElement.dataset.hermesBrowser
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it('云端 Markdown 在工作区外或没有 cwd 时仍提供分享入口，由实例核验来源', async () => {
  document.documentElement.dataset.hermesBrowser = 'production'
  const eligibility = vi.fn(async () => ({ publishable: true }))
  window.hermesDesktop = {
    artifactShare: { eligibility, onChanged: () => () => {} }
  } as never
  $connection.set({ mode: 'remote', profile: 'default' } as never)
  $activeSessionId.set('generated-chat')
  $currentCwd.set('/workspace')
  const view = openFile('/tmp/report.md', '# Generated report')

  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Share artifact' }) as HTMLButtonElement).disabled).toBe(false)
  )
  expect(eligibility).toHaveBeenCalledWith({ sessionId: 'generated-chat', path: '/tmp/report.md', content: undefined })
  $currentCwd.set('')
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Share artifact' }) as HTMLButtonElement).disabled).toBe(false)
  )
  view.unmount()

  eligibility.mockResolvedValue({ publishable: false })
  openFile('/tmp/report.md', '# Unknown origin')
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Share artifact' }) as HTMLButtonElement).disabled).toBe(true)
  )
})

it('本机分享路径仍限制在工作区，云端也不将 URL、相对路径或其他文件类型视为分享文件', () => {
  expect(artifactShareFilePath('/workspace/report.md', '/workspace')).toBe('/workspace/report.md')
  expect(artifactShareFilePath('/tmp/report.md', '/workspace')).toBeNull()
  expect(artifactShareFilePath('/workspace/report.md', '')).toBeNull()
  window.document.documentElement.dataset.hermesBrowser = 'production'
  expect(artifactShareFilePath('file:///tmp/report.html', '')).toBe('/tmp/report.html')

  for (const value of ['https://example.com/report.md', 'report.md', '/tmp/../report.md', '/tmp/report.py']) {
    expect(artifactShareFilePath(value, '')).toBeNull()
  }
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

it('Markdown 统一菜单在源码视图导出原文、保留样式与画布的 PDF 和 Word 快照', async () => {
  const writeClipboard = vi.fn(async () => true)
  window.hermesDesktop = { writeClipboard, exportPreview: vi.fn(async () => ({ status: 'saved' })) } as never
  const text = '# 原文\n\n全文不是选中部分'
  const view = openFile('/account/report.md', text)
  fireEvent.click(await screen.findByRole('button', { name: 'Copy full text' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(text))
  const download = screen.getByRole('button', { name: 'Save as' })
  expect(download.querySelector('svg')).not.toBeNull()
  expect(download.textContent).toBe('')
  expect(screen.queryByRole('button', { name: 'Export PDF' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /source/i }))

  const style = document.createElement('style')
  style.dataset.exportTest = ''
  style.textContent = '.export-proof { color: rgb(12, 34, 56); }'
  document.head.append(style)
  const css = style.sheet!.cssRules[0].cssText
  const canvas = document.createElement('canvas')
  const png = 'data:image/png;base64,cGljdHVyZQ=='
  vi.spyOn(canvas, 'toDataURL').mockReturnValue(png)
  const preview = view.container.querySelector('[data-preview-markdown]')!
  preview.append(canvas)
  expect(view.container.querySelectorAll('[data-preview-markdown]')).toHaveLength(1)

  fireEvent.pointerDown(screen.getByRole('button', { name: 'Save as' }), { button: 0, ctrlKey: false })
  expect(await screen.findByRole('menuitem', { name: 'Markdown (.md)' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'PDF (.pdf)' })).toBeTruthy()
  expect(screen.getByRole('menuitem', { name: 'Word (.docx)' })).toBeTruthy()
  fireEvent.click(screen.getByRole('menuitem', { name: 'PDF (.pdf)' }))
  await waitFor(() =>
    expect(window.hermesDesktop.exportPreview).toHaveBeenCalledWith({
      format: 'pdf',
      name: 'report.md',
      content: expect.stringContaining(css)
    })
  )
  const pdf = vi.mocked(window.hermesDesktop.exportPreview).mock.calls[0][0].content
  expect(pdf).toContain('原文')
  expect(pdf).toContain(png)
  expect(pdf).not.toContain('<canvas')
  expect(preview.querySelector('canvas')).toBe(canvas)

  canvas.remove()

  for (const [format, label] of [
    ['md', 'Markdown (.md)'],
    ['docx', 'Word (.docx)']
  ] as const) {
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'Save as' }) as HTMLButtonElement).disabled).toBe(false)
    )
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Save as' }), { button: 0, ctrlKey: false })
    fireEvent.click(await screen.findByRole('menuitem', { name: label }))
    await waitFor(() =>
      expect(window.hermesDesktop.exportPreview).toHaveBeenLastCalledWith({
        format,
        name: 'report.md',
        content: format === 'md' ? text : expect.stringContaining('原文')
      })
    )
  }
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
