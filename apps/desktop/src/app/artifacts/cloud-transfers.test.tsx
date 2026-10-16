import { useStore } from '@nanostores/react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { PreviewTilePane } from '@/app/chat/right-rail/preview'
import { NotificationStack } from '@/components/notifications'
import { I18nProvider } from '@/i18n'
import { clearSessionDraft, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $previewTabs, closeRightRailTab } from '@/store/preview'
import { $newChatProfile, $newChatRoute } from '@/store/profile'
import { $connection, $selectedStoredSessionId } from '@/store/session'

import { CloudLibrary } from './cloud-library'

afterEach(() => {
  cleanup()
  $previewTabs.set([])
  clearNotifications()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 测试实际右侧预览渲染器，通过原生标签状态更新而非复刻文件显示界面。 */
function CloudPreviewHarness() {
  const tabs = useStore($previewTabs)

  return (
    <>
      {tabs
        .filter(tab => tab.target.source.startsWith('cloud-drive:'))
        .map(tab => (
          <PreviewTilePane key={tab.id} onClose={() => closeRightRailTab(tab.id)} tabId={tab.id} />
        ))}
    </>
  )
}

/** 云盘能力和目录固定，传输由每个测试提供真实 IPC 返回形状。 */
function setup(
  transfer = vi.fn().mockResolvedValue({ status: 'succeeded', name: 'uploaded.txt' }),
  onDraftReady?: (route: string) => void,
  fileName = 'report.txt',
  batch = false
) {
  const request = vi.fn(async ({ route }: { route: string }) =>
    route === '/asset-spaces'
      ? { items: [{ kind: 'personal', space_id: 'space', root_asset_id: 'service-root' }] }
      : route === '/drive/capabilities'
        ? { upload: true, download: true, create_folder: true, rename: true, trash: true }
        : route.includes('page_no=1')
          ? {
              items: batch
                ? [1, 2, 3].map(index => ({
                    asset_id: `asset-${index}`,
                    kind: 'file',
                    name: `${index}.txt`,
                    size_bytes: 5
                  }))
                : [{ asset_id: 'asset-one', kind: 'file', name: fileName, size_bytes: 5 }]
            }
          : { items: [] }
  )

  const cancel = vi.fn().mockResolvedValue(undefined)
  const unsubscribe = vi.fn()
  const listener = vi.fn().mockReturnValue(unsubscribe)
  const openExternal = vi.fn()

  const api = vi.fn(async ({ path }: { path: string }) =>
    path.endsWith('/test')
      ? { ok: true, tools: [{ name: 'download' }] }
      : { servers: [{ name: 'UniWork-Drive', enabled: true }] }
  )

  vi.stubGlobal('hermesDesktop', {
    api,
    normalizePreviewTarget: vi.fn(async (path: string) => ({
      kind: 'file',
      label: fileName,
      source: path,
      path,
      url: 'file://' + path,
      previewKind: /\.docx$/.test(path) ? 'binary' : 'text',
      language: 'text'
    })),
    readFileText: vi.fn(async () => ({ text: 'hello', byteSize: 5, language: 'text' })),
    convertOfficePreview: vi.fn(async () => ({
      ok: true,
      pdf: Uint8Array.of(37, 80, 68, 70),
      converter: 'fixture',
      version: '1'
    })),
    cancelOfficePreview: vi.fn(),
    cloudDriveAgentReady: vi.fn().mockResolvedValue(true),
    cloudDriveRequest: request,
    cloudDriveTransfer: transfer,
    cancelCloudDriveTransfer: cancel,
    onCloudDriveProgress: listener,
    openExternal
  })

  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <CloudLibrary onDraftReady={onDraftReady} />
      <CloudPreviewHarness />
    </I18nProvider>
  )

  return { view, request, transfer, cancel, listener, unsubscribe, openExternal, api }
}

it('上传绑定服务根目录，进度只接受当前任务，取消完成前不会重复发送', async () => {
  let finish!: (value: unknown) => void

  const transfer = vi.fn().mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )

  const fixture = setup(transfer)
  await screen.findByRole('button', { name: 'report.txt' })
  fireEvent.click(screen.getByRole('button', { name: '上传文件' }))
  const input = transfer.mock.calls[0][0]
  expect(input).toMatchObject({ operation: 'upload', parentAssetId: 'service-root' })
  expect(input).not.toHaveProperty('path')
  const progress = fixture.listener.mock.calls[0][0]
  act(() => {
    progress({ id: 'other-window', completed: 999999, total: 999999 })
  })
  expect(screen.queryByText(/977 KiB/)).toBeNull()
  act(() => {
    progress({ id: input.id, completed: 2048, total: 4096 })
  })
  expect(screen.getByText(/2 KiB \/ 4 KiB/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '停止传输' }))
  expect(fixture.cancel).toHaveBeenCalledWith(input.id)
  expect((screen.getByRole('button', { name: '上传文件' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => {
    finish({ protocol: 'uniwork.drive-result.v1', ok: false, status: 'outcome_unknown', code: 'UPLOAD_INTERRUPTED' })
  })
  expect(await screen.findByText(/上传结果待确认/)).toBeTruthy()
  expect(transfer).toHaveBeenCalledTimes(1)
})

it('预览原文件经统一规范化和读取入口，下载只调用原生入口，不打开签名链接', async () => {
  const transfer = vi
    .fn()
    .mockResolvedValueOnce({
      status: 'succeeded',
      name: 'report.txt',
      preview: { kind: 'file', path: '/account/cloud-drive-preview/report.txt' }
    })
    .mockResolvedValue({ status: 'succeeded', name: 'report.txt' })

  const fixture = setup(transfer)
  fireEvent.click(await screen.findByRole('button', { name: 'report.txt' }))
  expect(await screen.findByText('hello')).toBeTruthy()
  expect(transfer.mock.calls[0][0]).toMatchObject({
    operation: 'preview',
    assetId: 'asset-one',
    name: 'report.txt',
    size: 5
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  act(() => closeRightRailTab($previewTabs.get()[0].id))
  fireEvent.click(screen.getByRole('button', { name: '下载' }))
  await screen.findByText('已保存到本机')
  expect(transfer.mock.calls[1][0]).toMatchObject({ operation: 'download', assetId: 'asset-one' })
  expect(fixture.openExternal).not.toHaveBeenCalled()
})

it('Office 原文件交给既有预览入口，转换结果关闭后释放，下载仍指向原文件', async () => {
  let finish!: (value: unknown) => void
  const createUrl = vi.fn(() => 'blob:cloud-office-preview')
  const revokeUrl = vi.fn()
  vi.stubGlobal(
    'URL',
    class extends URL {
      static createObjectURL = createUrl
      static revokeObjectURL = revokeUrl
    }
  )

  const transfer = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
    .mockResolvedValue({ status: 'succeeded', name: '报告.docx' })

  const fixture = setup(transfer, undefined, '报告.docx')
  fireEvent.click(await screen.findByRole('button', { name: '报告.docx' }))
  const input = transfer.mock.calls[0][0]
  expect(input).toMatchObject({ operation: 'preview', name: '报告.docx', assetId: 'asset-one' })
  act(() => fixture.listener.mock.calls[0][0]({ id: input.id, completed: 5, total: 5, phase: 'converting' }))
  expect(screen.queryByRole('dialog', { name: '传输记录' })).toBeNull()
  expect(screen.queryByText('正在传输…')).toBeNull()
  expect(screen.queryByRole('button', { name: '停止传输' })).toBeNull()

  await act(async () =>
    finish({
      status: 'succeeded',
      name: '报告.docx',
      preview: {
        kind: 'file',
        path: '/account/cloud-drive-preview/报告.docx'
      }
    })
  )
  expect(await screen.findByTitle('报告.docx')).toHaveProperty('src', 'blob:cloud-office-preview')
  expect(createUrl).toHaveBeenCalledTimes(1)
  expect(window.hermesDesktop.convertOfficePreview).toHaveBeenCalledWith(
    '/account/cloud-drive-preview/报告.docx',
    expect.any(String)
  )
  act(() => closeRightRailTab($previewTabs.get()[0].id))
  await waitFor(() => expect(revokeUrl).toHaveBeenCalledWith('blob:cloud-office-preview'))
  fireEvent.click(screen.getByRole('button', { name: '下载' }))
  await screen.findByText('已保存到本机')
  expect(transfer.mock.calls[1][0]).toMatchObject({ operation: 'download', assetId: 'asset-one', name: '报告.docx' })
  expect(fixture.openExternal).not.toHaveBeenCalled()
})

it('离开资料库取消在途上传并解除进度订阅，迟到响应不会刷新目录', async () => {
  let finish!: (value: unknown) => void

  const fixture = setup(
    vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
  )

  await screen.findByRole('button', { name: 'report.txt' })
  await waitFor(() => expect(screen.queryByText('正在加载…')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: '上传文件' }))
  const calls = fixture.request.mock.calls.length
  fixture.view.unmount()
  expect(fixture.unsubscribe).toHaveBeenCalledTimes(1)
  expect(fixture.cancel).toHaveBeenCalledWith(fixture.transfer.mock.calls[0][0].id)
  await act(async () => {
    finish({ status: 'succeeded', name: 'late.txt' })
  })
  expect(fixture.request).toHaveBeenCalledTimes(calls)
})

it('加入聊天按钮只添加文件引用，保存草稿后才导航，不触发下载或发送', async () => {
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $selectedStoredSessionId.set(null)
  $newChatProfile.set(null)
  $newChatRoute.set(null)
  $apiRequestScope.set({ connectionId: null, profile: 'default' })
  stashSessionDraft(null, '已有问题', [])
  const onDraftReady = vi.fn()
  const fixture = setup(undefined, onDraftReady)

  try {
    await screen.findByRole('button', { name: 'report.txt' })
    fireEvent.click(screen.getByRole('button', { name: '添加到会话' }))
    await waitFor(() => expect(onDraftReady).toHaveBeenCalledWith('/'))
    expect(takeSessionDraft(null).text).toContain('已有问题')
    expect(takeSessionDraft(null).attachments[0]?.refText).toContain('"asset_id":"asset-one"')
    expect(fixture.transfer).not.toHaveBeenCalled()
    expect(fixture.request.mock.calls.some(([input]) => input.route.includes('download'))).toBe(false)
    expect(fixture.api.mock.calls.every(([input]) => input.path.includes('/api/mcp/servers'))).toBe(true)
  } finally {
    clearSessionDraft(null)
  }
})

it('关闭传输浮窗不取消，完成通知使用文件名；重新打开及清除记录都不触发重复上传', async () => {
  let finish!: (value: unknown) => void

  const fixture = setup(
    vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
  )

  await screen.findByRole('button', { name: 'report.txt' })
  fireEvent.click(screen.getByRole('button', { name: '上传文件' }))
  let popup = screen.getByRole('dialog', { name: '传输记录' })
  const id = fixture.transfer.mock.calls[0][0].id
  act(() =>
    fixture.listener.mock.calls[0][0]({ id, name: '报告.txt', completed: 2048, total: 4096, phase: 'verifying' })
  )
  expect(within(popup).getByText('正在确认云盘保存结果')).toBeTruthy()
  fireEvent.click(within(popup).getByRole('button', { name: '关闭' }))
  expect(fixture.cancel).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog', { name: '传输记录' })).toBeNull()
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <NotificationStack />
    </I18nProvider>
  )
  await act(async () => finish({ status: 'succeeded', name: '报告.txt' }))
  expect(await screen.findByText('“报告.txt”已上传到云盘')).toBeTruthy()
  expect(screen.queryByText('已保存到云盘')).toBeNull()
  expect($notifications.get()[0]).toMatchObject({ kind: 'success', message: '“报告.txt”已上传到云盘' })
  fireEvent.click(screen.getByRole('button', { name: '传输记录' }))
  popup = screen.getByRole('dialog', { name: '传输记录' })
  expect(within(popup).getByText('已保存到云盘')).toBeTruthy()
  fireEvent.click(within(popup).getByRole('button', { name: '清除已结束记录' }))
  expect(screen.queryByRole('button', { name: '传输记录' })).toBeNull()
  expect(fixture.transfer).toHaveBeenCalledTimes(1)
})

it.each([
  ['QUOTA_EXCEEDED', '云盘容量不足，请清理空间后重试。'],
  ['CONFLICT', '目标目录存在同名项目，请更换名称或目标。'],
  ['FILE_TOO_LARGE', '文件超过当前云盘允许的上传大小。'],
  ['REQUEST_TIMEOUT', '请求超时，本次操作未完成，请稍后重试。']
])('上传失败 %s 在浮窗及通知中保留具体场景，不自动重试', async (code, message) => {
  const fixture = setup(
    vi.fn().mockResolvedValue({ protocol: 'uniwork.drive-result.v1', ok: false, status: 'failed', code })
  )

  await screen.findByRole('button', { name: 'report.txt' })
  fireEvent.click(screen.getByRole('button', { name: '上传文件' }))
  const popup = await screen.findByRole('dialog', { name: '传输记录' })
  expect(await within(popup).findByText(message)).toBeTruthy()
  expect($notifications.get()[0]).toMatchObject({ kind: 'error', message })
  expect(within(popup).queryByText('100%')).toBeNull()
  expect(fixture.transfer).toHaveBeenCalledTimes(1)
})

it('取消原生文件选择不弹错误；主动停止下载显示已取消，且原生结束前保持锁定', async () => {
  const transfer = vi.fn().mockResolvedValueOnce({ status: 'cancelled' })
  let finish!: (value: unknown) => void
  transfer.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const fixture = setup(transfer)
  await screen.findByRole('button', { name: 'report.txt' })
  fireEvent.click(screen.getByRole('button', { name: '上传文件' }))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '上传文件' }) as HTMLButtonElement).disabled).toBe(false)
  )
  expect(screen.queryByRole('dialog', { name: '传输记录' })).toBeNull()
  expect($notifications.get()).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: '下载' }))
  const popup = screen.getByRole('dialog', { name: '传输记录' })
  fireEvent.click(within(popup).getByRole('button', { name: '停止传输' }))
  expect(fixture.cancel).toHaveBeenCalledTimes(1)
  expect((screen.getByRole('button', { name: '下载' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => finish({ status: 'cancelled' }))
  expect(await within(popup).findByText('下载已取消')).toBeTruthy()
  expect($notifications.get()[0]).toMatchObject({ kind: 'info', message: '下载已取消' })
  expect(within(popup).queryByText('已保存到本机')).toBeNull()
})

it('批量下载部分成功逐项保留保存、失败和未开始状态，不把整批显示为成功', async () => {
  const transfer = vi.fn().mockResolvedValue({
    protocol: 'uniwork.drive-result.v1',
    ok: false,
    status: 'partial_success',
    code: 'DOWNLOAD_BATCH_PARTIAL',
    files: [
      { index: 0, name: '1.txt', status: 'succeeded' },
      { index: 1, name: '2.txt', status: 'failed', code: 'DOWNLOAD_FAILED' },
      { index: 2, name: '3.txt', status: 'not_started' }
    ]
  })

  const fixture = setup(transfer, undefined, 'report.txt', true)
  await screen.findByRole('button', { name: '1.txt' })
  fireEvent.click(screen.getByRole('checkbox', { name: '选择已显示的全部项目' }))
  const actions = screen.getByRole('group', { name: '多选操作' })
  fireEvent.click(within(actions).getByRole('button', { name: '下载' }))
  const popup = await screen.findByRole('dialog', { name: '传输记录' })
  expect(await within(within(popup).getByRole('group', { name: '1.txt' })).findByText('已保存到本机')).toBeTruthy()
  expect(
    within(within(popup).getByRole('group', { name: '2.txt' })).getByText('文件未能完整保存，请重试。')
  ).toBeTruthy()
  expect(within(within(popup).getByRole('group', { name: '3.txt' })).getByText('尚未开始')).toBeTruthy()
  expect($notifications.get()[0]).toMatchObject({
    kind: 'warning',
    message: '部分文件已保存到本机，其余文件未完成，请查看传输记录。'
  })
  expect(fixture.transfer).toHaveBeenCalledTimes(1)
})

it('预览不打开传输浮窗，切换 Profile 后迟到字节不打开旧文件', async () => {
  let finish!: (value: unknown) => void

  const fixture = setup(
    vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
  )

  fireEvent.click(await screen.findByRole('button', { name: 'report.txt' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('button', { name: '传输记录' })).toBeNull()
  const previous = $apiRequestScope.get()
  act(() => $apiRequestScope.set({ connectionId: 'local', profile: 'other' }))
  await act(async () =>
    finish({
      status: 'succeeded',
      name: 'report.txt',
      preview: { kind: 'file', path: '/account/cloud-drive-preview/report.txt' }
    })
  )
  expect($previewTabs.get()).toHaveLength(0)
  expect(fixture.openExternal).not.toHaveBeenCalled()
  act(() => $apiRequestScope.set(previous))
})
