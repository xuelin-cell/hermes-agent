import { useStore } from '@nanostores/react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { I18nProvider } from '@/i18n'
import { $previewTabs, closeRightRail } from '@/store/preview'
import { $connection } from '@/store/session'

import { ArtifactsView } from './index'

vi.mock('./cloud-drive-tab', () => ({ CloudDriveTab: () => <p>Cloud file list</p> }))
vi.mock('./use-local-artifacts', () => ({
  useLocalArtifacts: () => ({
    groups: [
      {
        session: { id: 'source', profile: 'default', title: 'Source session', last_active: 100 },
        files: [
          {
            id: 'report',
            label: 'report.png',
            value: '/source/report.png',
            resolvedPath: '/source/report.png',
            connectionId: 'local',
            sessionId: 'source',
            profile: 'default',
            kind: 'image',
            byteSize: 10
          }
        ]
      }
    ],
    scanning: false,
    failures: 0,
    processed: 1,
    total: 1,
    refresh: vi.fn()
  })
}))

/** 模拟分屏增减时页面重新挂载；路由和真实预览状态保持在外层。 */
function PreviewLayout() {
  const previews = useStore($previewTabs)
  const location = useLocation()

  return (
    <>
      <ArtifactsView key={previews.length ? 'split' : 'single'} />
      <output aria-label="Route">{location.pathname + location.search + location.hash}</output>
    </>
  )
}

function setup(route = '/artifacts') {
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $apiRequestScope.set({ connectionId: 'local', profile: 'default' })
  vi.stubGlobal('hermesDesktop', {
    normalizePreviewTarget: vi.fn(async (path: string) => ({
      kind: 'file',
      path,
      source: path,
      url: `file://${path}`,
      label: 'report.png',
      previewKind: 'image'
    }))
  })

  return render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter initialEntries={[route]}>
        <PreviewLayout />
      </MemoryRouter>
    </I18nProvider>
  )
}

afterEach(() => {
  cleanup()
  closeRightRail()
  $connection.set(null)
  vi.unstubAllGlobals()
  localStorage.clear()
})

it('打开和关闭本地产物预览触发布局重挂载后，保持本地产物标签及既有路由参数', async () => {
  setup('/artifacts?keep=1#anchor')
  expect(screen.getByText('Cloud file list')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Local artifacts' }))
  fireEvent.click(screen.getByRole('button', { name: 'report.png' }))
  await waitFor(() => expect($previewTabs.get()).toHaveLength(1))
  expect(screen.getByRole('button', { name: 'report.png' })).toBeTruthy()
  expect(screen.queryByText('Cloud file list')).toBeNull()
  expect(screen.getByLabelText('Route').textContent).toBe('/artifacts?keep=1&library=local#anchor')
  act(() => closeRightRail())
  expect(screen.getByRole('button', { name: 'report.png' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Personal drive' }))
  expect(screen.getByText('Cloud file list')).toBeTruthy()
  expect(screen.getByLabelText('Route').textContent).toBe('/artifacts?keep=1#anchor')
})

it('重进指定本地产物路由恢复选择，未知标签使用桌面原有默认云盘', () => {
  const view = setup('/artifacts?library=local')
  expect(screen.getByRole('button', { name: 'report.png' })).toBeTruthy()
  view.unmount()
  setup('/artifacts?library=invalid')
  expect(screen.getByText('Cloud file list')).toBeTruthy()
})
