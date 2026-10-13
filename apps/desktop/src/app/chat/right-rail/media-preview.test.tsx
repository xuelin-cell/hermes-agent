import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { browserShellCopy } from '@/lib/browser-shell'
import type { PreviewTarget } from '@/store/preview'

// The player reaches the bridge through lib/browser-shell.ts, which imports it only in the browser build.
const bridge = vi.hoisted(() => ({
  mediaPlaybackUrl: vi.fn((path: string) => `/__hermes_backend/api/fs/download?path=${encodeURIComponent(path)}`)
}))

vi.mock('@/dev/browser-bridge', () => bridge)

import { MediaPreview } from './media-preview'

function fileTarget(path: string): PreviewTarget {
  const label = path.split('/').pop() || path

  return { kind: 'file', label, path, previewKind: 'text', source: path, url: `file://${path}` }
}

const copy = browserShellCopy()
const video = fileTarget('/opt/data/workspace/小狗视频.mp4')
const audio = fileTarget('/opt/data/workspace/播客.mp3')

beforeEach(() => {
  window.document.documentElement.dataset.hermesBrowser = 'production'
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  delete window.document.documentElement.dataset.hermesBrowser
})

describe('media player in the preview pane', () => {
  it('plays a video from the instance', async () => {
    render(<MediaPreview reloadKey={0} target={video} />)

    const player = await screen.findByLabelText('小狗视频.mp4')

    expect(player.tagName).toBe('VIDEO')
    expect(player.getAttribute('src')).toBe(
      `/__hermes_backend/api/fs/download?path=${encodeURIComponent('/opt/data/workspace/小狗视频.mp4')}`
    )
    expect(player.hasAttribute('controls')).toBe(true)
  })

  it('plays audio with the file name above the controls', async () => {
    render(<MediaPreview reloadKey={0} target={audio} />)

    const player = await screen.findByLabelText('播客.mp3')

    expect(player.tagName).toBe('AUDIO')
    expect(screen.getByText('播客.mp3')).toBeTruthy()
  })

  it('says so when the browser cannot play the file', async () => {
    render(<MediaPreview reloadKey={0} target={fileTarget('/opt/data/workspace/old.avi')} />)

    fireEvent.error(await screen.findByLabelText('old.avi'))

    expect(await screen.findByText(copy.media.failed)).toBeTruthy()
    expect(screen.queryByLabelText('old.avi')).toBeNull()
  })

  it('lets go of a dropped file’s memory, and asks again when the pane reloads', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)

    bridge.mediaPlaybackUrl.mockReturnValueOnce('blob:dropped')

    const { rerender, unmount } = render(<MediaPreview reloadKey={0} target={video} />)

    await waitFor(() => expect(screen.getByLabelText('小狗视频.mp4').getAttribute('src')).toBe('blob:dropped'))
    rerender(<MediaPreview reloadKey={1} target={video} />)

    await waitFor(() => expect(screen.getByLabelText('小狗视频.mp4').getAttribute('src')).toMatch(/api\/fs\/download/))
    expect(revoke).toHaveBeenCalledWith('blob:dropped')
    expect(bridge.mediaPlaybackUrl).toHaveBeenCalledTimes(2)

    unmount()
    revoke.mockRestore()
  })
})
