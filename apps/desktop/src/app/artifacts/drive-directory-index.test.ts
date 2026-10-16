import { expect, it, vi } from 'vitest'

import type { DriveAsset, DrivePage } from '@/api/drive'

import { DriveDirectoryIndex, driveFolderPath, filterDriveFiles } from './drive-directory-index'

/** 构造只含文件身份的测试元信息，父目录由扫描结果确定。 */
function asset(id: string, name: string, kind: DriveAsset['kind'] = 'file'): DriveAsset {
  return { asset_id: id, name, kind }
}

it('短页和不可靠分页标记不截断扫描，搜索覆盖子目录且只保留元信息', async () => {
  const fetchPage = vi.fn(async (parent: string, page: number): Promise<DrivePage> => {
    if (parent === 'root' && page === 1) {
      return { items: [asset('folder', '业务', 'directory')], page: { has_more: false } }
    }

    if (parent === 'root' && page === 2) {
      return { items: [asset('outside', '报告-A.pdf')] }
    }

    if (parent === 'folder' && page === 1) {
      return {
        items: [{ ...asset('nested', '报告-B.pdf'), access_token: 'secret', download_url: 'signed-url' } as DriveAsset]
      }
    }

    return { items: [] }
  })

  const index = new DriveDirectoryIndex('root', fetchPage)
  await index.sync()
  const snapshot = index.getSnapshot()
  expect(snapshot).toMatchObject({ complete: true, scanning: false, error: false })
  expect(filterDriveFiles(snapshot.items, 'root', 'root', '报告').map(row => row.asset_id)).toEqual([
    'outside',
    'nested'
  ])
  expect(filterDriveFiles(snapshot.items, 'root', 'folder', '报告').map(row => row.asset_id)).toEqual(['nested'])
  expect(filterDriveFiles(snapshot.items, 'root', 'root', '').map(row => row.asset_id)).toEqual(['folder', 'outside'])
  expect(driveFolderPath(snapshot.items, 'root', 'folder')).toEqual([{ id: 'folder', name: '业务' }])
  const calls = fetchPage.mock.calls.length
  filterDriveFiles(snapshot.items, 'root', 'root', '报告')
  expect(fetchPage).toHaveBeenCalledTimes(calls)
  expect(JSON.stringify(snapshot)).not.toMatch(/secret|signed-url/)
  index.dispose()
})

it('刷新失败保留已知文件，成功刷新清理失效目录，销毁后不接收旧响应', async () => {
  let phase = 'initial'
  let resolveLate: ((page: DrivePage) => void) | undefined

  const fetchPage = vi.fn(async (parent: string, page: number): Promise<DrivePage> => {
    if (phase === 'late') {
      return new Promise(resolve => {
        resolveLate = resolve
      })
    }

    if (phase === 'failure' && page === 2) {
      throw new Error('Network unavailable')
    }

    if (phase === 'repeated') {
      return { items: [asset('fresh', '新文件')] }
    }

    if (page > 1) {
      return { items: [] }
    }

    if (parent === 'root') {
      return { items: phase === 'initial' ? [asset('folder', '业务', 'directory')] : [asset('fresh', '新文件')] }
    }

    return { items: [asset('old', '旧报告')] }
  })

  const index = new DriveDirectoryIndex('root', fetchPage)
  await index.sync()
  phase = 'failure'
  await index.sync(true)
  expect(index.getSnapshot()).toMatchObject({ complete: false, error: true })
  expect(index.getSnapshot().items.map(row => row.asset_id)).toEqual(expect.arrayContaining(['old', 'fresh']))
  phase = 'repeated'
  const beforeRepeat = fetchPage.mock.calls.length
  await index.sync(true)
  expect(index.getSnapshot()).toMatchObject({ complete: false, error: true })
  expect(fetchPage.mock.calls.length - beforeRepeat).toBe(2)
  phase = 'success'
  await index.sync(true)
  expect(index.getSnapshot().items.map(row => row.asset_id)).toEqual(['fresh'])
  phase = 'late'
  const listener = vi.fn()
  index.subscribe(listener)
  const pending = index.sync(true)
  index.dispose()
  listener.mockClear()
  resolveLate!({ items: [asset('other-account', '迟到文件')] })
  await pending
  expect(index.getSnapshot().items).toEqual([])
  expect(listener).not.toHaveBeenCalled()
})
