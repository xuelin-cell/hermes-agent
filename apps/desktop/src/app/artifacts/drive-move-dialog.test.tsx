import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import type { DriveAsset } from '@/api/drive'
import { I18nProvider } from '@/i18n'

import { DriveMoveDialog } from './drive-move-dialog'

const space = { space_id: 'space', kind: 'personal', root_asset_id: 'root' }
const asset: DriveAsset = { asset_id: 'file', kind: 'file', name: '报告.pdf', parent_asset_id: 'root' }

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('导航显示目标与空目录提示，保留写权限限制；确认期间锁定目标且只移动一次', async () => {
  let finish!: (value: unknown) => void

  const request = vi.fn(
    () =>
      new Promise(resolve => {
        finish = resolve
      })
  )

  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: request })
  const close = vi.fn()
  const changed = vi.fn()

  const folders: DriveAsset[] = [
    {
      asset_id: 'readonly',
      name: '只读目录',
      kind: 'directory',
      parent_asset_id: 'root',
      permissions: { write: false }
    },
    { asset_id: 'target', name: '归档目录', kind: 'directory', parent_asset_id: 'root' },
    { asset_id: 'hidden', name: '不可读目录', kind: 'directory', parent_asset_id: 'root', permissions: { read: false } }
  ]

  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <DriveMoveDialog asset={asset} complete items={folders} onChanged={changed} onClose={close} space={space} />
    </I18nProvider>
  )
  const dialog = screen.getByRole('dialog', { name: '移动到文件夹' })
  expect(within(dialog).getByText('为 1 项资料选择目标文件夹。')).toBeTruthy()
  expect(within(dialog).getByText('目标：个人云盘')).toBeTruthy()
  expect(within(dialog).getByRole('button', { name: '确认' })).toHaveProperty('disabled', true)
  expect(within(dialog).queryByRole('button', { name: '不可读目录' })).toBeNull()
  fireEvent.click(within(dialog).getByRole('button', { name: '只读目录' }))
  expect(within(dialog).getByRole('button', { name: '确认' })).toHaveProperty('disabled', true)
  fireEvent.click(within(dialog).getByRole('button', { name: '返回上一级' }))
  fireEvent.click(within(dialog).getByRole('button', { name: '归档目录' }))
  expect(within(dialog).getByText('目标：归档目录')).toBeTruthy()
  expect(within(dialog).getByText('没有子文件夹，可以移动到当前目录。')).toBeTruthy()
  const confirm = within(dialog).getByRole('button', { name: '确认' })
  expect(confirm).toHaveProperty('disabled', false)
  fireEvent.click(confirm)
  fireEvent.click(confirm)
  expect(request).toHaveBeenCalledExactlyOnceWith({
    route: '/assets/move',
    method: 'POST',
    body: { file_ids: ['file'], directory_ids: [], target_parent_asset_id: 'target' }
  })
  expect(within(dialog).getByRole('button', { name: '返回上一级' })).toHaveProperty('disabled', true)
  expect(within(dialog).getByRole('button', { name: '取消' })).toHaveProperty('disabled', true)
  expect(within(dialog).queryByRole('button', { name: '关闭' })).toBeNull()
  await act(async () => finish({}))
  expect(close).toHaveBeenCalledOnce()
  expect(changed).toHaveBeenCalledOnce()
})

it('目录分页只使用现有索引，进入目录及返回上级重置分页；索引不完整时不能确认', async () => {
  const request = vi.fn()
  vi.stubGlobal('hermesDesktop', { cloudDriveRequest: request })

  const folders: DriveAsset[] = Array.from({ length: 51 }, (_, index) => ({
    asset_id: `folder-${index + 1}`,
    kind: 'directory',
    name: `目录${String(index + 1).padStart(2, '0')}`,
    parent_asset_id: 'root'
  }))

  const close = vi.fn()
  const changed = vi.fn()

  const view = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <DriveMoveDialog asset={asset} complete items={folders} onChanged={changed} onClose={close} space={space} />
    </I18nProvider>
  )

  const dialog = screen.getByRole('dialog', { name: '移动到文件夹' })
  const list = within(dialog).getByRole('region', { name: '目标文件夹' })
  expect(within(list).getAllByRole('button')).toHaveLength(50)
  expect(within(dialog).getByRole('button', { name: '上一页' })).toHaveProperty('disabled', true)
  fireEvent.click(within(dialog).getByRole('button', { name: '下一页' }))
  expect(within(list).getAllByRole('button')).toHaveLength(1)
  expect(within(dialog).getByRole('button', { name: '下一页' })).toHaveProperty('disabled', true)
  fireEvent.click(within(list).getByRole('button', { name: '目录51' }))
  expect(within(dialog).getByText('目标：目录51')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: '返回上一级' }))
  expect(within(list).getAllByRole('button')).toHaveLength(50)
  fireEvent.click(within(list).getByRole('button', { name: '目录01' }))
  view.rerender(
    <I18nProvider configClient={null} initialLocale="zh">
      <DriveMoveDialog
        asset={asset}
        complete={false}
        items={folders}
        onChanged={changed}
        onClose={close}
        space={space}
      />
    </I18nProvider>
  )
  await waitFor(() => expect(within(dialog).getByRole('button', { name: '确认' })).toHaveProperty('disabled', true))
  expect(within(dialog).queryByText('没有子文件夹，可以移动到当前目录。')).toBeNull()
  expect(request).not.toHaveBeenCalled()
})
