import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $notifications, clearNotifications } from '@/store/notifications'

import { ShareControls } from './share-controls'

afterEach(() => {
  cleanup()
  clearNotifications()
  vi.unstubAllGlobals()
})

it('点击分享只打开弹窗，生成、更新和撤销分别确认，复制打开不会重复发布', async () => {
  let record: { key: string; shareId: string; url: string; hash: string; version: number } | null = null
  const inspect = vi.fn(async () => record)
  const publish = vi.fn(async (input: { key: string; html: string }) => {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.html))
    record = {
      key: input.key,
      shareId: 'id',
      url: 'https://share.example/id',
      version: (record?.version ?? 0) + 1,
      hash: Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
    }

    return record
  })
  const revoke = vi.fn(async () => {
    record = null
  })
  const writeClipboard = vi.fn().mockResolvedValue(undefined)
  const openExternal = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('hermesDesktop', {
    writeClipboard,
    openExternal,
    artifactShare: {
      inspect,
      publish,
      revoke,
      eligibility: async () => ({ publishable: true }),
      onChanged: () => () => {}
    }
  })
  const source = { sessionId: 's', content: '<h1>ready</h1>' }
  render(<ShareControls artifactKey="artifact:1" html={source.content} source={source} title="Report" />)
  const share = screen.getByRole('button', { name: 'Share artifact' })
  await waitFor(() => expect((share as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(share)
  let dialog = await screen.findByRole('dialog', { name: 'Share artifact' })
  const create = await within(dialog).findByRole('button', { name: 'Create public link' })
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false))
  expect(publish).not.toHaveBeenCalled()
  fireEvent.click(create)
  await within(dialog).findByRole('button', { name: 'Copy shared link' })
  expect(publish).toHaveBeenCalledWith({ key: 'artifact:1', html: source.content, title: 'Report', source, ttlDays: 1 })
  expect($notifications.get().some(item => item.title === 'Published successfully')).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Copy shared link' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(record!.url))
  await waitFor(() =>
    expect((within(dialog).getByRole('button', { name: 'View shared page' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(within(dialog).getByRole('button', { name: 'View shared page' }))
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith(record!.url))
  expect(publish).toHaveBeenCalledTimes(1)
  await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'Close' })).not.toBeNull())
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  record = { ...record!, hash: 'previous-version' }
  fireEvent.click(share)
  dialog = await screen.findByRole('dialog', { name: 'Share artifact' })
  await within(dialog).findByText('Replace the published content with this version? The link will stay the same.')
  expect(publish).toHaveBeenCalledTimes(1)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Update shared content' }))
  await within(dialog).findByRole('button', { name: 'Copy shared link' })
  expect(publish).toHaveBeenCalledTimes(2)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke shared link' }))
  expect(revoke).not.toHaveBeenCalled()
  await within(dialog).findByText('Revoke this public link? People with the link will no longer be able to open it.')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Revoke shared link' }))
  await within(dialog).findByRole('button', { name: 'Create public link' })
  expect(revoke).toHaveBeenCalledWith('artifact:1', 'id')
})

it('关闭正在准备的分享弹窗不发布，也不将迟到快照带入后续窗口', async () => {
  let resolve!: (value: string) => void
  /** 延迟读取分享内容，验证关闭后的生命周期边界。 */
  const html = () =>
    new Promise<string>(ready => {
      resolve = ready
    })
  const publish = vi.fn()
  vi.stubGlobal('hermesDesktop', {
    artifactShare: {
      inspect: async () => null,
      eligibility: async () => ({ publishable: true }),
      onChanged: () => () => {},
      publish
    }
  })
  const view = render(
    <ShareControls artifactKey="artifact:late" html={html} source={{ sessionId: 's', content: 'late' }} title="Late" />
  )
  const share = screen.getByRole('button', { name: 'Share artifact' })
  await waitFor(() => expect((share as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(share)
  await waitFor(() => expect(resolve).toBeTypeOf('function'))
  view.unmount()
  resolve('<p>late</p>')
  await new Promise(ready => setTimeout(ready, 20))
  expect(publish).not.toHaveBeenCalled()
  expect($notifications.get()).toHaveLength(0)
})
