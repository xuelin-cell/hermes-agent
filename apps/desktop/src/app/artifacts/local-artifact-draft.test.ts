import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { onComposerDraftRequests } from '@/app/chat/composer/focus'
import { clearSessionDraft, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $activeSessionId, $connection, $selectedStoredSessionId } from '@/store/session'

import { addLocalArtifactDraft } from './local-artifact-draft'
import type { LocalArtifact } from './local-artifact-model'

const newSession = vi.hoisted(() => vi.fn())
vi.mock('@/store/profile', async original => ({
  ...(await original<Record<string, unknown>>()),
  newSessionInAgent: newSession,
  resolveNewChatOwnerRoute: () => null
}))

const file = {
  id: 'file',
  sessionId: 'source',
  connectionId: 'local',
  profile: 'origin',
  value: '/source/report.md',
  resolvedPath: '/source/report.md',
  label: 'report.md',
  kind: 'file'
} as LocalArtifact

let dispose: (() => void) | undefined
beforeEach(() => {
  vi.clearAllMocks()
  clearSessionDraft(null)
  $selectedStoredSessionId.set(null)
  $activeSessionId.set(null)
  $connection.set({ mode: 'local', profile: 'work' } as never)
  $apiRequestScope.set({ connectionId: 'local', profile: 'work' })
  vi.stubGlobal('hermesDesktop', {
    normalizePreviewTarget: vi.fn().mockResolvedValue({ path: file.resolvedPath }),
    api: vi.fn()
  })
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it('只加入新会话草稿，保留正文及附件，重复点击去重，暂不创建会话和上传字节', async () => {
  $selectedStoredSessionId.set('existing-conversation')
  document.body.innerHTML = '<div data-composer-target="main"></div>'
  stashSessionDraft(null, '我的问题', [{ id: 'existing', kind: 'file', label: 'old.txt', path: '/old.txt' }])
  expect(await addLocalArtifactDraft(file, () => true)).toBe(true)
  expect(await addLocalArtifactDraft(file, () => true)).toBe(true)
  const draft = takeSessionDraft(null)
  expect(draft.text).toBe('我的问题')
  expect(draft.attachments.map(item => item.path)).toEqual(['/old.txt', file.resolvedPath])
  expect(draft.attachments[1]).toMatchObject({ kind: 'file', label: 'report.md', occurrenceId: expect.any(String) })
  expect(newSession).toHaveBeenCalledWith({ connectionId: 'local', profile: 'work', mode: 'local' })
  expect(window.hermesDesktop.api).not.toHaveBeenCalled()
})

it('采用实时新草稿，并拒绝迟到结果、丢失文件和远端来源', async () => {
  let text = '实时问题'
  let attachments = [] as ReturnType<typeof takeSessionDraft>['attachments']
  dispose = onComposerDraftRequests(
    { getIds: () => ['__new__'], isActive: () => true },
    {
      read: () => text,
      readAttachments: () => attachments,
      write: (next, files) => {
        text = next
        attachments = files || []

        return true
      }
    }
  )
  stashSessionDraft(null, '过期内容', [])
  expect(await addLocalArtifactDraft(file, () => true)).toBe(true)
  expect(text).toBe('实时问题')
  expect(attachments).toHaveLength(1)
  expect(await addLocalArtifactDraft({ ...file, connectionId: 'ssh' }, () => true)).toBe(false)
  expect(await addLocalArtifactDraft(file, () => false)).toBe(false)
  vi.mocked(window.hermesDesktop.normalizePreviewTarget).mockImplementationOnce(async () => {
    $apiRequestScope.set({ connectionId: 'local', profile: 'other' })

    return { path: file.resolvedPath } as never
  })
  expect(await addLocalArtifactDraft(file, () => true)).toBe(false)
  expect(attachments).toHaveLength(1)
  expect(newSession).toHaveBeenCalledTimes(1)
})

it('图片保留原生图片附件类型，发送时由图片附加链处理', async () => {
  const image = { ...file, resolvedPath: '/source/photo.png', label: 'photo.png' }
  vi.mocked(window.hermesDesktop.normalizePreviewTarget).mockResolvedValueOnce({
    path: image.resolvedPath, previewKind: 'image'
  } as never)
  expect(await addLocalArtifactDraft(image, () => true)).toBe(true)
  expect(takeSessionDraft(null).attachments[0]).toMatchObject({ kind: 'image', path: image.resolvedPath })
  expect(window.hermesDesktop.api).not.toHaveBeenCalled()
})
