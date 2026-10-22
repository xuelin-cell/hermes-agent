import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { SessionInfo } from '@/types/hermes'

import { filterLocalArtifacts, localFavoriteKey, localSessionKey } from './local-artifact-model'
import {
  cachedLocalArtifactGroups,
  listLocalArtifactSessions,
  type LocalArtifactCache,
  type LocalArtifactScan,
  scanLocalArtifacts
} from './local-artifact-scan'

const api = vi.hoisted(() => ({ messages: vi.fn(), list: vi.fn(), request: vi.fn() }))
vi.mock('@/hermes', () => ({ getAllSessionMessages: api.messages, listAllProfileSessions: api.list }))
vi.mock('@/api/client', () => ({ hermesApi: api.request }))
let root: string

/** 用真实临时文件验证来源工作区、大小和失效文件，不使用用户资料。 */
beforeEach(async () => {
  vi.clearAllMocks()
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-local-library-'))

  for (const profile of ['a', 'b']) {
    await fs.mkdir(path.join(root, profile))
    await fs.writeFile(path.join(root, profile, 'report.md'), profile.repeat(profile === 'a' ? 3 : 8))
  }

  vi.stubGlobal('hermesDesktop', {
    normalizePreviewTarget: vi.fn(async (value: string, cwd?: string) => {
      try {
        const resolved = await fs.realpath(path.resolve(cwd || root, value))

        const stat = await fs.stat(resolved)

        return stat.isFile() ? { kind: 'file', path: resolved, byteSize: stat.size } : null
      } catch {
        return null
      }
    })
  })
  api.messages.mockResolvedValue({ messages: [{ role: 'assistant', content: 'MEDIA:./report.md', timestamp: 100 }] })
})
afterEach(async () => {
  vi.unstubAllGlobals()
  await fs.rm(root, { recursive: true, force: true })
})

/** 相同会话 ID 在两个 Profile 中仍属于不同扫描及文件来源。 */
function session(profile: string, is_active = false): SessionInfo {
  return {
    id: 'same-id',
    profile,
    connection_id: 'local',
    cwd: path.join(root, profile),
    title: `Task ${profile}`,
    last_active: 10,
    message_count: 2,
    is_active
  } as SessionInfo
}

it('顺序读取 A→B→A 的来源会话，缓存只保留提取结果并重新核对真实文件大小', async () => {
  const cache = new Map<string, LocalArtifactCache>()
  let latest: LocalArtifactScan | undefined
  await scanLocalArtifacts(
    [session('a'), session('b')],
    cache,
    () => true,
    value => {
      latest = value
    }
  )
  expect(api.messages.mock.calls.map(call => call[1])).toEqual([
    { connectionId: 'local', profile: 'a' },
    { connectionId: 'local', profile: 'b' }
  ])
  expect(latest?.groups.map(group => group.files[0].byteSize)).toEqual([3, 8])
  const groups = latest!.groups
  expect(localFavoriteKey(groups[0].files[0])).not.toBe(localFavoriteKey(groups[1].files[0]))
  expect(
    filterLocalArtifacts(groups, 'Task a', 'markdown', false, new Set()).map(group => group.session.profile)
  ).toEqual(['a'])
  expect(filterLocalArtifacts(groups, '', 'pdf', false, new Set())).toEqual([])
  const favorites = new Set([localFavoriteKey(groups[1].files[0])!])
  expect(filterLocalArtifacts(groups, 'report', 'all', true, favorites).map(group => group.session.profile)).toEqual([
    'b'
  ])
  await fs.writeFile(path.join(root, 'a', 'report.md'), 'updated')
  await scanLocalArtifacts(
    [session('a'), session('b')],
    cache,
    () => true,
    value => {
      latest = value
    }
  )
  expect(api.messages).toHaveBeenCalledTimes(2)
  expect(latest?.groups[0].files[0].byteSize).toBe(7)
  await fs.unlink(path.join(root, 'a', 'report.md'))
  await scanLocalArtifacts(
    [session('a'), session('b')],
    cache,
    () => true,
    value => {
      latest = value
    }
  )
  expect(latest?.groups.map(group => group.session.profile)).toEqual(['b'])
  expect(cache.get(localSessionKey(session('a')))).not.toHaveProperty('messages')
})

it('扫描取消后不发布和写缓存；活跃会话及失败读取在下一次刷新可重试', async () => {
  const cache = new Map<string, LocalArtifactCache>()
  const publish = vi.fn()
  let current = true
  api.messages.mockImplementationOnce(async () => {
    current = false

    return { messages: [] }
  })
  await scanLocalArtifacts([session('a')], cache, () => current, publish)
  expect(publish).not.toHaveBeenCalled()
  expect(cache.size).toBe(0)
  api.messages.mockRejectedValueOnce(new Error('temporary'))
  await scanLocalArtifacts([session('a')], cache, () => true, publish)
  expect(publish.mock.lastCall?.[0]).toMatchObject({ failures: 1, scanning: false })
  await scanLocalArtifacts([session('a', true)], cache, () => true, publish)
  await scanLocalArtifacts([session('a', true)], cache, () => true, publish)
  expect(api.messages).toHaveBeenCalledTimes(4)
  expect(cache.size).toBe(1)
  // 会话结束时即使消息计数和时间戳未变，也须重新提取最终交付；随后才能复用。
  await scanLocalArtifacts([session('a')], cache, () => true, publish)
  expect(api.messages).toHaveBeenCalledTimes(5)
  await scanLocalArtifacts([session('a')], cache, () => true, publish)
  expect(api.messages).toHaveBeenCalledTimes(5)
})

it('补齐聚合窗口之外的本机会话，远程来源不冒充本机文件', async () => {
  api.list.mockResolvedValue({
    sessions: [session('a'), { ...session('b'), connection_id: 'ssh' }],
    profile_totals: { a: 2 }
  })
  api.request.mockResolvedValue({ sessions: [session('a'), { ...session('a'), id: 'older' }], limit: 100, total: 2 })
  const result = await listLocalArtifactSessions(() => true)
  expect(result.sessions.map(row => row.id)).toEqual(['same-id', 'older'])
  expect(api.request.mock.calls[0][0]).toMatchObject({
    connectionId: 'local',
    profile: 'a',
    path: expect.stringContaining('archived=include')
  })
})

it('新扫描与提取缓存排除外部链接，保留交付的同名本机文件', async () => {
  const shareId = 'fixture_shared_page_0123456789abcd'
  const publicUrl = `https://demo.tcloudbaseapp.com/uniclaw-shares/${shareId}.html?view=1#page`
  const gatewayUrl = `https://maas.ai-yuanjing.com/app/gateway/uniclaw-shares/${shareId}.html`
  const regularUrl = `https://example.com/previews/${shareId}.html`
  const localDirectory = path.join(root, 'a', 'uniclaw-shares')
  await fs.mkdir(localDirectory)
  const localFile = path.join(localDirectory, shareId + '.html')
  await fs.writeFile(localFile, '<html>Original file</html>')
  api.messages.mockResolvedValue({
    messages: [
      {
        role: 'assistant',
        content: `MEDIA:./report.md\n[公开分享](${publicUrl})\n[普通网页](${regularUrl})\nMEDIA:${localFile}`
      },
      { role: 'tool', tool_name: 'publish', content: JSON.stringify({ artifact_url: gatewayUrl }) }
    ]
  })
  const cache = new Map<string, LocalArtifactCache>()
  const publish = vi.fn()
  await scanLocalArtifacts([session('a')], cache, () => true, publish)
  const values = publish.mock.lastCall![0].groups[0].files.map((file: { value: string }) => file.value)
  expect(new Set(values)).toEqual(new Set(['./report.md', localFile]))
  const stored = cache.get(localSessionKey(session('a')))!
  stored.group.files.push({ ...stored.group.files[0], value: publicUrl, label: shareId + '.html' })
  await scanLocalArtifacts([session('a')], cache, () => true, publish)
  expect(api.messages).toHaveBeenCalledTimes(1)
  expect(cache.get(localSessionKey(session('a')))!.group.files.map(file => file.value)).toEqual(values)
  expect(window.hermesDesktop.normalizePreviewTarget).not.toHaveBeenCalledWith(publicUrl, expect.anything())
})

it('只收录交付引用，忽略制作过程并按原生路径去重，不复用旧提取缓存', async () => {
  const owner = session('a')
  const workspace = owner.cwd!

  for (const name of ['theme.json', 'asset.png', 'deck.pptx', 'final.json', 'final.png']) {
    await fs.writeFile(path.join(workspace, name), name)
  }

  await fs.symlink(path.join(workspace, 'deck.pptx'), path.join(workspace, 'alias.pptx'))
  const cache = new Map<string, LocalArtifactCache>()
  const publish = vi.fn()
  api.messages.mockResolvedValue({
    messages: [
      { role: 'tool', tool_name: 'write_file', content: JSON.stringify({ files_modified: ['./theme.json'] }) },
      {
        role: 'tool',
        tool_name: 'mcp__Toolkit__txt2img_generate',
        content: JSON.stringify({
          local_path: path.join(workspace, 'asset.png'),
          image_url: 'https://example.com/asset.png'
        })
      },
      { role: 'tool', tool_name: 'terminal', content: `MEDIA:${workspace}/asset.png\nhttps://obs.example.com` },
      { role: 'assistant', tool_calls: [{ id: 'still-working' }], content: 'MEDIA:./asset.png' },
      { role: 'assistant', tool_calls: JSON.stringify([{ id: 'legacy-call' }]), content: 'MEDIA:./theme.json' },
      {
        role: 'assistant',
        content: `制作过程在 ${workspace}/theme.json。\n::preview{file="deck.pptx"}\n[下载同一份](#media:${encodeURIComponent(path.join(workspace, 'alias.pptx'))})\n[分享](https://demo.tcloudbaseapp.com/hexagent/shared.html)\nMEDIA:./final.json\nMEDIA:./final.png\nMEDIA:./missing.pdf\nMEDIA:${workspace}\n\n示例：\n\`\`\`text\nMEDIA:./theme.json\n\`\`\``
      },
      { role: 'user', content: 'MEDIA:./asset.png' },
      { role: 'assistant', display_kind: 'hidden', content: 'MEDIA:./asset.png' }
    ]
  })
  await scanLocalArtifacts([owner], cache, () => true, publish)
  const delivered = publish.mock.lastCall![0].groups[0].files
  expect(new Set(delivered.map((file: { resolvedPath: string }) => file.resolvedPath))).toEqual(
    new Set(
      await Promise.all(['deck.pptx', 'final.json', 'final.png'].map(name => fs.realpath(path.join(workspace, name))))
    )
  )
  expect(delivered).toHaveLength(3)
  // 旧策略的缓存即使会话时间戳相同，也必须重新提取，不能回显过程文件。
  const previous = cache.get(localSessionKey(owner))!
  cache.set(localSessionKey(owner), {
    stamp: previous.stamp,
    group: { session: owner, files: [{ ...delivered[0], value: './theme.json' }] }
  })
  expect(cachedLocalArtifactGroups(cache)).toEqual([])
  api.messages.mockResolvedValue({ messages: [] })
  await scanLocalArtifacts([owner], cache, () => true, publish)
  expect(api.messages).toHaveBeenCalledTimes(2)
  expect(publish.mock.lastCall![0].groups).toEqual([])
})
