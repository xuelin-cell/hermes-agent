import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { lazy, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resolveMediaPlaybackSrc } from '@/lib/media'
import type { PreviewTarget } from '@/store/preview'
import { $connection } from '@/store/session'

import { LocalFilePreview } from '../preview-file'

import { previewFailure, type PreviewFailureCode } from './failure'
import { FormatPreview } from './format-preview'
import { previewFormat } from './kinds'
import { FORMAT_RENDERERS, type FormatRendererProps } from './registry'

vi.mock('@/lib/media', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveMediaPlaybackSrc: vi.fn()
}))
vi.mock('../preview-file', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  LocalFilePreview: vi.fn(() => <div>original preview</div>)
}))

const originalRenderers = { ...FORMAT_RENDERERS }
const resolvePlayback = vi.mocked(resolveMediaPlaybackSrc)
const originalBridge = window.hermesDesktop

/** 构造与文件树相同的文件目标，不依赖新增预览类型字段。 */
function fileTarget(path = '/fixture/sample.mp3'): PreviewTarget {
  return {
    kind: 'file',
    label: path.split('/').at(-1)!,
    path,
    previewKind: 'binary',
    source: path,
    url: `file://${path}`
  }
}

/** 用真实 React 生命周期报告失败，验证登记顺序和停止条件。 */
function failingRenderer(code: PreviewFailureCode) {
  return lazy(async () => ({
    /** 测试显示器在挂载后经过正式失败回调请求降级。 */
    default: function Failure({ onFailure }: FormatRendererProps) {
      useEffect(() => onFailure({ code }), [onFailure])

      return null
    }
  }))
}

describe('format preview', () => {
  beforeEach(() => {
    Object.assign(FORMAT_RENDERERS, originalRenderers)
    resolvePlayback.mockReset().mockImplementation(async path => `hermes-media://stream/${encodeURIComponent(path)}`)
    vi.mocked(LocalFilePreview).mockClear()
    $connection.set(null)
    window.hermesDesktop = { revealPath: vi.fn(async () => true) } as never
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(Date.now()), 0)
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => window.clearTimeout(id))
  })

  afterEach(() => {
    cleanup()
    Object.assign(FORMAT_RENDERERS, originalRenderers)
    $connection.set(null)
    window.hermesDesktop = originalBridge
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('gives every registered format a renderer and leaves existing formats alone', () => {
    for (const path of ['/fixture/sound.MP3', '/fixture/clip.mp4']) {
      const kind = previewFormat(fileTarget(path))!
      expect(FORMAT_RENDERERS[kind].length).toBeGreaterThan(0)
    }

    for (const path of [
      '/fixture/text.txt',
      '/fixture/notes.md',
      '/fixture/page.html',
      '/fixture/photo.png',
      '/fixture/doc.pdf',
      '/fixture/book.xlsx'
    ]) {
      expect(previewFormat(fileTarget(path))).toBeNull()
    }

    expect(previewFormat({ ...fileTarget(), kind: 'url' })).toBeNull()
    expect(previewFormat({ ...fileTarget(), kind: 'artifact' })).toBeNull()
  })

  it('forwards all legacy props without changing the target or callbacks', () => {
    const props = {
      onClose: vi.fn(),
      onSelectRendered: vi.fn(),
      reloadKey: 7,
      target: fileTarget('/fixture/page.html')
    }

    render(<FormatPreview {...props} />)
    expect(screen.getByText('original preview')).toBeTruthy()
    expect(vi.mocked(LocalFilePreview).mock.calls[0][0]).toEqual(props)
    expect(resolvePlayback).not.toHaveBeenCalled()
  })

  it.each([
    ['audio', '/fixture/sample.mp3'],
    ['video', '/fixture/sample.mp4']
  ] as const)('uses the seekable source and native controls for %s without autoplay', async (kind, path) => {
    const target = fileTarget(path)
    const { container } = render(<FormatPreview reloadKey={0} target={target} />)
    await waitFor(() =>
      expect(container.querySelector(kind)?.getAttribute('src')).toBe(
        `hermes-media://stream/${encodeURIComponent(path)}`
      )
    )
    const player = container.querySelector(kind)!
    expect(player.hasAttribute('controls')).toBe(true)
    expect(player.hasAttribute('autoplay')).toBe(false)
    expect(player.getAttribute('aria-label')).toBe(target.label)
  })

  it('provides the original file and close actions after playback fails', async () => {
    const onClose = vi.fn()
    const target = fileTarget()
    const { container } = render(<FormatPreview onClose={onClose} reloadKey={0} target={target} />)
    await waitFor(() => expect(container.querySelector('audio')).toBeTruthy())
    fireEvent.error(container.querySelector('audio')!)
    fireEvent.click(await screen.findByRole('button', { name: 'Open containing folder' }))
    expect(window.hermesDesktop?.revealPath).toHaveBeenCalledWith(target.path)
    fireEvent.click(screen.getByRole('button', { name: 'Close preview pane' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('downloads from the remote connection and profile that owns the file', async () => {
    const saveGatewayFile = vi.fn(async () => ({ canceled: true, saved: false }))
    window.hermesDesktop = { saveGatewayFile } as never
    $connection.set({ connectionId: 'remote-fixture', mode: 'remote', profile: 'team' } as never)
    resolvePlayback.mockRejectedValue(new Error('private transport details'))
    render(<FormatPreview reloadKey={0} target={fileTarget()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }))
    expect(saveGatewayFile).toHaveBeenCalledWith({
      connectionId: 'remote-fixture',
      path: '/fixture/sample.mp3',
      profile: 'team',
      suggestedName: 'sample.mp3'
    })
    expect(screen.queryByText('private transport details')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open containing folder' })).toBeNull()
  })

  it('tries the next renderer after a failure and gives an exit when all fail', async () => {
    const second = vi.fn(() => <div>second renderer</div>)
    FORMAT_RENDERERS.audio = [failingRenderer('unsupported'), lazy(async () => ({ default: second }))]
    const view = render(<FormatPreview reloadKey={0} target={fileTarget()} />)
    expect(await screen.findByText('second renderer')).toBeTruthy()
    FORMAT_RENDERERS.audio = [failingRenderer('unsupported'), failingRenderer('unavailable')]
    view.rerender(<FormatPreview reloadKey={1} target={fileTarget()} />)
    expect(await screen.findByRole('button', { name: 'Open containing folder' })).toBeTruthy()
    expect(screen.getByText('Could not preview this file. You can still access the original file.')).toBeTruthy()
  })

  it('does not try more renderers once the file is known to be missing', async () => {
    const second = vi.fn(() => <div>should not mount</div>)
    FORMAT_RENDERERS.audio = [failingRenderer('not_found'), lazy(async () => ({ default: second }))]
    render(<FormatPreview reloadKey={0} target={fileTarget()} />)
    expect(await screen.findByText('This file is no longer available.')).toBeTruthy()
    expect(second).not.toHaveBeenCalled()
  })

  it('contains a renderer exception and continues the same fallback sequence', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    FORMAT_RENDERERS.audio = [
      lazy(async () => ({
        default: () => {
          throw new Error('renderer failed')
        }
      })),
      originalRenderers.audio[0]
    ]
    const { container } = render(<FormatPreview reloadKey={0} target={fileTarget()} />)
    await waitFor(() => expect(container.querySelector('audio')).toBeTruthy())
    expect(screen.queryByText('renderer failed')).toBeNull()
  })

  it('ignores a late source result after switching files and retries on reload', async () => {
    let rejectOld!: (error: Error) => void
    resolvePlayback.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectOld = reject
        })
    )
    const view = render(<FormatPreview reloadKey={0} target={fileTarget()} />)
    await waitFor(() => expect(resolvePlayback).toHaveBeenCalled())
    view.rerender(<FormatPreview reloadKey={0} target={fileTarget('/fixture/new.mp4')} />)
    await waitFor(() => expect(view.container.querySelector('video')).toBeTruthy())
    await act(async () => rejectOld(new Error('late result')))
    expect(view.container.querySelector('video')).toBeTruthy()
    fireEvent.error(view.container.querySelector('video')!)
    await screen.findByRole('button', { name: 'Open containing folder' })
    view.rerender(<FormatPreview reloadKey={1} target={fileTarget('/fixture/new.mp4')} />)
    await waitFor(() => expect(view.container.querySelector('video')).toBeTruthy())
  })

  it('reloads the source when the owning connection changes', async () => {
    const { container } = render(<FormatPreview reloadKey={0} target={fileTarget()} />)
    await waitFor(() => expect(container.querySelector('audio')).toBeTruthy())
    resolvePlayback.mockResolvedValue('hermes-media://remote/new-owner')
    act(() => $connection.set({ connectionId: 'new-owner', mode: 'remote' } as never))
    await waitFor(() =>
      expect(container.querySelector('audio')?.getAttribute('src')).toBe('hermes-media://remote/new-owner')
    )
  })

  it('keeps known failure codes and hides unstructured errors', () => {
    expect(previewFailure({ code: 'not_found' })).toEqual({ code: 'not_found' })
    expect(previewFailure(new Error('internal path'))).toEqual({ code: 'unavailable' })
    expect(previewFailure({ code: 'unknown', detail: 'secret' })).toEqual({ code: 'unavailable' })
  })
})
