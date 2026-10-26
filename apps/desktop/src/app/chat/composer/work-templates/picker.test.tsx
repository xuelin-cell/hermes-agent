import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'

import { normalizeWelcomeCatalog } from '../../../../../electron/uniwork-welcome/catalog'

import { $welcomeCatalog, loadWelcomeCatalog } from './catalog-store'
import fixture from './catalog.zh-CN.json'
import { WorkTemplatePicker } from './picker'

const modules = normalizeWelcomeCatalog(fixture)
const defaults = modules[0].tags
afterEach(() => {
  cleanup()
  document.getElementById('selection-host')?.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 用目录样例作为云端响应走分类与模板交互，填写仅进入草稿回调。 */
function view(scope = 'draft-a', disabled = false, replace = vi.fn()) {
  return {
    replace,
    element: (
      <I18nProvider configClient={null} initialLocale="zh">
        <WorkTemplatePicker
          disabled={disabled}
          onReplaceText={replace}
          scope={scope}
          selectionContainer={document.getElementById('selection-host')}
        />
      </I18nProvider>
    )
  }
}

it('完整分类可进入模板，填写完整提示词，取消保留草稿且切换会话清除选择', async () => {
  const request = vi.fn().mockResolvedValue({ modules, version: 'same-version' })
  vi.stubGlobal('hermesDesktop', { getWelcomeCatalog: request })
  await loadWelcomeCatalog('zh-CN', true)
  const selectionHost = document.createElement('div')
  selectionHost.id = 'selection-host'
  document.body.append(selectionHost)
  const v = view()
  const ui = render(v.element)

  for (const category of defaults) {
    expect(screen.getByRole('button', { name: category.name })).toBeTruthy()
  }

  const latestModules = structuredClone(modules)
  const updatedTemplate = latestModules[0].tags.find(item => item.id === 'presentations')!.templates[0]
  updatedTemplate.prompt = '接口最新的完整 prompt，不使用模板名称或旧提示词'
  request.mockResolvedValue({ modules: latestModules, version: 'same-version' })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '幻灯片' }))
  })
  expect(v.replace).toHaveBeenLastCalledWith('')
  const category = defaults.find(item => item.id === 'presentations')!
  const template = category.templates[0]!
  fireEvent.click(screen.getByRole('button', { name: template.name }))
  expect(v.replace).toHaveBeenLastCalledWith(updatedTemplate.prompt)
  expect(selectionHost.textContent).toContain(category.name)
  expect(screen.queryByRole('button', { name: '文档处理' })).toBeNull()
  expect(screen.getByRole('button', { name: template.name })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: '取消所选分类' }))
  expect(v.replace).toHaveBeenLastCalledWith(updatedTemplate.prompt)
  expect(screen.getByRole('button', { name: '文档处理' })).toBeTruthy()
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '深度研究' }))
  })
  ui.rerender(view('draft-b', false, v.replace).element)
  expect(screen.getByRole('button', { name: '文档处理' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: '取消所选分类' })).toBeNull()
})

it('更新失败保留可用目录并支持重试；录音或禁用时不能覆盖草稿', async () => {
  const request = vi.fn().mockResolvedValue({ modules })
  vi.stubGlobal('hermesDesktop', { getWelcomeCatalog: request })
  await loadWelcomeCatalog('zh-CN', true)
  request.mockRejectedValue(new Error('offline'))
  await loadWelcomeCatalog('zh-CN', true)
  const v = view('draft-a', true)
  const ui = render(v.element)
  fireEvent.click(screen.getByRole('button', { name: '幻灯片' }))
  expect(v.replace).not.toHaveBeenCalled()
  expect(screen.getByText('正在使用本地模板')).toBeTruthy()
  ui.rerender(view('draft-a', false, v.replace).element)
  request.mockResolvedValue({ modules })
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: '刷新模板' }))
  })
  expect($welcomeCatalog.get()['zh-CN'].status).toBe('ready')
  expect(screen.queryByText('正在使用本地模板')).toBeNull()
  expect(JSON.parse(localStorage.getItem('uniwork.welcome.modules.v3.zh-CN')!).modules[0].tags).toHaveLength(
    defaults.length
  )
})
