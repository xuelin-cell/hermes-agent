import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { atom } from 'nanostores'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { CloudLibrary } from '@/app/artifacts/cloud-library'
import { FilePreviewToolbar } from '@/app/chat/right-rail/preview-toolbar'
import { I18nProvider } from '@/i18n'
import { clearNotifications } from '@/store/notifications'
import type { PreviewTarget } from '@/store/preview'
import { $connection } from '@/store/session'

const cwd = atom('/account/work')
const storedId = atom('original-session')
vi.mock('@/app/chat/session-view', () => ({ useSessionView: () => ({ $cwd: cwd, $storedId: storedId }) }))

import { PreviewAttachment } from './preview-attachment'

const originalBridge = window.hermesDesktop

const target: PreviewTarget = {
  kind: 'file',
  path: '/account/work/report.csv',
  source: '/account/work/report.csv',
  label: 'report.csv',
  url: 'file:///account/work/report.csv',
  shareOrigin: {
    connectionId: 'local',
    profile: 'default',
    sessionId: 'original-session',
    path: '/account/work/report.csv'
  }
}

afterEach(() => {
  cleanup()
  window.hermesDesktop = originalBridge
  $connection.set(null)
  $apiRequestScope.set({ profile: null, connectionId: null })
  clearNotifications()
})

it.each(['card', 'preview'] as const)('%s 提交后立即自动关闭，后台上传跨页继续并在云盘查看结果', async kind => {
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $apiRequestScope.set({ profile: 'default', connectionId: 'local' })
  let finish!: (value: unknown) => void
  let report!: (value: unknown) => void
  const cancel = vi.fn(async () => undefined)

  const transfer = vi.fn(
    (_input: unknown) =>
      new Promise(resolve => {
        finish = resolve
      })
  )

  const unsubscribe = vi.fn()
  window.hermesDesktop = {
    cloudDriveRequest: async ({ route }: { route: string }) => {
      if (route === '/asset-spaces') {
        return { items: [{ kind: 'personal', space_id: 'space', root_asset_id: 'root' }] }
      }

      if (route === '/drive/capabilities') {
        return { upload: true, download: true, create_folder: true, rename: true, trash: true }
      }

      const params = new URLSearchParams(route.split('?')[1])

      return {
        items:
          params.get('parent_asset_id') === 'root' ? [{ asset_id: 'reports', kind: 'directory', name: 'Reports' }] : []
      }
    },
    cloudDriveTransfer: transfer,
    cancelCloudDriveTransfer: cancel,
    onCloudDriveProgress: (listener: typeof report) => {
      report = listener

      return unsubscribe
    }
  } as never

  const wrap = (child: ReactNode) => (
    <I18nProvider configClient={null} initialLocale="zh">
      {child}
    </I18nProvider>
  )

  const view = render(
    wrap(
      kind === 'card' ? (
        <PreviewAttachment target={target.path!} />
      ) : (
        <FilePreviewToolbar target={target}>
          <div />
        </FilePreviewToolbar>
      )
    )
  )

  fireEvent.click(screen.getByRole('button', { name: '上传到资料库' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Reports' }))
  await waitFor(() =>
    expect((screen.getByRole('button', { name: '上传到此文件夹' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: '上传到此文件夹' }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(cancel).not.toHaveBeenCalled()
  const request = transfer.mock.calls[0][0] as { id: string }
  expect(request).toMatchObject({
    parentAssetId: 'reports',
    artifact: { sessionId: 'original-session', profile: 'default', value: target.path }
  })
  act(() => report({ id: request.id, name: 'report.csv', completed: 1, total: 8 }))
  expect(screen.queryByRole('dialog', { name: '传输记录' })).toBeNull()
  expect(screen.queryByRole('button', { name: '传输记录' })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  view.rerender(wrap(<div>其他会话或页面</div>))
  expect(cancel).not.toHaveBeenCalled()
  expect(unsubscribe).not.toHaveBeenCalled()

  if (kind === 'preview') {
    act(() => {
      $connection.set({ mode: 'local', profile: 'another-profile' } as never)
      $apiRequestScope.set({ profile: 'another-profile', connectionId: 'local' })
    })
  }

  view.rerender(wrap(<CloudLibrary />))
  const popup = await screen.findByRole('dialog', { name: '传输记录' })
  expect(within(popup).getByRole('group', { name: 'report.csv' })).toBeTruthy()
  act(() => report({ id: request.id, name: 'report.csv', completed: 4, total: 8 }))
  expect(within(popup).getByText('50%')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '上传文件' }))
  expect(transfer).toHaveBeenCalledTimes(1)
  view.rerender(wrap(<div>再次切换页面</div>))
  expect(cancel).not.toHaveBeenCalled()
  await act(async () =>
    finish(
      kind === 'card'
        ? { status: 'succeeded', name: 'report.csv' }
        : { protocol: 'uniwork.drive-result.v1', ok: false, status: 'outcome_unknown', code: 'UPLOAD_INTERRUPTED' }
    )
  )
  view.rerender(wrap(<CloudLibrary />))
  const history = await screen.findByRole('dialog', { name: '传输记录' })
  expect(within(history).getAllByRole('group')).toHaveLength(1)

  if (kind === 'card') {
    expect(within(history).getByText('已保存到云盘')).toBeTruthy()
  } else {
    expect(within(history).getByText(/暂时无法自动确认上传结果/)).toBeTruthy()
  }

  expect(transfer).toHaveBeenCalledTimes(1)
  expect(cancel).not.toHaveBeenCalled()
})
