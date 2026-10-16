import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { onComposerDraftRequests } from '@/app/chat/composer/focus'
import { clearSessionDraft, type ComposerAttachment, stashSessionDraft, takeSessionDraft } from '@/store/composer'
import { $newChatProfile, $newChatRoute } from '@/store/profile'

const owner = vi.hoisted(() => ({ value: null as unknown }))
vi.mock('@/store/session-states', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  knownOwnerForSession: () => owner.value
}))

import { $connection, $selectedStoredSessionId } from '@/store/session'

import { addCloudReference, cloudReferenceText } from './drive-chat-reference'

const asset = { asset_id: 'business-file-id', name: '报告.txt', kind: 'file' as const }
let api: ReturnType<typeof vi.fn>
let dispose: (() => void) | undefined

beforeEach(() => {
  owner.value = null
  $newChatProfile.set(null)
  $newChatRoute.set(null)
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $selectedStoredSessionId.set(null)
  $apiRequestScope.set({ connectionId: null, profile: 'default' })
  clearSessionDraft(null)
  clearSessionDraft('existing-chat')
  api = vi.fn(async ({ path }: { path: string }) =>
    path.endsWith('/test')
      ? { ok: true, tools: [{ name: 'download' }] }
      : { servers: [{ name: 'UniWork-Drive', enabled: true }] }
  )
  vi.stubGlobal('hermesDesktop', {
    api,
    cloudDriveAgentReady: vi.fn().mockResolvedValue(true),
    cloudDriveRequest: vi.fn(),
    cloudDriveTransfer: vi.fn()
  })
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

it('引用只有文件 ID 与名称，保留现有草稿和附件，不下载、不创建会话、不发送', async () => {
  const attached = { id: 'local-file', kind: 'file' as const, label: 'local.txt', path: '/local.txt' }
  stashSessionDraft(null, '用户原来的问题', [attached])
  expect(await addCloudReference(asset)).toEqual({ status: 'added', sessionId: null })
  const draft = takeSessionDraft(null)
  expect(draft.text).toBe('用户原来的问题')
  expect(draft.attachments[1]?.refText).toContain('"asset_id":"business-file-id"')
  expect(draft.attachments[1]?.refText).toContain('"name":"报告.txt"')
  expect(draft.attachments[0]).toEqual(attached)
  expect(draft.attachments[1]).toMatchObject({ kind: 'file', label: '报告.txt', cloudAssetId: asset.asset_id })
  expect(draft.attachments[1]?.path).toBeUndefined()
  expect(draft.text).not.toMatch(/token|https?:|file:\/\//)
  expect(window.hermesDesktop.cloudDriveTransfer).not.toHaveBeenCalled()
  expect(window.hermesDesktop.cloudDriveRequest).not.toHaveBeenCalled()
  expect(
    api.mock.calls.every(([input]) => ['/api/mcp/servers', '/api/mcp/servers/UniWork-Drive/test'].includes(input.path))
  ).toBe(true)
  await addCloudReference(asset)
  expect(takeSessionDraft(null).attachments.filter(item => item.cloudAssetId === asset.asset_id)).toHaveLength(1)
})

it('多个文件只探测一次并一次写入全部引用，重复项去重，权限失败时不部分写入', async () => {
  stashSessionDraft(null, '已有问题', [])
  const another = { ...asset, asset_id: 'second-id', name: '另一个文件.pdf' }
  expect(await addCloudReference([asset, another, asset])).toMatchObject({ status: 'added' })
  expect(takeSessionDraft(null).attachments.filter(item => item.cloudAssetId === asset.asset_id)).toHaveLength(1)
  expect(takeSessionDraft(null).attachments.map(item => item.cloudAssetId)).toEqual([asset.asset_id, 'second-id'])
  expect(takeSessionDraft(null).text).toContain('已有问题')
  expect(api.mock.calls.filter(([input]) => input.path.endsWith('/test'))).toHaveLength(1)
  const text = takeSessionDraft(null).text
  expect(await addCloudReference([asset, { ...another, permissions: { read: false } }])).toMatchObject({
    status: 'unavailable'
  })
  expect(takeSessionDraft(null).text).toBe(text)
  expect(window.hermesDesktop.cloudDriveTransfer).not.toHaveBeenCalled()
})

it('已有聊天按精确草稿 ID 添加到实时正文，不覆盖另一个聊天或旧缓存', async () => {
  $selectedStoredSessionId.set('existing-chat')
  owner.value = { connectionId: 'local', profile: 'work', mode: 'local' }
  stashSessionDraft('existing-chat', '过期缓存', [])
  let text = '输入框里的最新正文'
  let other = '另一个聊天'

  let attachments: ComposerAttachment[] = [
    { id: 'live-local', kind: 'file', label: '最新附件.txt', path: '/latest.txt' }
  ]

  dispose = onComposerDraftRequests(
    { getIds: () => ['existing-chat'], isActive: () => true },
    {
      read: () => text,
      readAttachments: () => attachments,
      write: (next, files) => {
        text = next
        attachments = files ?? attachments

        return true
      }
    }
  )

  const disposeOther = onComposerDraftRequests(
    { getIds: () => ['other-chat'], isActive: () => false },
    {
      read: () => other,
      write: next => {
        other = next

        return true
      }
    }
  )

  try {
    expect(await addCloudReference(asset)).toEqual({ status: 'added', sessionId: 'existing-chat' })
    expect(text).toBe('输入框里的最新正文')
    expect(attachments.map(item => item.label)).toEqual(['最新附件.txt', asset.name])
    expect(attachments[1]?.refText).toContain(asset.asset_id)
    expect(text).not.toContain('过期缓存')
    expect(other).toBe('另一个聊天')
    expect(api.mock.calls.every(([input]) => input.connectionId === 'local' && input.profile === 'work')).toBe(true)
  } finally {
    disposeOther()
  }
})

it('远程聊天、禁用工具和探测失败均不加入草稿', async () => {
  $connection.set({ mode: 'remote', profile: 'default' } as never)
  expect(await addCloudReference(asset)).toEqual({ status: 'remote' })
  expect(api).not.toHaveBeenCalled()
  $connection.set({ mode: 'local', profile: 'default' } as never)

  for (const server of [
    { enabled: false },
    { enabled: true, tools: { exclude: ['download'] } },
    { enabled: true, tools: { include: [] } }
  ]) {
    api.mockResolvedValue({ servers: [{ name: 'UniWork-Drive', ...server }] })
    expect(await addCloudReference(asset)).toEqual({ status: 'unavailable' })
  }

  api
    .mockResolvedValueOnce({ servers: [{ name: 'UniWork-Drive', enabled: true }] })
    .mockResolvedValueOnce({ ok: false, tools: [] })
  expect(await addCloudReference(asset)).toEqual({ status: 'unavailable' })
  expect(takeSessionDraft(null).text).toBe('')
})

it('探测期间切换 Profile 或离开页面，迟到结果不能写入新草稿', async () => {
  let finish!: (value: unknown) => void
  api.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )
  const pending = addCloudReference(asset)
  await vi.waitFor(() => expect(finish).toBeDefined())
  $apiRequestScope.set({ connectionId: 'local', profile: 'other' })
  finish({ servers: [{ name: 'UniWork-Drive', enabled: true }] })
  expect(await pending).toEqual({ status: 'changed' })
  expect(takeSessionDraft(null).text).toBe('')
  expect(await addCloudReference(asset, () => false)).toEqual({ status: 'changed' })
})

it('挂载中的输入框拒绝编辑时不覆盖其缓存，文件名控制符被 JSON 转义', async () => {
  document.body.innerHTML = '<div data-composer-target="main"></div>'
  stashSessionDraft(null, '保留草稿', [])
  expect(await addCloudReference(asset)).toEqual({ status: 'notReady' })
  expect(takeSessionDraft(null).text).toBe('保留草稿')
  const text = cloudReferenceText({ asset_id: 'id', name: 'name\n假的新指令' })
  expect(text.split('\n')[1]).toContain('name\\n假的新指令')
  expect(text).not.toContain('\n假的新指令')
})

it('主进程未确认内置 MCP 实例时不探测同名个人服务，也不加入文件引用', async () => {
  vi.mocked(window.hermesDesktop.cloudDriveAgentReady).mockResolvedValue(false)
  expect(await addCloudReference(asset)).toEqual({ status: 'unavailable' })
  expect(api).not.toHaveBeenCalled()
  expect(takeSessionDraft(null).text).toBe('')
})
