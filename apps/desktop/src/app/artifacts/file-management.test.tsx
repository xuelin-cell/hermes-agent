import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $notifications, clearNotifications } from '@/store/notifications'

import type { CloudDriveMutationProgress, CloudDriveRequest } from '../../../electron/login/contract'

import { CloudDirectoryEmpty } from './cloud-directory-empty'
import { CloudLibrary } from './cloud-library'
import { CloudRecycleBin } from './cloud-recycle-bin'

afterEach(() => {
  cleanup()
  clearNotifications()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const capabilities = { create_folder: true, rename: true, trash: true, download: true, move: true }

it('空回收站和空文件夹使用相同的空状态排版，不再显示列表顶部的普通段落', async () => {
  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: vi.fn().mockResolvedValue([]) })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudDirectoryEmpty
        parent="root"
        query=""
        snapshot={{ items: [], scanning: false, complete: true, error: false, loadedDirectories: ['root'] }}
      />
      <CloudRecycleBin onBack={() => {}} onChanged={() => {}} />
    </I18nProvider>
  )
  const folder = screen.getByText('文件夹为空')
  const recycle = await screen.findByText('回收站为空')
  expect(recycle.className).toBe(folder.className)
  expect(recycle.parentElement?.className).toBe(folder.parentElement?.className)
  expect(recycle.parentElement?.parentElement?.className).toBe(folder.parentElement?.parentElement?.className)
})

/** 构造资料库原生桌面请求，保留云盘文件和目录的真实身份字段。 */
function listing(route: string) {
  if (route === '/asset-spaces') {
    return { items: [{ kind: 'personal', space_id: 'personal', root_asset_id: 'root' }] }
  }

  if (route === '/drive/capabilities') {
    return capabilities
  }

  const params = new URLSearchParams(route.split('?')[1])

  return {
    items:
      params.get('parent_asset_id') === 'root' && params.get('page_no') === '1'
        ? [
            { asset_id: 'file-id', name: '报告.pdf', kind: 'file' },
            { asset_id: 'folder-id', name: '归档目录', kind: 'directory' }
          ]
        : []
  }
}

it('文件移动发送原始 ID 和目标目录，部分成功时保留弹窗并只允许读取刷新', async () => {
  const drive = vi.fn(async ({ route }: { route: string }) =>
    route === '/assets/move'
      ? { protocol: 'uniwork.drive-result.v1', ok: false, status: 'partial_success', code: 'PARTIAL_SUCCESS' }
      : listing(route)
  )

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: drive })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )
  const move = await screen.findByRole('button', { name: '移动' })
  await waitFor(() => expect((move as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(move)
  const dialog = screen.getByRole('dialog', { name: '移动到文件夹' })
  expect((within(dialog).getByRole('button', { name: '确认' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(within(dialog).getByRole('button', { name: '归档目录' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
  expect(await within(dialog).findByRole('status')).toHaveProperty('textContent', expect.stringContaining('仅部分完成'))
  const writes = drive.mock.calls.filter(([input]) => input.route === '/assets/move')
  expect(writes).toHaveLength(1)
  expect(writes[0][0]).toMatchObject({
    body: { file_ids: ['file-id'], directory_ids: [], target_parent_asset_id: 'folder-id' }
  })
  expect(within(dialog).queryByRole('button', { name: '确认' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(drive.mock.calls.filter(([input]) => input.route === '/assets/move')).toHaveLength(1)
})

it('回收站先确认再恢复，使用删除编号并刷新列表，损坏响应不能显示为空回收站', async () => {
  let restored = false
  let invalid = false

  const drive = vi.fn(async ({ route, body }: { route: string; body?: { pageNo?: number } }) => {
    if (route === '/unicom/QueryRecycleData') {
      return invalid
        ? {}
        : restored || body?.pageNo !== 1
          ? []
          : [{ deleteNo: 'deletion-id', fid: 'file-id', name: '报告.pdf', type: '1', deleteTime: '20260823162117' }]
    }

    if (route === '/unicom/ReductionRecycleData') {
      restored = true

      return {}
    }

    return listing(route)
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: drive })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )
  await screen.findByRole('button', { name: '报告.pdf' })
  fireEvent.click(screen.getByRole('button', { name: '回收站' }))
  const row = await screen.findByRole('group', { name: '报告.pdf' })
  expect(screen.queryByRole('button', { name: '显示更多' })).toBeNull()
  expect(screen.queryByRole('textbox', { name: '搜索文件和文件夹' })).toBeNull()
  expect(screen.queryByRole('button', { name: '上传文件' })).toBeNull()
  expect(screen.queryByRole('button', { name: '新建文件夹' })).toBeNull()
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '清空回收站' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(within(row).getByRole('button', { name: '恢复' }))
  const dialog = screen.getByRole('dialog', { name: '恢复' })
  expect(drive.mock.calls.filter(([input]) => input.route.endsWith('ReductionRecycleData'))).toHaveLength(0)
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  expect(drive.mock.calls.filter(([input]) => input.route.endsWith('ReductionRecycleData'))).toHaveLength(0)
  fireEvent.click(within(row).getByRole('button', { name: '恢复' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: '恢复' })).getByRole('button', { name: '恢复' }))
  expect(await screen.findByText('回收站为空')).toBeTruthy()
  expect(drive.mock.calls.find(([input]) => input.route.endsWith('ReductionRecycleData'))![0]).toMatchObject({
    body: { deleteNos: ['deletion-id'] }
  })
  expect(screen.queryByRole('button', { name: '彻底删除' })).toBeNull()
  await waitFor(() => expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false))
  invalid = true
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('未能完整加载'))
  expect(screen.queryByText('回收站为空')).toBeNull()
})

it('回收站仅在当前页满额时显示更多，下一页不足额后隐藏入口并保留已加载记录', async () => {
  const pages = vi.fn(async ({ route, body }: { route: string; body?: { pageNo?: number; pageSize?: number } }) => {
    if (route !== '/unicom/QueryRecycleData') {
      return listing(route)
    }

    const count = body?.pageNo === 1 ? body.pageSize! : 1

    return Array.from({ length: count }, (_, index) => ({
      deleteNo: `${body?.pageNo}-${index}`,
      name: `旧文件-${body?.pageNo}-${index}.txt`,
      type: '1'
    }))
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: pages })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )
  await screen.findByRole('button', { name: '报告.pdf' })
  fireEvent.click(screen.getByRole('button', { name: '回收站' }))
  fireEvent.click(await screen.findByRole('button', { name: '显示更多' }))
  expect(await screen.findByRole('group', { name: '旧文件-2-0.txt' })).toBeTruthy()
  expect(screen.getByRole('group', { name: '旧文件-1-0.txt' })).toBeTruthy()
  await waitFor(() => expect(screen.queryByRole('button', { name: '显示更多' })).toBeNull())
  expect(pages.mock.calls.filter(([input]) => input.route === '/unicom/QueryRecycleData')).toHaveLength(2)
})

it('彻底删除使用删除操作号，取消不写入；清空需明确确认，未知结果只能刷新不重发', async () => {
  let deleted = false

  const request = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/unicom/QueryRecycleData') {
      return deleted ? [] : [{ deleteNo: 'deletion-number', fid: 'wrong-file-id', name: '不可恢复资料.pdf', type: '1' }]
    }

    if (route === '/unicom/DeleteRecycleData') {
      deleted = true

      return { verified: true }
    }

    if (route === '/unicom/EmptyRecycleData') {
      return { protocol: 'uniwork.drive-result.v1', ok: false, status: 'outcome_unknown', code: 'OUTCOME_UNKNOWN' }
    }

    return listing(route)
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: request })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )
  await screen.findByRole('button', { name: '报告.pdf' })
  fireEvent.click(screen.getByRole('button', { name: '回收站' }))
  const row = await screen.findByRole('group', { name: '不可恢复资料.pdf' })
  fireEvent.click(within(row).getByRole('button', { name: '彻底删除' }))
  let dialog = screen.getByRole('dialog', { name: '彻底删除' })
  expect(within(dialog).getByText(/删除后无法恢复/)).toBeTruthy()
  expect(request.mock.calls.some(([input]) => input.route === '/unicom/DeleteRecycleData')).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: '取消' }))
  fireEvent.click(within(row).getByRole('button', { name: '彻底删除' }))
  dialog = screen.getByRole('dialog', { name: '彻底删除' })
  fireEvent.click(within(dialog).getByRole('button', { name: '彻底删除' }))
  expect(await screen.findByText('回收站为空')).toBeTruthy()
  expect(request.mock.calls.find(([input]) => input.route === '/unicom/DeleteRecycleData')![0]).toMatchObject({
    body: { deleteNos: ['deletion-number'] }
  })
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '清空回收站' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: '清空回收站' }))
  dialog = screen.getByRole('dialog', { name: '清空回收站' })
  expect(within(dialog).getByText(/个人云盘回收站.*无法撤销/)).toBeTruthy()
  expect(request.mock.calls.some(([input]) => input.route === '/unicom/EmptyRecycleData')).toBe(false)
  fireEvent.click(within(dialog).getByRole('button', { name: '清空回收站' }))
  expect(await within(dialog).findByRole('status')).toHaveProperty(
    'textContent',
    expect.stringContaining('确认操作结果')
  )
  expect(within(dialog).queryByRole('button', { name: '清空回收站' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(request.mock.calls.filter(([input]) => input.route === '/unicom/EmptyRecycleData')).toHaveLength(1)
  expect(request.mock.calls.find(([input]) => input.route === '/unicom/EmptyRecycleData')![0]).toMatchObject({
    body: {}
  })
})

it('只在本请求启动核验时显示中性提示，完成后撤下确认中，无法确认仍能刷新且不重发', async () => {
  const listeners = new Set<(progress: CloudDriveMutationProgress) => void>()
  let complete!: (result: unknown) => void

  const request = vi.fn((input: CloudDriveRequest) => {
    if (input.route === '/assets/move') {
      for (const listener of listeners) {
        listener({ id: 'unrelated-request', phase: 'verifying' })
      }

      expect($notifications.get()).toHaveLength(0)

      for (const listener of listeners) {
        listener({ id: input.requestId!, phase: 'verifying' })
      }

      return new Promise(resolve => {
        complete = resolve
      })
    }

    return Promise.resolve(listing(input.route))
  })

  vi.stubGlobal('hermesDesktop', {
    cloudDriveRequest: request,
    onCloudDriveMutationProgress: (listener: (progress: CloudDriveMutationProgress) => void) => {
      listeners.add(listener)

      return () => listeners.delete(listener)
    }
  })
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary />
    </I18nProvider>
  )
  const move = await screen.findByRole('button', { name: '移动' })
  await waitFor(() => expect((move as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(move)
  const dialog = screen.getByRole('dialog', { name: '移动到文件夹' })
  fireEvent.click(within(dialog).getByRole('button', { name: '归档目录' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
  await waitFor(() =>
    expect($notifications.get().find(item => item.message.includes('正在确认操作结果'))?.kind).toBe('info')
  )
  complete({
    protocol: 'uniwork.drive-result.v1',
    ok: false,
    status: 'outcome_unknown',
    code: 'OPERATION_CONFIRMATION_UNAVAILABLE'
  })
  expect(await within(dialog).findByRole('status')).toHaveProperty(
    'textContent',
    '暂时无法自动确认操作结果，请刷新文件列表核对。'
  )
  expect($notifications.get()).toHaveLength(0)
  expect(listeners.size).toBe(0)
  expect(request.mock.calls.filter(([input]) => input.route === '/assets/move')).toHaveLength(1)
  expect(within(dialog).queryByRole('button', { name: '确认' })).toBeNull()
  expect(within(dialog).getByRole('button', { name: '刷新' })).toBeTruthy()
})
