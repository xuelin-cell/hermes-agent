import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { $welcomeCatalog, loadWelcomeCatalog } from '@/app/chat/composer/work-templates/catalog-store'
import { WorkTemplatePicker } from '@/app/chat/composer/work-templates/picker'
import { I18nProvider } from '@/i18n'
import { $interfaceMode, setInterfaceMode } from '@/store/interface-mode'

import { normalizeWelcomeCatalog } from '../../../electron/uniwork-welcome/catalog'

import { WorkspaceCategoryTabs } from './workspace-category-tabs'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const modules = normalizeWelcomeCatalog({
  modules: [
    {
      id: 'duplicate',
      name: '研习',
      sort: 30,
      tags: [
        {
          id: 'shared',
          name: '学习分类',
          enabled: false,
          templates: [{ id: 'same', name: '学习模板', prompt: '学习提示词', enabled: false }]
        }
      ]
    },
    { id: 'duplicate', name: '代码开发', workspace: 'work', sort: 20, tags: [] },
    {
      name: '事务',
      sort: 10,
      tags: [
        {
          id: 'shared',
          name: '办公分类',
          enabled: false,
          templates: [{ id: 'same', name: '办公模板', prompt: '办公提示词', enabled: false }]
        }
      ]
    }
  ]
})

it('uses fetched module names and routing and switches templates without carrying selection across modules', async () => {
  vi.stubGlobal('hermesDesktop', { getWelcomeCatalog: vi.fn().mockResolvedValue({ modules }) })
  await loadWelcomeCatalog('zh-CN', true)
  const replace = vi.fn()
  render(
    <I18nProvider configClient={null} initialLocale="zh">
      <WorkspaceCategoryTabs />
      <WorkTemplatePicker disabled={false} onReplaceText={replace} scope="draft" />
    </I18nProvider>
  )

  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(modules.map(module => module.name))
  fireEvent.click(screen.getByRole('tab', { name: '事务' }))
  expect($interfaceMode.get()).toBe('simple')
  fireEvent.click(screen.getByRole('button', { name: '办公分类' }))
  fireEvent.click(screen.getByRole('button', { name: '办公模板' }))
  expect(replace).toHaveBeenLastCalledWith('办公提示词')

  fireEvent.click(screen.getByRole('tab', { name: '研习' }))
  expect($interfaceMode.get()).toBe('simple')
  expect(screen.queryByRole('button', { name: '办公分类' })).toBeNull()
  expect(screen.queryByRole('button', { name: '取消所选分类' })).toBeNull()
  expect(replace).toHaveBeenLastCalledWith('办公提示词')
  fireEvent.click(screen.getByRole('button', { name: '学习分类' }))
  fireEvent.click(screen.getByRole('button', { name: '学习模板' }))
  expect(replace).toHaveBeenLastCalledWith('学习提示词')

  // Match hexagent: the explicit module selection owns its workspace, not vice versa.
  act(() => setInterfaceMode('advanced'))
  expect(screen.getByRole('tab', { name: '研习' }).getAttribute('aria-selected')).toBe('true')
  expect($interfaceMode.get()).toBe('simple')

  fireEvent.click(screen.getByRole('tab', { name: '代码开发' }))
  expect($interfaceMode.get()).toBe('advanced')
  expect(screen.queryByRole('button', { name: '学习分类' })).toBeNull()
})

it('navigates only configured tabs with the keyboard and removes tabs and templates for an empty refresh', async () => {
  const request = vi.fn().mockResolvedValue({ modules })
  vi.stubGlobal('hermesDesktop', { getWelcomeCatalog: request })
  await loadWelcomeCatalog('zh-CN', true)

  const { container } = render(
    <I18nProvider configClient={null} initialLocale="zh">
      <WorkspaceCategoryTabs />
      <WorkTemplatePicker disabled={false} onReplaceText={vi.fn()} scope="draft" />
    </I18nProvider>
  )

  fireEvent.keyDown(screen.getByRole('tab', { name: '事务' }), { key: 'End' })
  expect(container.ownerDocument.activeElement).toBe(screen.getByRole('tab', { name: '研习' }))
  fireEvent.keyDown(screen.getByRole('tab', { name: '研习' }), { key: 'ArrowLeft' })
  expect(container.ownerDocument.activeElement).toBe(screen.getByRole('tab', { name: '代码开发' }))
  expect($interfaceMode.get()).toBe('advanced')

  // A renderer hot reload may still talk to an older main process returning tags.
  request.mockResolvedValue(modules[0].tags)
  await act(() => loadWelcomeCatalog('zh-CN', true))
  expect($welcomeCatalog.get()['zh-CN'].status).toBe('cached')
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(modules.map(module => module.name))

  request.mockResolvedValue({ modules: [] })
  await act(() => loadWelcomeCatalog('zh-CN', true))
  expect($welcomeCatalog.get()['zh-CN'].status).toBe('cached')
  expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(modules.map(module => module.name))
})
