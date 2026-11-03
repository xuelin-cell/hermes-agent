import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { I18nProvider } from '@/i18n'
import { clearSessionDraft, takeSessionDraft } from '@/store/composer'
import { $previewTabs, closeRightRail } from '@/store/preview'
import { $activeSessionId, $connection, $selectedStoredSessionId } from '@/store/session'

import { browserAuthKey } from '../../../../shared/src/browser-maas-auth.js'

import { localFavoriteKey, readLocalFavorites, writeLocalFavorites } from './local-artifact-model'
import { artifactFileResolver } from './local-artifact-platform'

import { ArtifactsView } from './index'

const backend = vi.hoisted(() => ({ api: vi.fn(), messages: vi.fn(), list: vi.fn(), fresh: vi.fn() }))
vi.mock('@/hermes', async original => ({
  ...(await original<Record<string, unknown>>()),
  getAllSessionMessages: backend.messages,
  listAllProfileSessions: backend.list
}))
vi.mock('@/store/profile', async original => ({
  ...(await original<Record<string, unknown>>()),
  newSessionInAgent: backend.fresh,
  resolveNewChatOwnerRoute: () => null
}))
vi.mock('./cloud-drive-tab', () => ({ CloudDriveTab: () => <p>Cloud drive</p> }))
vi.mock('./artifact-upload', () => ({
  ArtifactUploadAction: () => null,
  ArtifactUploadDialog: ({ artifact }: { artifact: { value: string; sessionId: string } }) => (
    <div role="dialog">Upload {artifact.value} from {artifact.sessionId}</div>
  )
}))
vi.mock('./local-artifact-share-dialog', () => ({
  LocalArtifactShareDialog: ({ file }: { file: { resolvedPath: string; sessionId: string } }) => (
    <div role="dialog">Share {file.resolvedPath} from {file.sessionId}</div>
  )
}))

function login(id: string) {
  localStorage.setItem(browserAuthKey(import.meta.env.BASE_URL || '/'), JSON.stringify({
    token: `credential-${id}`, loginId: id, expiresAt: Date.now() + 60_000
  }))
}

beforeEach(() => {
  vi.clearAllMocks()
  window.document.documentElement.dataset.hermesBrowser = 'production'
  login('alice')
  $connection.set({ mode: 'remote', connectionId: 'local', profile: 'default' } as never)
  $apiRequestScope.set({ connectionId: 'local', profile: 'default' })
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  clearSessionDraft(null)
  backend.list.mockResolvedValue({ sessions: [{
    id: 'origin', connection_id: 'local', profile: 'default', cwd: '/workspace',
    title: 'Origin conversation', last_active: 1, message_count: 2
  }] })
  backend.messages.mockResolvedValue({ messages: [{
    role: 'assistant', content: '[Report](./report.md) [Image](./chart.png)', timestamp: 1
  }] })
  backend.api.mockImplementation(async ({ path }: { path: string }) => {
    if (path.startsWith('/api/files?')) {
      return { entries: ['report.md', 'chart.png'].map(name => ({
        name, path: `/workspace/${name}`, is_directory: false, size: 32, mime_type: 'text/plain'
      })) }
    }

    throw new Error(`Unexpected API: ${path}`)
  })
  vi.stubGlobal('hermesDesktop', {
    api: backend.api,
    prepareCloudDriveTurn: vi.fn(),
    saveGatewayFile: vi.fn().mockResolvedValue({ saved: true }),
    artifactShare: {
      eligibility: vi.fn().mockResolvedValue({ publishable: true }), onChanged: () => () => {}
    }
  })
})

afterEach(() => {
  cleanup()
  closeRightRail()
  clearSessionDraft(null)
  localStorage.clear()
  delete window.document.documentElement.dataset.hermesBrowser
  $connection.set(null)
  vi.unstubAllGlobals()
})

it('云端路由复用分组、收藏、预览、下载、上传和分享，加入会话只创建实例文件草稿', async () => {
  render(<I18nProvider configClient={null} initialLocale="en"><MemoryRouter initialEntries={['/artifacts?library=local']}>
    <ArtifactsView />
  </MemoryRouter></I18nProvider>)
  await screen.findByRole('button', { name: 'report.md' })
  expect(screen.getByText('1 conversations · 2 files')).toBeTruthy()
  expect(backend.api).toHaveBeenCalledTimes(1)
  expect(backend.api).toHaveBeenCalledWith(expect.objectContaining({
    connectionId: 'local', profile: 'default', path: '/api/files?path=%2Fworkspace'
  }))
  fireEvent.click(screen.getByRole('button', { name: 'Collapse files in “Origin conversation”' }))
  expect(screen.queryByRole('button', { name: 'report.md' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Expand files in “Origin conversation”' }))
  fireEvent.click(screen.getByRole('button', { name: 'Favorite · report.md' }))
  fireEvent.click(screen.getByRole('button', { name: 'My favorites' }))
  expect(screen.queryByRole('button', { name: 'chart.png' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'report.md' }))
  await waitFor(() => expect($previewTabs.get()).toHaveLength(1))
  expect($previewTabs.get()[0].target.shareOrigin).toMatchObject({ sessionId: 'origin', path: '/workspace/report.md' })
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions · report.md' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  expect(screen.queryByText('Open folder')).toBeNull()
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Download' }))
  await waitFor(() => expect(window.hermesDesktop.saveGatewayFile).toHaveBeenCalledWith(expect.objectContaining({
    path: '/workspace/report.md', sessionId: 'origin', profile: 'default'
  })))
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions · report.md' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Upload to cloud drive' }))
  expect(screen.getByRole('dialog').textContent).toContain('Upload /workspace/report.md from origin')
  fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions · report.md' }), { button: 0, ctrlKey: false, pointerType: 'mouse' })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  expect(screen.getAllByRole('dialog').some(dialog => dialog.textContent?.includes('Share /workspace/report.md from origin'))).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Add to new conversation · report.md' }))
  await waitFor(() => expect(backend.fresh).toHaveBeenCalledWith({ connectionId: 'local', profile: 'default', mode: 'remote' }))
  expect(takeSessionDraft(null).attachments).toEqual([expect.objectContaining({ path: '/workspace/report.md' })])
})

it('收藏和迟到元信息按登录隔离，外部 file 主机与越界失败不伪造有效文件', async () => {
  const file = { resolvedPath: '/workspace/report.md', profile: 'default' } as never
  const key = localFavoriteKey(file)!
  expect(writeLocalFavorites(new Set([key]))).toBe(true)
  login('bob')
  expect(readLocalFavorites().size).toBe(0)
  expect(localFavoriteKey(file)).not.toBe(key)
  login('alice')
  expect(readLocalFavorites().has(key)).toBe(true)
  const resolve = artifactFileResolver()
  expect(await resolve('file://other-server/workspace/report.md')).toBeNull()
  expect(await resolve('https://other-server/report.md')).toBeNull()
  expect(backend.api).not.toHaveBeenCalled()
  let finish!: (value: unknown) => void
  backend.api.mockImplementationOnce(() => new Promise(done => { finish = done }))
  const pending = resolve('/workspace/report.md')
  login('bob')
  finish({ entries: [{ name: 'report.md', path: '/workspace/report.md', is_directory: false }] })
  expect(await pending).toBeNull()
  backend.api.mockRejectedValueOnce(new Error('403: Path outside managed files root'))
  await expect(artifactFileResolver()('/outside/report.md')).rejects.toThrow('403')
  expect(JSON.stringify([...readLocalFavorites()])).not.toContain('credential-')
})
