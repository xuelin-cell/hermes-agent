import { act, cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { I18nProvider } from '@/i18n'
import { $connection } from '@/store/session'

import { LocalArtifactLibrary } from './local-artifact-library'

const resize = vi.hoisted(() => ({ handler: (_entries: readonly ResizeObserverEntry[]) => {} }))
vi.mock('@/hooks/use-resize-observer', () => ({
  useResizeObserver: (handler: typeof resize.handler) => {
    resize.handler = handler
  }
}))
vi.mock('./use-local-artifacts', () => ({
  useLocalArtifacts: () => ({
    groups: [
      {
        session: { id: 'source', profile: 'default', title: 'Source', last_active: 1 },
        files: [
          {
            id: 'report',
            label: 'report.png',
            value: '/source/report.png',
            resolvedPath: '/source/report.png',
            sessionId: 'source',
            profile: 'default',
            connectionId: 'local',
            kind: 'image',
            byteSize: 10
          }
        ]
      }
    ],
    scanning: false,
    failures: 0,
    refresh: () => {}
  })
}))
afterEach(() => {
  cleanup()
  $connection.set(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('尺寸观察回调返回前完成宽窄布局切换，文件行不消失，也不读文件或强制测量布局', () => {
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $apiRequestScope.set({ connectionId: 'local', profile: 'default' })
  const normalize = vi.fn()
  vi.stubGlobal('hermesDesktop', { normalizePreviewTarget: normalize })
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter>
        <LocalArtifactLibrary />
      </MemoryRouter>
    </I18nProvider>
  )
  const measure = vi.spyOn(Element.prototype, 'getBoundingClientRect')
  act(() => {
    resize.handler([{ contentRect: { width: 1000 } } as ResizeObserverEntry])
    expect(screen.queryByRole('button', { name: 'More actions · report.png' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Upload to cloud drive · report.png' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'report.png' })).toBeTruthy()
  })
  act(() => {
    resize.handler([{ contentRect: { width: 500 } } as ResizeObserverEntry])
    expect(screen.getByRole('button', { name: 'More actions · report.png' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Upload to cloud drive · report.png' })).toBeNull()
    expect(screen.getByRole('button', { name: 'report.png' })).toBeTruthy()
  })
  expect(normalize).not.toHaveBeenCalled()
  expect(measure).not.toHaveBeenCalled()
  measure.mockRestore()
})
