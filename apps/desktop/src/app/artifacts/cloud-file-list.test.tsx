import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { DriveAsset } from '@/api/drive'
import { I18nProvider } from '@/i18n'
import { fmtDateTime } from '@/lib/time'

import { cloudFileModified, cloudFileSize, sortCloudFiles } from './cloud-file-metadata'
import { CloudLibrary } from './cloud-library'

const files: DriveAsset[] = [
  {
    asset_id: 'new',
    name: 'report10.txt',
    kind: 'file',
    parent_asset_id: 'root',
    size_bytes: 2048,
    modified_at: '2026-10-16T09:00:00+08:00'
  },
  {
    asset_id: 'old',
    name: 'report2.txt',
    kind: 'file',
    parent_asset_id: 'root',
    size_bytes: 0,
    modified_at: '2026-10-15T09:00:00+08:00'
  },
  {
    asset_id: 'unknown',
    name: 'unknown.txt',
    kind: 'file',
    parent_asset_id: 'root',
    size_bytes: null,
    modified_at: null
  },
  { asset_id: 'directory', name: 'projects', kind: 'directory', parent_asset_id: 'root' }
]

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('排序不改变缓存，默认保留服务顺序，文件夹优先且未知时间在升降序均置后', () => {
  const original = [...files]
  expect(sortCloudFiles(files, 'default').map(item => item.asset_id)).toEqual(['directory', 'new', 'old', 'unknown'])
  expect(sortCloudFiles(files, 'desc').map(item => item.asset_id)).toEqual(['directory', 'new', 'old', 'unknown'])
  expect(sortCloudFiles(files, 'asc').map(item => item.asset_id)).toEqual(['directory', 'old', 'new', 'unknown'])
  expect(files).toEqual(original)
  expect(cloudFileSize(files[1])).toBe('0 B')
  expect(cloudFileSize({ ...files[1], size_bytes: NaN })).toBe('—')
  expect(cloudFileModified({ ...files[1], modified_at: 'invalid' })).toBe('—')
})

it('面包屑行切换时间排序并恢复默认顺序，不重读网络且清除旧选择', async () => {
  const request = vi.fn(async ({ route }: { route: string }) => {
    if (route === '/asset-spaces') {
      return { items: [{ space_id: 'space', root_asset_id: 'root', kind: 'personal' }] }
    }

    if (route === '/drive/capabilities') {
      return { create_folder: true, rename: true, trash: true, download: true }
    }

    if (route.endsWith('/usage')) {
      return { used_bytes: 2048, total_bytes: 4096 }
    }

    const query = new URLSearchParams(route.split('?')[1])

    return {
      items:
        query.get('parent_asset_id') === 'root' && query.get('page_no') === '1'
          ? [files[1], files[2], files[0], files[3]]
          : []
    }
  })

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: request })
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <CloudLibrary />
    </I18nProvider>
  )
  await screen.findByRole('group', { name: 'report10.txt' })
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false)
  )
  expect(screen.getByText('2 KB')).toBeTruthy()
  expect(screen.getByText(fmtDateTime.format(new Date(files[0].modified_at!)))).toBeTruthy()
  const calls = request.mock.calls.length

  // 只从真实文件行读取顺序，不依赖布局类名或实现源码。
  const order = () =>
    screen
      .getAllByRole('group')
      .map(row => row.getAttribute('aria-label'))
      .filter(name => files.some(file => file.name === name))

  expect(order()).toEqual(['projects', 'report2.txt', 'unknown.txt', 'report10.txt'])
  expect(screen.queryByRole('button', { name: 'File name' })).toBeNull()
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select report2.txt' }))
  expect(
    (screen.getByRole('checkbox', { name: 'Select report2.txt' }) as HTMLButtonElement).getAttribute('aria-checked')
  ).toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Modified time' }))
  expect(order()).toEqual(['projects', 'report10.txt', 'report2.txt', 'unknown.txt'])
  expect(screen.getByRole('checkbox', { name: 'Select report2.txt' }).getAttribute('aria-checked')).toBe('false')
  fireEvent.click(screen.getByRole('button', { name: 'Modified time' }))
  expect(order()).toEqual(['projects', 'report2.txt', 'report10.txt', 'unknown.txt'])
  fireEvent.click(screen.getByRole('button', { name: 'Modified time' }))
  expect(order()).toEqual(['projects', 'report2.txt', 'unknown.txt', 'report10.txt'])
  expect(screen.getByRole('button', { name: 'Modified time' }).getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: 'Modified time' }).getAttribute('aria-description')).toBe('Default order')
  expect(request).toHaveBeenCalledTimes(calls)
})
