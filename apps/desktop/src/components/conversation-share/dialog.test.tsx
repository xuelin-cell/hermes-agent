import type { ConversationShareRecord, PreparedConversationShare } from '@hermes/shared/conversation-share'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('@/store/conversation-share', () => {
  const target = atom<unknown>(null)

  return { $conversationShareTarget: target, closeConversationShare: () => target.set(null) }
})
vi.mock('./snapshot-renderer', () => ({
  exportConversationHtml: vi.fn(async () => '<!doctype html><html><head></head><body>完整预览</body></html>')
}))

import { $conversationShareTarget } from '@/store/conversation-share'

import { ConversationShareDialog } from './dialog'

const desktop = window as unknown as { hermesDesktop?: Window['hermesDesktop'] }
const original = desktop.hermesDesktop

const target = {
  owner: { connectionId: 'remote', profile: 'A' },
  request: { sessionId: 'session', scope: 'response' as const, responseRowId: 42 }
}

const prepared = {
  ticket: 'ticket-A',
  document: { snapshotId: 'snapshot', title: 'Reply' }
} as PreparedConversationShare

const published: ConversationShareRecord = {
  key: 'key',
  shareId: 'share-id',
  snapshotId: 'snapshot',
  scope: 'response',
  title: 'Reply',
  createdAt: '2026-10-16T00:00:00Z',
  state: 'published',
  url: 'https://share.example/page.html',
  owner: target.owner,
  sessionId: 'session'
}

afterEach(() => {
  cleanup()
  $conversationShareTarget.set(null)
  desktop.hermesDesktop = original
  vi.clearAllMocks()
})

it('准备接口失败时显示实际原因，不误报插件缺失且不能发布', async () => {
  const publish = vi.fn()
  desktop.hermesDesktop = {
    conversationShare: {
      prepare: vi.fn().mockRejectedValue(new Error('409: 无法定位该回复')),
      cancel: vi.fn(),
      publish,
      list: async () => [],
      revoke: vi.fn()
    }
  } as unknown as Window['hermesDesktop']
  $conversationShareTarget.set(target)
  render(<ConversationShareDialog />)
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('无法定位该回复'))
  expect(screen.queryByRole('status')).toBeNull()
  expect((screen.getByRole('button', { name: 'Create public link' }) as HTMLButtonElement).disabled).toBe(true)
  expect(publish).not.toHaveBeenCalled()
})

it('先准备预览再允许发布，窗口关闭后取消迟到票据且不会自动上传', async () => {
  let finish: ((value: PreparedConversationShare) => void) | undefined

  const prepare = vi.fn(
    () =>
      new Promise<PreparedConversationShare>(resolve => {
        finish = resolve
      })
  )

  const cancel = vi.fn(async () => undefined)
  const publish = vi.fn()
  desktop.hermesDesktop = {
    conversationShare: { prepare, cancel, publish, list: async () => [], revoke: vi.fn() }
  } as unknown as Window['hermesDesktop']
  $conversationShareTarget.set(target)
  render(<ConversationShareDialog />)
  expect((screen.getByRole('button', { name: 'Create public link' }) as HTMLButtonElement).disabled).toBe(true)
  expect(prepare).toHaveBeenCalledWith(
    target.owner,
    expect.objectContaining({ ...target.request, includeProcess: false })
  )
  fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0])
  await act(async () => {
    finish?.(prepared)
  })
  await waitFor(() => expect(cancel).toHaveBeenCalledWith(prepared.ticket))
  expect(publish).not.toHaveBeenCalled()
  expect(screen.queryByTitle('Public page preview')).toBeNull()
})

it('准备 IPC 一直未返回时能超时退出，迟到票据被取消且不会恢复发布', async () => {
  const deadline = new AbortController()
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal)
  let finish: ((value: PreparedConversationShare) => void) | undefined
  const cancel = vi.fn(async () => undefined)
  const publish = vi.fn()

  try {
    desktop.hermesDesktop = {
      conversationShare: {
        prepare: () =>
          new Promise<PreparedConversationShare>(resolve => {
            finish = resolve
          }),
        cancel,
        publish,
        list: async () => [],
        revoke: vi.fn()
      }
    } as unknown as Window['hermesDesktop']
    $conversationShareTarget.set(target)
    render(<ConversationShareDialog />)
    expect(screen.getByRole('status')).toBeTruthy()
    await act(async () => deadline.abort(new DOMException('Preparation timed out', 'TimeoutError')))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Preparation timed out'))
    expect(screen.queryByRole('status')).toBeNull()
    await act(async () => finish?.(prepared))
    await waitFor(() => expect(cancel).toHaveBeenCalledWith(prepared.ticket))
    expect(screen.queryByTitle('Public page preview')).toBeNull()
    expect((screen.getByRole('button', { name: 'Create public link' }) as HTMLButtonElement).disabled).toBe(true)
    expect(publish).not.toHaveBeenCalled()
  } finally {
    timeout.mockRestore()
  }
})

it.each(['session', 'response'] as const)('%s 分享确认后进入链接结果，失败可重试且撤销需确认', async scope => {
  const selected = { ...target, request: { ...target.request, scope } }
  const result = { ...published, scope }
  const writeClipboard = vi.fn(async () => undefined)
  const openExternal = vi.fn(async () => undefined)

  let records: ConversationShareRecord[] = [
    { ...published, key: 'other-scope', scope: scope === 'session' ? 'response' : 'session' }
  ]

  const publish = vi
    .fn()
    .mockRejectedValueOnce(new Error('Upload failed'))
    .mockImplementation(async () => {
      records = [result, ...records.filter(item => item.key !== result.key)]

      return result
    })

  const revoke = vi
    .fn()
    .mockRejectedValueOnce(new Error('Delete failed'))
    .mockImplementation(async () => {
      records = records.map(item => (item.key === result.key ? { ...item, state: 'revoked' } : item))
    })

  desktop.hermesDesktop = {
    writeClipboard,
    openExternal,
    conversationShare: {
      prepare: async () => prepared,
      cancel: async () => undefined,
      publish,
      revoke,
      list: async () => records
    }
  } as unknown as Window['hermesDesktop']
  $conversationShareTarget.set(selected)
  render(<ConversationShareDialog />)
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Create public link' }) as HTMLButtonElement).disabled).toBe(false)
  )
  expect(publish).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Create public link' }))
  await screen.findByText('Upload failed')
  fireEvent.click(screen.getByRole('button', { name: 'Create public link' }))
  await screen.findByRole('button', { name: 'Copy share link' })
  expect(screen.getByRole('button', { name: 'Open share link' })).toBeTruthy()
  expect(publish).toHaveBeenCalledWith(prepared.ticket, expect.stringContaining('完整预览'))
  expect(screen.queryByTitle('Public page preview')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Copy share link' }))
  await waitFor(() => expect(writeClipboard).toHaveBeenCalledWith(result.url))
  fireEvent.click(screen.getByRole('button', { name: 'Open share link' }))
  await waitFor(() => expect(openExternal).toHaveBeenCalledWith(result.url))
  expect(publish).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Revoke share' }))
  expect(revoke).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Revoke share' }))
  await screen.findByText('Delete failed')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.getByRole('button', { name: 'Copy share link' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Revoke share' }))
  fireEvent.click(screen.getByRole('button', { name: 'Revoke share' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Copy share link' })).toBeNull())
})
