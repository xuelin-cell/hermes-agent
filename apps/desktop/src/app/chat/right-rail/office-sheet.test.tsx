import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { browserShellCopy } from '@/lib/browser-shell'
import type { PreviewTarget } from '@/store/preview'

// The viewer reaches the bridge through lib/browser-shell.ts, which imports it only when a spreadsheet opens.
const bridge = vi.hoisted(() => ({
  officeSheet: vi.fn(),
  officeSheetImageUrl: vi.fn((path: string, name: string, version: string) => `/charts/${name}?v=${version}`)
}))

vi.mock('@/dev/browser-bridge', () => bridge)

import { OfficeSheet, sheetFragment } from './office-sheet'

const book: PreviewTarget = {
  kind: 'file',
  label: '城市客流统计.xlsx',
  path: '/mnt/u/workspace/城市客流统计.xlsx',
  previewKind: 'pdf',
  source: '/mnt/u/workspace/城市客流统计.xlsx',
  url: 'file:///mnt/u/workspace/x.xlsx'
}

const copy = browserShellCopy()
const table = () => window.document.querySelector('[data-sheet-table]') as HTMLElement
const sheet = (html: string, name = '', rows = 1, shown = rows) => ({ html, name, rows, shown })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// What LibreOffice exports, plus what a hostile file could try to bring along.
const EXPORTED = [
  '<table cellspacing="0" border="0">',
  '<colgroup width="93"></colgroup>',
  '<tr>',
  '<td colspan=2 bgcolor="#1F4E79" style="border-top: 2px solid #c00000" onclick="alert(1)"><b><font color="#FFFFFF">标题</font></b></td>',
  '</tr>',
  '<tr>',
  '<td><a class="comment-indicator"></a><comment>这是一条批注</comment><font color="#000000">有批注</font></td>',
  '<td align="right"><font color="#000000">1,115</font></td>',
  '</tr>',
  '<tr>',
  '<td><a href="https://example.com/a?b=1">链接</a></td>',
  '<td><a href="javascript:alert(1)">坏链接</a></td>',
  '</tr>',
  '<tr>',
  '<td><img src="source_html_1.png" width=907 height=378></td>',
  '<td><img src="https://evil.example/x.png"><script>alert(1)</script><iframe src="https://evil.example"></iframe></td>',
  '</tr>',
  '<tr>',
  '<td style="background: url(https://evil.example/t.png)">贵</td>',
  '</tr>',
  '</table>'
].join('')

describe('a sheet’s table', () => {
  it('keeps what makes it a spreadsheet and drops what could act or reach out', () => {
    const host = window.document.createElement('div')

    host.append(sheetFragment(EXPORTED, name => (name === 'source_html_1.png' ? `/charts/${name}` : null)))

    const cells = Array.from(host.querySelectorAll('td'))

    expect(host.querySelector('table')?.getAttribute('cellspacing')).toBe('0')
    expect(cells[0]?.getAttribute('colspan')).toBe('2')
    expect(cells[0]?.getAttribute('bgcolor')).toBe('#1F4E79')
    expect(cells[0]?.getAttribute('style')).toBe('border-top: 2px solid #c00000')
    expect(cells[0]?.hasAttribute('onclick')).toBe(false)
    expect(cells[0]?.querySelector('font')?.getAttribute('color')).toBe('#FFFFFF')
    // The note becomes the cell's tooltip; its marker goes.
    expect(cells[1]?.getAttribute('title')).toBe('这是一条批注')
    expect(cells[1]?.textContent).toBe('有批注')
    expect(cells[1]?.querySelector('a')).toBeNull()
    expect(cells[2]?.getAttribute('align')).toBe('right')

    const [link, bad] = Array.from(host.querySelectorAll('a'))

    expect(link?.getAttribute('href')).toBe('https://example.com/a?b=1')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(bad?.hasAttribute('href')).toBe(false)
    // Only the chart the instance listed, from the instance.
    expect(Array.from(host.querySelectorAll('img'), image => image.getAttribute('src'))).toEqual([
      '/charts/source_html_1.png'
    ])
    expect(host.querySelector('script, iframe')).toBeNull()
    expect(cells.at(-1)?.hasAttribute('style')).toBe(false)
    expect(cells.at(-1)?.textContent).toBe('贵')
  })
})

describe('sheet viewer', () => {
  it('shows the first sheet, and the others from their tabs', async () => {
    bridge.officeSheet.mockResolvedValue({
      images: ['source_html_1.png'],
      sheets: [
        sheet('<table><tr><td>北京</td><td><img src="source_html_1.png"></td></tr></table>', '客流统计'),
        sheet('<table><tr><td>109,080</td></tr></table>', '')
      ],
      version: 'v1'
    })

    render(<OfficeSheet reloadKey={0} target={book} />)

    expect(screen.getByRole('status', { name: copy.slides.preparing })).toBeTruthy()
    await waitFor(() => expect(table()?.textContent).toBe('北京'))
    expect(bridge.officeSheet).toHaveBeenCalledWith('/mnt/u/workspace/城市客流统计.xlsx')
    expect(table().querySelector('img')?.getAttribute('src')).toBe('/charts/source_html_1.png?v=v1')

    const tabs = screen.getAllByRole('tab')

    expect(tabs.map(tab => tab.textContent)).toEqual(['客流统计', copy.sheet.unnamed(2)])
    expect(tabs.map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false'])

    fireEvent.click(tabs[1] as HTMLElement)

    await waitFor(() => expect(table().textContent).toBe('109,080'))
    expect(screen.getAllByRole('tab').map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  it('has no tabs for a lone sheet, and says when a sheet came with its first rows only', async () => {
    bridge.officeSheet.mockResolvedValue({
      images: [],
      sheets: [sheet('<table><tr><td>1</td></tr></table>', '', 20001, 1000)],
      version: 'v1'
    })

    render(<OfficeSheet reloadKey={0} target={book} />)

    await waitFor(() => expect(table()?.textContent).toBe('1'))
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.getByText(copy.sheet.truncated(1000, 20001))).toBeTruthy()
  })

  it('says why there is no preview, or that there is nothing to show', async () => {
    bridge.officeSheet.mockRejectedValue(new Error(copy.officePreview.too_large))

    const { rerender } = render(<OfficeSheet reloadKey={0} target={book} />)

    expect(await screen.findByText(copy.officePreview.too_large)).toBeTruthy()

    bridge.officeSheet.mockResolvedValue({ images: [], sheets: [], version: 'v1' })
    rerender(<OfficeSheet reloadKey={1} target={book} />)

    expect(await screen.findByText(copy.sheet.empty)).toBeTruthy()
  })

  it('asks again when the pane reloads', async () => {
    bridge.officeSheet.mockResolvedValue({
      images: [],
      sheets: [sheet('<table><tr><td>v1</td></tr></table>')],
      version: 'v1'
    })

    const { rerender } = render(<OfficeSheet reloadKey={0} target={book} />)

    await waitFor(() => expect(table()?.textContent).toBe('v1'))
    bridge.officeSheet.mockResolvedValue({
      images: [],
      sheets: [sheet('<table><tr><td>v2</td></tr></table>')],
      version: 'v2'
    })
    rerender(<OfficeSheet reloadKey={1} target={book} />)

    await waitFor(() => expect(table()?.textContent).toBe('v2'))
    expect(bridge.officeSheet).toHaveBeenCalledTimes(2)
  })
})
