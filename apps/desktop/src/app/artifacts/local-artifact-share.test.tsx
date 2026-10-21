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

it('列表点击先确认分享，生成后可关闭重开管理链接，撤销再次确认', async () => {
  const test = await fixture()
  expect(test.eligibility).not.toHaveBeenCalled()
  openMenu('picture.png')
  await screen.findByRole('menuitem', { name: 'Open folder' })
  expect(screen.queryByRole('menuitem', { name: 'Share' })).toBeNull()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  openMenu('unknown.md')
  await waitFor(() => expect(test.eligibility).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'unknown' })))
  expect(screen.queryByRole('menuitem', { name: 'Share' })).toBeNull()
  fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  await screen.findByRole('dialog', { name: 'Share artifact' })
  const create = await screen.findByRole('button', { name: 'Create public link' })
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false))
  expect(test.request).not.toHaveBeenCalled()
  expect($previewTabs.get()).toHaveLength(0)
  fireEvent.click(create)
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
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Copy shared link' }))
  await waitFor(() =>
    expect(window.hermesDesktop.writeClipboard).toHaveBeenCalledWith(expect.stringContaining('https://share.example/'))
  )
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'View shared page' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'View shared page' }))
  await waitFor(() => expect(window.hermesDesktop.openExternal).toHaveBeenCalled())
  expect(test.request).toHaveBeenCalledTimes(1)
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Revoke shared link' }) as HTMLButtonElement).disabled).toBe(false)
  )
  fireEvent.click(screen.getByRole('button', { name: 'Revoke shared link' }))
  expect(test.request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Revoke shared link' }))
  await screen.findByRole('button', { name: 'Create public link' })
  expect(test.request).toHaveBeenCalledTimes(2)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
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

it('发布失败留在弹窗内重试，撤销后可重新生成链接', async () => {
  const test = await fixture()
  test.request.mockRejectedValueOnce(new Error('Fixture network unavailable'))
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  const create = await screen.findByRole('button', { name: 'Create public link' })
  await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(create)
  await screen.findByRole('alert')
  expect(screen.getByRole('dialog', { name: 'Share artifact' })).toBeTruthy()
  expect($notifications.get().some(item => item.title === 'Published successfully')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Create public link' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Revoke shared link' }))
  fireEvent.click(screen.getByRole('button', { name: 'Revoke shared link' }))
  const again = await screen.findByRole('button', { name: 'Create public link' })
  fireEvent.click(again)
  await screen.findByRole('button', { name: 'Copy shared link' })
  expect(test.publish).toHaveBeenCalledTimes(3)
  expect(test.request).toHaveBeenCalledTimes(4)
})

it('会话发布与 Markdown 预览共享源文件版本，未改文件不提示更新，真正修改后才确认覆盖', async () => {
  const test = await fixture()
  const key = `file:source:${test.filename}`
  const sourceText = await fs.readFile(test.filename, 'utf8')
  const source = { sessionId: 'source', path: test.filename, hash: test.originHash(sourceText) }
  // The model tool renders Markdown in Python; the preview uses React markup.
  const input = { key, title: 'report.md', html: '<h1>Native artifact</h1><p>Verified source.</p>', source }
  const first = await test.service.publish(input)
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  await screen.findByRole('button', { name: 'Copy shared link' })
  expect(screen.queryByText('Replace the published content with this version? The link will stay the same.')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Update shared content' })).toBeNull()
  const same = await test.service.publish({ ...input, html: '<div data-preview-markdown><h1>Native artifact</h1><p>Verified source.</p></div>' })
  expect(same.url).toBe(first.url)
  expect(same.hash).toBe(first.hash)
  expect(same.version).toBe(first.version)
  expect(test.request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Copy shared link' }))
  await waitFor(() => expect(window.hermesDesktop.writeClipboard).toHaveBeenCalledWith(first.url))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Close' })).not.toBeNull())
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  // Re-sharing an unchanged legacy snapshot adds its source fingerprint without uploading.
  const metadata = path.join(root, 'desktop-artifact-shares', `${test.originHash(key)}.json`)
  const legacy = { ...first }
  delete legacy.sourceHash
  await fs.writeFile(metadata, JSON.stringify(legacy))
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  await screen.findByText('Replace the published content with this version? The link will stay the same.')
  const recovery = test.service.publish(input)
  await act(async () => {await recovery})
  const recovered = await recovery
  await screen.findByRole('button', { name: 'Copy shared link' })
  expect(screen.queryByText('Replace the published content with this version? The link will stay the same.')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Close' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(recovered.sourceHash).toBe(source.hash)
  expect(recovered.version).toBe(first.version)
  expect(test.request).toHaveBeenCalledTimes(1)
  const edited = '# Native artifact\n\nChanged source.'
  await fs.writeFile(test.filename, edited)
  test.service.recordOrigin({ sessionId: 'source', profileHome: root, type: 'files', files: [{ path: test.filename, hash: test.originHash(edited), replace: true }] })
  openMenu('report.md')
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Share' }))
  await screen.findByText('Replace the published content with this version? The link will stay the same.')
  expect(test.request).toHaveBeenCalledTimes(1)
  fireEvent.click(screen.getByRole('button', { name: 'Update shared content' }))
  await screen.findByRole('button', { name: 'Copy shared link' })
  const updated = await test.service.inspect(key)
  expect(updated?.shareId).toBe(first.shareId)
  expect(updated?.version).toBe(first.version + 1)
  expect(updated?.sourceHash).toBe(test.originHash(edited))
  expect(test.request).toHaveBeenCalledTimes(2)
})
