import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import type { ArtifactShareEligibility, ArtifactShareSource } from '@hermes/shared/artifact-share'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'

import { $apiRequestScope } from '@/api/client'
import { I18nProvider } from '@/i18n'
import { $notifications, clearNotifications } from '@/store/notifications'
import { $previewTabs } from '@/store/preview'
import { $connection } from '@/store/session'

import { LocalArtifactLibrary } from './local-artifact-library'
import type { LocalArtifactGroup } from './local-artifact-model'

const data = vi.hoisted(() => ({ groups: [] as LocalArtifactGroup[] }))
vi.mock('./use-local-artifacts', () => ({
  useLocalArtifacts: () => ({ ...data, processed: 1, total: 1, failures: 0, scanning: false, refresh: () => {} })
}))
let root: string

afterEach(async () => {
  cleanup()
  clearNotifications()
  $previewTabs.set([])
  $connection.set(null)
  vi.unstubAllGlobals()

  if (root) {
    await fs.rm(root, { recursive: true, force: true })
  }
})

/** 使用真实临时账号与产物来源服务，只有网络上传替换为本地响应。 */
async function fixture() {
  // 主进程模块使用独立的 TS 配置；计算路径加载真实模块，避免纳入 Renderer 编译范围。
  const nativePrefix = '../../../electron/artifact-share/'
  const { ArtifactShareService } = await import(`${nativePrefix}service.ts`)
  const { originHash } = await import(`${nativePrefix}origins.ts`)
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'hermes-artifact-share-ui-'))
  const text = '# Native artifact\n\nVerified source.'
  const filename = path.join(root, 'report.md')
  await fs.writeFile(filename, text)
  const listeners = new Set<(key: string) => void>()

  const request = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    if (options?.method === 'DELETE') {
      return new Response(null, { status: 204 })
    }

    const id = String(url).match(/\/([^/]+)\.html$/)?.[1]

    return Response.json({ shareId: id, url: `https://share.example/${id}.html` })
  })

  const service = new ArtifactShareService({
    identity: () => ({ accountId: 'temporary', home: root, token: 'fixture' }),
    request: request as typeof fetch,
    changed: (key: string) => {
      for (const listener of listeners) {
        listener(key)
      }
    }
  })

  service.recordOrigin({ sessionId: 'source', profileHome: root, type: 'context', fresh: true })
  service.recordOrigin({
    sessionId: 'source',
    profileHome: root,
    type: 'files',
    files: [{ path: filename, hash: originHash(text), replace: true }]
  })
  const eligibility = vi.fn(async (source: ArtifactShareSource) => service.eligibility(source))

  const publish = vi.fn(async (input: Parameters<Window['hermesDesktop']['artifactShare']['publish']>[0]) =>
    service.publish(input)
  )

  vi.stubGlobal('hermesDesktop', {
    readFileText: vi.fn(async (value: string) => ({
      text: await fs.readFile(value, 'utf8'),
      byteSize: (await fs.stat(value)).size
    })),
    writeClipboard: vi.fn().mockResolvedValue(undefined),
    openExternal: vi.fn().mockResolvedValue(undefined),
    artifactShare: {
      eligibility,
      publish,
      inspect: (key: string) => service.inspect(key),
      revoke: (key: string) => service.revoke(key),
      onChanged: (listener: (key: string) => void) => {
        listeners.add(listener)

        return () => listeners.delete(listener)
      }
    }
  })
  data.groups = [
    {
      session: { id: 'source', profile: 'default', title: 'Source' } as never,
      files: ['report.md', 'unknown.md', 'picture.png'].map(label => ({
        id: label,
        label,
        kind: 'file',
        value: label,
        href: label,
        resolvedPath: label === 'report.md' ? filename : path.join(root, label),
        sessionId: label === 'unknown.md' ? 'unknown' : 'source',
        sessionTitle: 'Source',
        profile: 'default',
        connectionId: 'local',
        timestamp: 1
      }))
    }
  ]
  $connection.set({ mode: 'local', profile: 'default' } as never)
  $apiRequestScope.set({ connectionId: 'local', profile: 'default' })
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter>
        <LocalArtifactLibrary />
      </MemoryRouter>
    </I18nProvider>
  )

  return { service, eligibility, publish, request, filename, originHash }
}

/** 菜单按用户点击惰性挂载，测试通过真实控件触发资格读取。 */
function openMenu(name: string): void {
  fireEvent.pointerDown(screen.getByRole('button', { name: `More actions · ${name}` }), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
}

it('未发布只执行发布，成功后仍不展开；再次点击已有链接才展开工具栏', async () => {
  const test = await fixture()
  expect(test.eligibility).not.toHaveBeenCalled()
  openMenu('picture.png')
  await screen.findByRole('menuitem', { name: 'Open folder' })
  expect(screen.queryByRole('menuitem', { name: 'Share' })).toBeNull()
  expect(test.eligibility).not.toHaveBeenCalled()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  openMenu('unknown.md')
  await waitFor(() => expect(test.eligibility).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'unknown' })))
  expect(screen.queryByRole('menuitem', { name: 'Share' })).toBeNull()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  const request = test.request.getMockImplementation()!
  let finish!: () => void

  const gate = new Promise<void>(resolve => {
    finish = resolve
  })

  test.request.mockImplementationOnce(async (...args) => {
    await gate

    return request(...args)
  })
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  await waitFor(() => expect(test.request).toHaveBeenCalledTimes(1))
  expect(screen.queryByRole('toolbar')).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect($previewTabs.get()).toHaveLength(0)
  await act(async () => finish())
  await waitFor(() => expect($notifications.get().some(item => item.title === 'Published successfully')).toBe(true))
  expect(screen.queryByRole('toolbar')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy shared link' })).toBeNull()
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  await screen.findByRole('toolbar', { name: 'Share artifact' })
  await screen.findByRole('button', { name: 'Copy shared link' })
  expect(test.publish).toHaveBeenCalledWith(
    expect.objectContaining({
      source: expect.objectContaining({
        sessionId: 'source',
        path: test.filename,
        hash: test.originHash(await fs.readFile(test.filename))
      })
    })
  )
  expect(test.request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Copy shared link' }))
  await waitFor(() =>
    expect(window.hermesDesktop.writeClipboard).toHaveBeenCalledWith(expect.stringContaining('https://share.example/'))
  )
  fireEvent.click(screen.getByRole('link', { name: 'View shared page' }))
  await waitFor(() =>
    expect(window.hermesDesktop.openExternal).toHaveBeenCalledWith(expect.stringContaining('https://share.example/'))
  )
  fireEvent.keyDown(screen.getByRole('toolbar'), { key: 'Escape' })
  await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull())
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  await screen.findByRole('button', { name: 'Copy shared link' })
  expect(test.publish).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Revoke shared link' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Copy shared link' })).toBeNull())
  expect(test.request).toHaveBeenCalledTimes(2)
  cleanup()
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <MemoryRouter>
        <LocalArtifactLibrary />
      </MemoryRouter>
    </I18nProvider>
  )
  openMenu('report.md')
  await screen.findByRole('menuitem', { name: 'Share' })
  act(() => test.service.markUploaded('source'))
  await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Share' })).toBeNull())
})

it('菜单资格迟到和 Profile 往返不会复活旧分享入口', async () => {
  const test = await fixture()
  let old!: (value: ArtifactShareEligibility) => void
  let fresh!: (value: ArtifactShareEligibility) => void
  test.eligibility
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          old = resolve
        })
    )
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          fresh = resolve
        })
    )
  openMenu('report.md')
  await waitFor(() => expect(old).toBeTypeOf('function'))
  act(() => $apiRequestScope.set({ connectionId: 'local', profile: 'other' }))
  act(() => $apiRequestScope.set({ connectionId: 'local', profile: 'default' }))
  await waitFor(() => expect(fresh).toBeTypeOf('function'))
  await act(async () => old({ publishable: true, reason: null }))
  expect(screen.queryByRole('menuitem', { name: 'Share' })).toBeNull()
  await act(async () => fresh({ publishable: false, reason: null }))
  expect(screen.queryByRole('menuitem', { name: 'Share' })).toBeNull()
})

it('发布失败不展开，列表按钮可重试；撤销后恢复为单纯发布按钮', async () => {
  const test = await fixture()
  test.request.mockRejectedValueOnce(new Error('Fixture network unavailable'))
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  await waitFor(() => expect($notifications.get().some(item => item.kind === 'error')).toBe(true))
  expect($notifications.get().some(item => item.title === 'Published successfully')).toBe(false)
  expect(screen.queryByRole('toolbar')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Copy shared link' })).toBeNull()
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  await waitFor(() => expect($notifications.get().some(item => item.title === 'Published successfully')).toBe(true))
  expect(test.publish).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('toolbar')).toBeNull()
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke shared link' }))
  await waitFor(() => expect(screen.queryByRole('toolbar')).toBeNull())
  expect(test.request).toHaveBeenCalledTimes(3)
  clearNotifications()
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  await waitFor(() => expect($notifications.get().some(item => item.title === 'Published successfully')).toBe(true))
  expect(test.publish).toHaveBeenCalledTimes(3)
  expect(screen.queryByRole('toolbar')).toBeNull()
})
