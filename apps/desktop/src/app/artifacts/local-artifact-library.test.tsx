import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { LocalFilePreview } from '@/app/chat/right-rail/preview-file'
import { PreviewPane } from '@/app/chat/right-rail/preview-pane'
import { I18nProvider } from '@/i18n'
import { $previewTabs } from '@/store/preview'
import { $connection } from '@/store/session'

import { LocalArtifactLibrary } from './local-artifact-library'

const data = vi.hoisted(() => ({
  refresh: vi.fn(),
  groups: [
    {
      session: { id: 'source-chat', profile: 'default', title: 'Quarterly plan', last_active: 100 },
      files: ['report.md', 'chart.png'].map((label, index) => ({
        id: label,
        label,
        value: `/source/${label}`,
        resolvedPath: `/source/${label}`,
        connectionId: 'local',
        sessionId: 'source-chat',
        profile: 'default',
        kind: index ? 'image' : 'file',
        byteSize: 2048
      }))
    }
  ]
}))

vi.mock('./use-local-artifacts', () => ({
  useLocalArtifacts: () => ({ ...data, processed: 1, total: 1, failures: 0, scanning: false })
}))

afterEach(() => {
  cleanup()
  localStorage.clear()
  $previewTabs.set([])
  $connection.set(null)
  vi.unstubAllGlobals()
})

it('会话分组可折叠，标题搜索与收藏筛选组合工作，收藏在重新进入页面后保留', async () => {
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $apiRequestScope.set({ connectionId: 'local', profile: 'default' })

  /** 用同一原生账号重新挂载，核对收藏持久化。 */
  const mount = () =>
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MemoryRouter>
          <LocalArtifactLibrary />
        </MemoryRouter>
      </I18nProvider>
    )

  let view = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse files in “Quarterly plan”' }))
  expect(screen.queryByRole('button', { name: 'report.md' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Expand files in “Quarterly plan”' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Search files or conversations' }), {
    target: { value: 'Quarterly' }
  })
  expect(screen.getByRole('button', { name: 'chart.png' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Favorite · report.md' }))
  expect(screen.getByRole('button', { name: 'Remove favorite · report.md' }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'My favorites' }))
  expect(screen.getByRole('button', { name: 'report.md' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'chart.png' })).toBeNull()
  view.unmount()
  view = mount()
  fireEvent.click(screen.getByRole('button', { name: 'My favorites' }))
  expect(screen.getByRole('button', { name: 'report.md' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'chart.png' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull()
  view.unmount()
})

it('产物名称打开统一预览标签且不弹窗，分享仍使用产物来源；跨 Profile 不探测分享资格', async () => {
  const eligibility = vi.fn().mockResolvedValue({ publishable: true })
  const file = data.groups[0].files[0]

  const target = {
    kind: 'file' as const,
    path: file.resolvedPath,
    url: `file://${file.resolvedPath}`,
    source: file.value,
    label: file.label,
    previewKind: 'text' as const,
    language: 'markdown'
  }

  const normalize = vi.fn().mockResolvedValue(target)
  vi.stubGlobal('hermesDesktop', {
    normalizePreviewTarget: normalize,
    readFileText: vi.fn().mockResolvedValue({ text: '# Artifact', language: 'markdown', byteSize: 10 }),
    artifactShare: { inspect: vi.fn().mockResolvedValue(null), eligibility, onChanged: () => () => {} }
  })
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $apiRequestScope.set({ connectionId: 'local', profile: 'default' })

  const view = render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter>
        <LocalArtifactLibrary />
      </MemoryRouter>
    </I18nProvider>
  )

  fireEvent.click(screen.getByRole('button', { name: 'report.md' }))
  await waitFor(() => expect($previewTabs.get()).toHaveLength(1))
  const opened = $previewTabs.get()[0].target
  expect(normalize).toHaveBeenCalledWith(file.resolvedPath)
  expect(opened.shareOrigin).toEqual({
    connectionId: 'local',
    profile: 'default',
    sessionId: 'source-chat',
    path: file.resolvedPath
  })
  expect(screen.queryByRole('dialog')).toBeNull()
  view.unmount()

  const preview = render(<LocalFilePreview reloadKey={0} target={opened} />)
  await waitFor(() =>
    expect(eligibility).toHaveBeenCalledWith({
      sessionId: 'source-chat',
      path: '/source/report.md',
      content: undefined
    })
  )
  preview.unmount()
  eligibility.mockClear()
  $connection.set({ mode: 'local', profile: 'other' } as never)
  render(<LocalFilePreview reloadKey={0} target={opened} />)
  await screen.findByText('Artifact')
  expect(eligibility).not.toHaveBeenCalled()
})

it('更多菜单打开产物所在文件夹且不提供下载，默认 Profile 不显示内部名称', async () => {
  const reveal = vi.fn().mockResolvedValue(true)
  vi.stubGlobal('hermesDesktop', { revealPath: reveal })
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $apiRequestScope.set({ connectionId: 'local', profile: 'default' })
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter>
        <LocalArtifactLibrary />
      </MemoryRouter>
    </I18nProvider>
  )
  expect(screen.queryByText(/default/)).toBeNull()
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions · report.md' }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
  expect(await screen.findByRole('menuitem', { name: 'Open folder' })).toBeTruthy()
  expect(screen.queryByRole('menuitem', { name: 'Download' })).toBeNull()
  fireEvent.click(screen.getByRole('menuitem', { name: 'Open folder' }))
  await waitFor(() => expect(reveal).toHaveBeenCalledWith('/source/report.md'))
})

it('资料库 HTML 使用原生网页预览，资格检查指向产物来源，导航到其他文件后撤下分享', async () => {
  const eligibility = vi.fn().mockResolvedValue({ publishable: true })
  vi.stubGlobal('hermesDesktop', {
    artifactShare: { inspect: vi.fn().mockResolvedValue(null), eligibility, onChanged: () => () => {} }
  })
  $connection.set({ mode: 'local', profile: 'default' } as never)

  const target = {
    kind: 'file' as const,
    label: 'report.html',
    path: '/source/report.html',
    source: '/source/report.html',
    url: 'file:///source/report.html',
    previewKind: 'html' as const,
    shareOrigin: { connectionId: 'local', profile: 'default', sessionId: 'source-chat', path: '/source/report.html' }
  }

  const view = render(<PreviewPane target={target} />)
  const webview = view.container.querySelector('webview')!
  expect(webview).toBeTruthy()
  await waitFor(() =>
    expect(eligibility).toHaveBeenCalledWith({ sessionId: 'source-chat', path: target.path, content: undefined })
  )
  fireEvent(webview, Object.assign(new Event('did-navigate'), { url: 'file:///source/other.html' }))
  expect(screen.queryByRole('button', { name: 'Share artifact' })).toBeNull()
})

it('已有展示缓存中的分享链接立即隐藏，文件和会话计数同步，原始文件保留', () => {
  const previous = data.groups

  const link = {
    ...previous[0].files[0],
    id: 'published-link',
    label: 'published-page.html',
    value: 'https://public.example/uniclaw-shares/published-page.html',
    resolvedPath: undefined,
    kind: 'link'
  }

  data.groups = [
    { ...previous[0], files: [...previous[0].files, link] },
    { session: { ...previous[0].session, id: 'share-only', title: 'Only published link' }, files: [link] }
  ] as typeof data.groups
  vi.stubGlobal('hermesDesktop', {})

  try {
    render(
      <I18nProvider configClient={null} initialLocale="en">
        <MemoryRouter>
          <LocalArtifactLibrary />
        </MemoryRouter>
      </I18nProvider>
    )
    expect(screen.getByText('1 conversations · 2 files')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'report.md' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'chart.png' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'published-page.html' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Only published link' })).toBeNull()
    expect(previous[0].files).toHaveLength(2)
  } finally {
    data.groups = previous
  }
})
