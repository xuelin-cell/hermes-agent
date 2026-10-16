import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { ShareControls } from './share-controls'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('仅在用户点击时发布，并在工具改变链接后刷新状态', async () => {
  let changed: ((key: string) => void) | undefined
  const inspect = vi.fn().mockResolvedValue(null)
  const publish = vi.fn().mockResolvedValue({ key: 'artifact:1', shareId: 'id', url: 'https://share.example/id', version: 1 })
  const revoke = vi.fn().mockResolvedValue(undefined)
  const eligibility = vi.fn().mockResolvedValue({ publishable: true })
  const writeClipboard = vi.fn().mockResolvedValue(undefined)
  const openExternal = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('hermesDesktop', {
    writeClipboard,
    openExternal,
    artifactShare: {
      inspect,
      publish,
      revoke,
      eligibility,
      onChanged: (listener: (key: string) => void) => {
        changed = listener

        return () => { changed = undefined }
      }
    }
  })

  const source = { sessionId: 's', content: '<h1>ready</h1>' }
  render(<ShareControls artifactKey="artifact:1" html="<h1>ready</h1>" source={source} title="Report" />)
  expect(publish).not.toHaveBeenCalled()
  await waitFor(() => expect((screen.getByRole('button', { name: 'Share artifact' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Share artifact' }))
  await waitFor(() => expect(publish).toHaveBeenCalledWith({ key: 'artifact:1', html: '<h1>ready</h1>', title: 'Report', source }))
  const url = 'https://share.example/id'
  await waitFor(() => expect(screen.getByRole('link', { name: 'View shared page' }).getAttribute('href')).toBe(url))
  const update = screen.getByRole('button', { name: 'Update shared content' })
  expect(update.textContent).toBe('')
  expect(screen.getByRole('button', { name: 'Revoke shared link' }).textContent).toBe('')
  expect(screen.getByRole('button', { name: 'Copy shared link' }).textContent).toBe('')
  expect(screen.getByRole('link', { name: 'View shared page' }).textContent).toBe('')
  fireEvent.pointerMove(update.parentElement!, { pointerType: 'mouse' })
  expect((await screen.findByRole('tooltip')).textContent).toContain('Update shared content')
  fireEvent.pointerLeave(update.parentElement!)

  fireEvent.click(screen.getByRole('button', { name: 'Copy shared link' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(url))
  expect(openExternal).not.toHaveBeenCalled()
  expect(publish).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('link', { name: 'View shared page' }))
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith(url))
  expect(publish).toHaveBeenCalledTimes(1)

  fireEvent.click(update)
  await waitFor(() => expect(publish).toHaveBeenCalledTimes(2))
  expect(publish.mock.calls[1][0].key).toBe('artifact:1')
  await waitFor(() => expect(screen.getByRole('link', { name: 'View shared page' }).getAttribute('href')).toBe(url))

  inspect.mockResolvedValue(null)
  changed?.('artifact:1')
  await waitFor(() => expect(screen.queryByRole('link', { name: 'View shared page' })).toBeNull())
  eligibility.mockResolvedValue({ publishable: false, reason: 'user_upload' })
  changed?.('*')
  await waitFor(() => expect((screen.getByRole('button', { name: 'Share artifact' }) as HTMLButtonElement).disabled).toBe(true))
})
