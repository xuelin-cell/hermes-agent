import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $notifications } from '@/store/notifications'
import { $connection } from '@/store/session'

import { ArtifactUploadAction, ArtifactUploadDialog } from './artifact-upload'
import type { ArtifactRecord } from './artifact-utils'

const artifact: ArtifactRecord = {
  id: 'artifact',
  kind: 'file',
  value: '/tmp/report.txt',
  href: 'file:///tmp/report.txt',
  label: 'report.txt',
  sessionId: 'session-one',
  profile: 'work',
  connectionId: 'local',
  sessionTitle: '已有聊天',
  timestamp: 1000
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  $connection.set(null)
  $notifications.set([])
})

/** 云盘目录使用完整分页和读写权限，上传通过原生桥返回操作状态。 */
function setup(transfer = vi.fn().mockResolvedValue({ status: 'succeeded', name: 'report.txt' })) {
  $connection.set({ mode: 'local', profile: 'default' } as never)

  const request = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'space', root_asset_id: 'service-root' }] }
    }

    if (route === '/drive/capabilities') {
      return { upload: true, create_folder: true, rename: true, trash: true, download: true }
    }

    const params = new URLSearchParams(route.split('?')[1])

    return params.get('page_no') === '1' && params.get('parent_asset_id') === 'service-root'
      ? {
          items: [
            { asset_id: 'team-folder', kind: 'directory', name: '团队' },
            { asset_id: 'read-only', kind: 'directory', name: '只读目录', permissions: { write: false } }
          ]
        }
      : { items: [] }
  })

  const cancel = vi.fn().mockResolvedValue(undefined)
  const unsubscribe = vi.fn()
  const listen = vi.fn().mockReturnValue(unsubscribe)
  vi.stubGlobal('hermesDesktop', {
    cloudDriveRequest: request,
    cloudDriveTransfer: transfer,
    cancelCloudDriveTransfer: cancel,
    onCloudDriveProgress: listen
  })
  const close = vi.fn()

  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ArtifactUploadDialog artifact={artifact} onClose={close} />
    </I18nProvider>
  )

  return { view, request, transfer, cancel, listen, unsubscribe, close }
}

it('选择云盘目录后直接上传捕获的产物源，成功后禁用重复提交', async () => {
  const fixture = setup()
  fireEvent.click(await screen.findByRole('button', { name: '团队' }))
  await screen.findByText('没有子文件夹，可以上传到当前目录。')
  expect(screen.getByText('目标：团队')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '返回上一级' }))
  fireEvent.click(screen.getByRole('button', { name: '团队' }))
  fireEvent.click(screen.getByRole('button', { name: '上传到此文件夹' }))
  await screen.findByText('已保存到云盘')
  expect(fixture.transfer.mock.calls[0][0]).toMatchObject({
    operation: 'upload',
    parentAssetId: 'team-folder',
    artifact: { sessionId: 'session-one', profile: 'work', connectionId: 'local', value: '/tmp/report.txt' }
  })
  expect((screen.getByRole('button', { name: '上传到此文件夹' }) as HTMLButtonElement).disabled).toBe(true)
  expect(fixture.listen).toHaveBeenCalledTimes(1)
})

it('只读目标不允许上传，未知结果保留提示并阻止再次发送', async () => {
  const fixture = setup(
    vi.fn().mockResolvedValue({
      protocol: 'uniwork.drive-result.v1',
      ok: false,
      status: 'outcome_unknown',
      code: 'UPLOAD_INTERRUPTED'
    })
  )

  fireEvent.click(await screen.findByRole('button', { name: '只读目录' }))
  expect((screen.getByRole('button', { name: '上传到此文件夹' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: '个人云盘' }))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '上传到此文件夹' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: '上传到此文件夹' }))
  await waitFor(() =>
    expect($notifications.get()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'warning', message: expect.stringMatching(/确认上传结果|上传结果待确认/) })
      ])
    )
  )
  fireEvent.click(screen.getByRole('button', { name: '上传到此文件夹' }))
  expect(fixture.transfer).toHaveBeenCalledTimes(1)
})

it('核对来源或上传期间保持单次请求，取消和离页只终止自己的传输', async () => {
  let finish!: (value: unknown) => void

  const fixture = setup(
    vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve
        })
    )
  )

  await screen.findByRole('button', { name: '团队' })
  fireEvent.click(screen.getByRole('button', { name: '上传到此文件夹' }))
  const id = fixture.transfer.mock.calls[0][0].id
  act(() => {
    fixture.listen.mock.calls[0][0]({ id, completed: 2048, total: 4096 })
  })
  expect(screen.getByText(/2 KiB \/ 4 KiB/)).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '停止传输' }))
  expect(fixture.cancel).toHaveBeenCalledWith(id)
  expect((screen.getByRole('button', { name: '上传到此文件夹' }) as HTMLButtonElement).disabled).toBe(true)
  const requests = fixture.request.mock.calls.length
  fixture.view.unmount()
  expect(fixture.unsubscribe).toHaveBeenCalledTimes(1)
  await act(async () => {
    finish({ status: 'succeeded', name: 'late.txt' })
  })
  expect(fixture.request).toHaveBeenCalledTimes(requests)
})

it('来源核对失败展示可恢复提示，敏感文件说明原因', async () => {
  const fixture = setup(
    vi.fn().mockResolvedValue({
      protocol: 'uniwork.drive-result.v1',
      ok: false,
      status: 'failed',
      code: 'ARTIFACT_SOURCE_BLOCKED'
    })
  )

  await screen.findByRole('button', { name: '团队' })
  fireEvent.click(screen.getByRole('button', { name: '上传到此文件夹' }))
  await screen.findByText('该文件属于敏感配置或凭据，不能上传云盘。')
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '上传到此文件夹' }) as HTMLButtonElement).disabled).toBe(false)
  )
  expect(fixture.transfer).toHaveBeenCalledTimes(1)
})

it('上传入口只对本机文件展示，网络图片、链接和远程来源不开放', () => {
  $connection.set({ mode: 'local', profile: 'default' } as never)
  const selected = vi.fn()

  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <ArtifactUploadAction artifact={artifact} onSelect={selected} />
    </I18nProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: '上传到云盘 · report.txt' }))
  expect(selected).toHaveBeenCalledWith(artifact)

  for (const value of [
    { ...artifact, kind: 'image' as const, value: 'https://cdn.invalid/image.png' },
    { ...artifact, connectionId: 'ssh-source' },
    { ...artifact, kind: 'link' as const }
  ]) {
    view.rerender(
      <I18nProvider configClient={null} initialLocale="zh">
        <ArtifactUploadAction artifact={value} onSelect={selected} />
      </I18nProvider>
    )
    expect(screen.queryByRole('button')).toBeNull()
  }
})
