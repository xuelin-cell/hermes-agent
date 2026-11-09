import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { FilePreviewToolbar } from '@/app/chat/right-rail/preview-toolbar'
import { I18nProvider } from '@/i18n'
import { $notifications, clearNotifications } from '@/store/notifications'
import type { PreviewTarget } from '@/store/preview'
import { $connection, $selectedStoredSessionId } from '@/store/session'

const storedId = atom('source-session')
const cwd = atom('/account/work')
const open = vi.hoisted(() => vi.fn())
vi.mock('@/app/chat/session-view', () => ({ useSessionView: () => ({ $cwd: cwd, $storedId: storedId }) }))
vi.mock('@/store/preview', async original => ({ ...(await original<object>()), openPreview: open }))
vi.mock('@/lib/local-preview', async original => ({
  ...(await original<object>()),
  normalizeOrLocalPreviewTarget: async () => ({
    kind: 'file',
    path: '/account/work/report.csv',
    source: 'report.csv',
    label: 'report.csv',
    url: 'file:///account/work/report.csv'
  })
}))

import { PreviewAttachment } from './preview-attachment'

const bridge = window.hermesDesktop

const target: PreviewTarget = {
  kind: 'file',
  path: '/account/work/report.csv',
  source: 'report.csv',
  label: 'report.csv',
  url: 'file:///account/work/report.csv',
  shareOrigin: {
    connectionId: 'local',
    profile: 'default',
    sessionId: 'source-session',
    path: '/account/work/report.csv'
  }
}

afterEach(() => {
  cleanup()
  clearNotifications()
  window.hermesDesktop = bridge
  $connection.set(null)
  $selectedStoredSessionId.set(null)
  $apiRequestScope.set({ profile: null, connectionId: null })
  vi.clearAllMocks()
})

/** 真实卡片、目录选择与上传控制器串联，仅以原生桥替身隔离账号和云端写入。 */
function setup() {
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $apiRequestScope.set({ profile: 'default', connectionId: 'local' })
  const transfer = vi.fn(async (_options: unknown) => ({ status: 'succeeded', name: 'report.csv' }))

  const request = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ kind: 'personal', space_id: 'space', root_asset_id: 'root' }] }
    }

    if (route === '/drive/capabilities') {
      return { upload: true, create_folder: true, rename: true, trash: true, download: true }
    }

    const params = new URLSearchParams(route.split('?')[1])

    return {
      items:
        params.get('parent_asset_id') === 'root' ? [{ asset_id: 'folder', kind: 'directory', name: 'Reports' }] : []
    }
  })

  window.hermesDesktop = {
    cloudDriveRequest: request,
    cloudDriveTransfer: transfer,
    cancelCloudDriveTransfer: vi.fn(),
    onCloudDriveProgress: () => () => {}
  } as never

  return { transfer, request }
}

it('卡片上传直接沿用文件与会话，打开预览也保存相同来源，不下载或自动打开', async () => {
  const { transfer, request } = setup()
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <PreviewAttachment target="report.csv" />
    </I18nProvider>
  )
  expect(request).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Upload to library' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Reports' }))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Upload to this folder' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Upload to this folder' }))
  await waitFor(() => expect(transfer).toHaveBeenCalledTimes(1))
  expect(transfer.mock.calls[0][0]).toMatchObject({
    operation: 'upload',
    parentAssetId: 'folder',
    artifact: {
      sessionId: 'source-session',
      profile: 'default',
      connectionId: 'local',
      value: '/account/work/report.csv'
    }
  })
  await waitFor(() => expect($notifications.get()[0]?.message).toContain('report.csv'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Open preview: report.csv' }))
  await waitFor(() => expect(open).toHaveBeenCalledWith(target))
})

it('预览上传不借用当前会话，失配来源和云盘文件无入口，换账号关闭旧弹窗', async () => {
  const { transfer } = setup()
  $selectedStoredSessionId.set('unrelated-session')

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <FilePreviewToolbar target={target}>
        <div />
      </FilePreviewToolbar>
    </I18nProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: 'Upload to library' }))
  await screen.findByRole('button', { name: 'Reports' })
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Upload to this folder' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Upload to this folder' }))
  await waitFor(() => expect(transfer).toHaveBeenCalledTimes(1))
  expect(transfer.mock.calls[0][0]).toMatchObject({ artifact: { sessionId: 'source-session', profile: 'default' } })
  expect(screen.queryByRole('dialog')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Upload to library' }))
  await screen.findByRole('button', { name: 'Reports' })
  act(() => $apiRequestScope.set({ profile: 'default', connectionId: 'another-account' }))
  expect(screen.queryByRole('dialog')).toBeNull()

  for (const next of [
    { ...target, shareOrigin: null },
    { ...target, shareOrigin: { ...target.shareOrigin!, profile: 'other' } },
    {
      ...target,
      kind: 'url' as const,
      path: undefined,
      source: 'https://example.com/report.csv',
      shareOrigin: undefined
    }
  ]) {
    view.rerender(
      <I18nProvider configClient={null} initialLocale="en">
        <FilePreviewToolbar target={next}>
          <div />
        </FilePreviewToolbar>
      </I18nProvider>
    )
    expect(screen.queryByRole('button', { name: 'Upload to library' })).toBeNull()
  }

  view.rerender(
    <I18nProvider configClient={null} initialLocale="en">
      <FilePreviewToolbar target={target}>
        <div />
      </FilePreviewToolbar>
    </I18nProvider>
  )
  act(() => $connection.set({ mode: 'remote', profile: 'default' } as never))
  expect(screen.queryByRole('button', { name: 'Upload to library' })).toBeNull()
})
