import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $dirtyPreviewUrls } from '@/store/preview-edit'

import { LocalFilePreview } from '../preview-file'

import DelimitedPreview from './delimited-preview'
import { readPreviewText } from './source'

vi.mock('./source', () => ({ readPreviewText: vi.fn() }))
vi.mock('../preview-file', () => ({ LocalFilePreview: vi.fn(() => <div>original source editor</div>) }))

const target = {
  kind: 'file' as const,
  label: 'table.csv',
  path: '/fixture/table.csv',
  source: '/fixture/table.csv',
  url: 'file:///fixture/table.csv',
  previewKind: 'text' as const
}

const read = vi.mocked(readPreviewText)

describe('delimited preview', () => {
  beforeEach(() => {
    read.mockReset().mockResolvedValue({ path: target.path, text: '名称,备注\n张三,"第一行\n第二行"' })
    vi.mocked(LocalFilePreview).mockClear()
    $dirtyPreviewUrls.set({})
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })
  afterEach(() => {
    cleanup()
    $dirtyPreviewUrls.set({})
    vi.unstubAllGlobals()
  })

  it('renders Chinese headers, multiline cells and row numbers as text', async () => {
    render(<DelimitedPreview onFailure={vi.fn()} reloadKey={0} target={target} />)
    const table = await screen.findByRole('table', { name: 'table.csv' })
    expect(within(table).getByRole('columnheader', { name: '名称' })).toBeTruthy()
    expect(within(table).getAllByRole('cell').map(cell => cell.textContent)).toContain('第一行\n第二行')
    expect(within(table).getByRole('rowheader', { name: '1' })).toBeTruthy()
    expect(LocalFilePreview).not.toHaveBeenCalled()
  })

  it('hands source editing to the original component and refreshes after returning', async () => {
    const onClose = vi.fn()
    render(<DelimitedPreview onClose={onClose} onFailure={vi.fn()} reloadKey={0} target={target} />)
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: 'SOURCE' }))
    expect(screen.getByText('original source editor')).toBeTruthy()
    expect(vi.mocked(LocalFilePreview).mock.calls.at(-1)?.[0]).toEqual({
      onClose,
      onSelectRendered: undefined,
      reloadKey: 0,
      target
    })
    read.mockResolvedValue({ path: target.path, text: '名称,备注\n李四,已更新' })
    fireEvent.click(screen.getByRole('button', { name: 'Table' }))
    expect(await screen.findByRole('cell', { name: '已更新' })).toBeTruthy()
    expect(screen.queryByText('张三')).toBeNull()
  })

  it('does not unmount an editor with unsaved changes', async () => {
    render(<DelimitedPreview onFailure={vi.fn()} reloadKey={0} target={target} />)
    await screen.findByRole('table')
    fireEvent.click(screen.getByRole('button', { name: 'SOURCE' }))
    act(() => $dirtyPreviewUrls.set({ [target.url]: true }))
    const toggle = screen.getByRole('button', { name: 'Table' })
    expect(toggle.hasAttribute('disabled')).toBe(true)
    fireEvent.click(toggle)
    expect(screen.getByText('original source editor')).toBeTruthy()
  })

  it.each(['malformed', 'read failure'])('falls back to the original preview on %s', async mode => {
    if (mode === 'malformed') {
      read.mockResolvedValue({ path: target.path, text: 'name\n"unclosed' })
    } else {
      read.mockRejectedValue(new Error('read unavailable'))
    }

    render(<DelimitedPreview onFailure={vi.fn()} reloadKey={0} target={target} />)
    expect(await screen.findByText('original source editor')).toBeTruthy()
    expect(screen.queryByRole('table')).toBeNull()
  })

  it('reports both row limiting and a truncated source read', async () => {
    read.mockResolvedValue({
      path: target.path,
      text: ['head', ...Array.from({ length: 510 }, (_, row) => `record-${row}`), ''].join('\n'),
      truncated: true
    })
    render(<DelimitedPreview onFailure={vi.fn()} reloadKey={0} target={target} />)
    expect(await screen.findByText('Showing the first 500 data rows.')).toBeTruthy()
    expect(screen.getByText('Showing first 512 KB.')).toBeTruthy()
    expect(screen.queryByRole('cell', { name: 'record-500' })).toBeNull()
  })

  it('ignores a late read after leaving the preview', async () => {
    let resolveOld!: (value: Awaited<ReturnType<typeof readPreviewText>>) => void
    read.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveOld = resolve
        })
    )
    const view = render(<DelimitedPreview onFailure={vi.fn()} reloadKey={0} target={target} />)
    await waitFor(() => expect(read).toHaveBeenCalled())
    view.unmount()
    await act(async () => resolveOld({ path: target.path, text: 'late\nresult' }))
    expect(LocalFilePreview).not.toHaveBeenCalled()
  })
})
