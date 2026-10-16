import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { I18nProvider } from '@/i18n'
import { clearSessionDraft, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $newChatProfile, $newChatRoute } from '@/store/profile'
import { $connection, $selectedStoredSessionId } from '@/store/session'

const { confirm } = vi.hoisted(() => ({ confirm: vi.fn().mockResolvedValue(true) }))
vi.mock('@/store/confirm', () => ({ confirm }))

import { CloudLibrary } from './cloud-library'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  clearSessionDraft(null)
  $connection.set(null)
})

/** 真实筛选、选择和批量动作，只替换原生桥的服务返回及确认弹窗。 */
function setup(restricted = false) {
  let usageFailed = false
  let writeUnknown = false

  const request = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'space', root_asset_id: 'root' }] }
    }

    if (route === '/drive/capabilities') {
      return { upload: true, download: true, create_folder: true, rename: true, trash: true, move: true }
    }

    if (route.endsWith('/usage')) {
      if (usageFailed) {
        throw new Error('Usage temporarily unavailable')
      }

      return { used_bytes: 358.8 * 1024 ** 2, total_bytes: 2048 * 1024 ** 3 }
    }

    if (route === '/assets/move' || route === '/assets/trash') {
      return writeUnknown
        ? { protocol: 'uniwork.drive-result.v1', ok: false, status: 'outcome_unknown', code: 'TRANSPORT_ERROR' }
        : {}
    }

    const params = new URLSearchParams(route.split('?')[1])

    return {
      items:
        params.get('page_no') === '1' && params.get('parent_asset_id') === 'root'
          ? [
              { asset_id: 'one', kind: 'file', name: '报告一.txt', size_bytes: 5 },
              {
                asset_id: 'two',
                kind: 'file',
                name: '报告二.pdf',
                size_bytes: 6,
                permissions: restricted ? { read: false, write: false, delete: false } : undefined
              },
              { asset_id: 'folder', kind: 'directory', name: '归档目录' }
            ]
          : []
    }
  })

  const transfer = vi.fn().mockResolvedValue({ status: 'succeeded', name: '报告一.txt' })

  const api = vi.fn(async ({ path }: { path: string }) =>
    path.endsWith('/test')
      ? { ok: true, tools: [{ name: 'download' }] }
      : { servers: [{ name: 'UniWork-Drive', enabled: true }] }
  )

  vi.stubGlobal('hermesDesktop', {
    cloudDriveRequest: request,
    cloudDriveTransfer: transfer,
    api,
    cloudDriveAgentReady: vi.fn().mockResolvedValue(true),
    onCloudDriveProgress: vi.fn(() => () => {}),
    cancelCloudDriveTransfer: vi.fn()
  })
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $selectedStoredSessionId.set(null)
  $newChatProfile.set(null)
  $newChatRoute.set(null)
  $apiRequestScope.set({ connectionId: null, profile: 'default' })
  const ready = vi.fn()

  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary onDraftReady={ready} />
    </I18nProvider>
  )

  return {
    request,
    transfer,
    api,
    ready,
    view,
    failUsage: () => {
      usageFailed = true
    },
    unknownWrite: () => {
      writeUnknown = true
    }
  }
}

/** 多选文件限定在已展示的文件筛选结果中，不把文件夹带入下载或添加动作。 */
async function chooseFiles() {
  await screen.findByRole('checkbox', { name: '选择 报告一.txt' })
  await waitFor(() => expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: '文件' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '选择已显示的全部项目' }))
  await waitFor(() => expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(false))

  return screen.getByRole('group', { name: '多选操作' })
}

it('类型筛选和全选只作用于当前显示范围，混合选择隐藏文件专属动作，导航后清空选择', async () => {
  const data = setup()
  await screen.findByText('已用 358.8 MB / 总量 2048.0 GB')
  const menu = await chooseFiles()
  expect(within(menu).getByText('已选 2 项')).toBeTruthy()
  fireEvent.click(within(menu).getByRole('button', { name: '下载' }))
  await waitFor(() => expect(data.transfer).toHaveBeenCalledTimes(1))
  expect(data.transfer.mock.calls[0][0]).toMatchObject({
    operation: 'download-many',
    assets: [
      { assetId: 'one', name: '报告一.txt', size: 5 },
      { assetId: 'two', name: '报告二.pdf', size: 6 }
    ]
  })
  expect(await screen.findAllByText('已保存到本机')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: '全部' }))
  expect(screen.queryByRole('group', { name: '多选操作' })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: '选择已显示的全部项目' }))
  const mixed = screen.getByRole('group', { name: '多选操作' })
  expect(within(mixed).getByText('已选 3 项')).toBeTruthy()
  expect(within(mixed).queryByRole('button', { name: '下载' })).toBeNull()
  expect(within(mixed).queryByRole('button', { name: '移动' })).toBeNull()
  expect(within(mixed).queryByRole('button', { name: '添加到会话' })).toBeNull()
  expect(within(mixed).getByRole('button', { name: '删除' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '归档目录' }))
  expect(await screen.findByText('文件夹为空')).toBeTruthy()
  expect(screen.queryByText('上传文件，开始整理。')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: '个人云盘' }))
  expect(screen.queryByRole('group', { name: '多选操作' })).toBeNull()
})

it('批量移动一次发送全部文件 ID；混合删除确认数量和文件夹影响范围，未知结果不重发', async () => {
  const data = setup()
  const menu = await chooseFiles()
  fireEvent.click(within(menu).getByRole('button', { name: '移动' }))
  const dialog = screen.getByRole('dialog', { name: '移动到文件夹' })
  fireEvent.click(within(dialog).getByRole('button', { name: '归档目录' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '确认' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(data.request.mock.calls.find(([input]) => input.route === '/assets/move')![0]).toMatchObject({
    body: {
      file_ids: ['one', 'two'],
      directory_ids: [],
      target_parent_asset_id: 'folder'
    }
  })
  fireEvent.click(screen.getByRole('button', { name: '全部' }))
  fireEvent.click(screen.getByRole('checkbox', { name: '选择已显示的全部项目' }))
  data.unknownWrite()
  fireEvent.click(within(screen.getByRole('group', { name: '多选操作' })).getByRole('button', { name: '删除' }))
  await waitFor(() => expect(data.request.mock.calls.some(([input]) => input.route === '/assets/trash')).toBe(true))
  expect(confirm.mock.calls[0][0]).toMatchObject({ title: '删除所选文件和文件夹', destructive: true })
  expect(confirm.mock.calls[0][0].description).toContain('3 项资料')
  expect(confirm.mock.calls[0][0].description).toContain('所有子文件夹')
  expect(data.request.mock.calls.filter(([input]) => input.route === '/assets/trash')).toHaveLength(1)
  expect(data.request.mock.calls.find(([input]) => input.route === '/assets/trash')![0]).toMatchObject({
    body: {
      file_ids: ['one', 'two'],
      directory_ids: ['folder']
    }
  })
  await waitFor(() => expect(screen.queryByRole('group', { name: '多选操作' })).toBeNull())
})

it('批量添加一次准备全部引用并只导航一次，不下载或发送；容量失败时保留之前的值', async () => {
  const data = setup()
  stashSessionDraft(null, '已有问题', [])
  const menu = await chooseFiles()
  fireEvent.click(within(menu).getByRole('button', { name: '添加到会话' }))
  await waitFor(() => expect(data.ready).toHaveBeenCalledTimes(1))
  expect(takeSessionDraft(null).attachments[0]?.refText).toContain('"asset_id":"one"')
  expect(takeSessionDraft(null).attachments[1]?.refText).toContain('"asset_id":"two"')
  expect(takeSessionDraft(null).text).toContain('已有问题')
  expect(data.api.mock.calls.filter(([input]) => input.path.endsWith('/test'))).toHaveLength(1)
  expect(data.transfer).not.toHaveBeenCalled()
  data.failUsage()
  fireEvent.click(screen.getByRole('button', { name: '刷新' }))
  await waitFor(() => expect(screen.getByTitle('容量信息暂未更新。')).toBeTruthy())
  expect(screen.getByText('已用 358.8 MB / 总量 2048.0 GB')).toBeTruthy()
  await act(async () => data.view.unmount())
})

it('选择中包含无权限文件时不开放批量读写动作，容量首次失败不会显示虚假的零用量', async () => {
  const data = setup(true)
  data.failUsage()
  const menu = await chooseFiles()
  expect(screen.getByText('容量信息暂不可用')).toBeTruthy()
  expect(screen.queryByText(/已用 0 B/)).toBeNull()

  for (const action of ['添加到会话', '下载', '移动', '删除']) {
    expect(within(menu).queryByRole('button', { name: action })).toBeNull()
  }

  const restricted = screen.getByRole('group', { name: '报告二.pdf' })
  expect((within(restricted).getByRole('button', { name: '下载' }) as HTMLButtonElement).disabled).toBe(true)
  expect(data.transfer).not.toHaveBeenCalled()
  expect(data.request.mock.calls.some(([input]) => ['/assets/move', '/assets/trash'].includes(input.route))).toBe(false)
})
