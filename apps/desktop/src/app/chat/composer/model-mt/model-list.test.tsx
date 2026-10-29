import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { ModelMenuCloseContext } from '@/app/shell/model-menu-panel'
import { useModelMenuController } from '@/app/shell/use-model-menu-controller'
import { DropdownMenu, DropdownMenuContent } from '@/components/ui/dropdown-menu'
import type { CustomEndpointsResponse } from '@/types/hermes'

import { ComposerModelList } from './model-list'
import { buildComposerModelMeta, type ComposerModelMeta, useComposerModelMeta } from './model-meta'

vi.mock('@/app/shell/use-model-menu-controller', () => ({ useModelMenuController: vi.fn() }))
vi.mock('./model-meta', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useComposerModelMeta: vi.fn()
}))

const select = vi.fn().mockResolvedValue(true)
const applyPreset = vi.fn()
const close = vi.fn()
const current = { model: 'model-a', provider: 'a', effort: '', fast: false }

/** 生成显式配置行，同一模型名在不同端点保留独立身份。 */
function modelRow(id: string): ComposerModelMeta {
  return {
    key: id,
    endpointId: id,
    provider: `custom:${id}`,
    model: `model-${id}`,
    name: `模型 ${id}`,
    contextWindow: 300000,
    vision: true,
    plan: true
  }
}

/** 用真实 Radix 菜单验证点击与搜索，网络元数据保持受控。 */
function show(rows = [modelRow('a'), modelRow('b')], loading = false) {
  vi.mocked(useComposerModelMeta).mockReturnValue({
    rows,
    loading,
    error: false,
    find: (provider, model) =>
      rows.find(row => (row.provider === provider || row.endpointId === provider) && row.model === model)
  })

  return render(
    <MemoryRouter>
      <DropdownMenu open>
        <DropdownMenuContent>
          <ModelMenuCloseContext.Provider value={close}>
            <ComposerModelList onSelectModel={vi.fn()} requestGateway={vi.fn()} />
          </ModelMenuCloseContext.Provider>
        </DropdownMenuContent>
      </DropdownMenu>
    </MemoryRouter>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  select.mockResolvedValue(true)
  current.model = 'model-a'
  current.provider = 'a'
  vi.mocked(useModelMenuController).mockReturnValue({
    activeSessionId: 'session-a',
    defaultEffort: 'medium',
    controller: {
      current,
      select,
      applyPreset,
      presetFor: () => ({ effort: 'high', fast: true }),
      setOptions: vi.fn()
    },
    modelOptions: {
      data: {
        providers: [
          { slug: 'anthropic', name: 'Anthropic', models: ['claude'] },
          {
            slug: 'custom:b',
            name: 'b',
            models: ['model-b'],
            capabilities: { 'model-b': { reasoning: true, fast: false } }
          }
        ]
      }
    }
  } as unknown as ReturnType<typeof useModelMenuController>)
  Element.prototype.scrollIntoView = vi.fn()
})
afterEach(cleanup)

it('只列配置模型而不显示目录中的 Anthropic，当前项按端点和模型打勾', () => {
  show()
  expect(screen.queryByText('Anthropic')).toBeNull()
  expect(screen.getAllByRole('menuitem')).toHaveLength(3)
  expect(screen.getByText('Configure custom model')).toBeTruthy()
  expect(screen.getByText('模型 a').closest('[data-current="true"]')).toBeTruthy()
  expect(screen.getByText('模型 b').closest('[data-current="true"]')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
})

it('成功选择后才按模型能力应用预设，并关闭菜单', async () => {
  show()
  fireEvent.click(screen.getByText('模型 b'))
  await waitFor(() =>
    expect(applyPreset).toHaveBeenCalledWith(
      { effort: 'high', fast: undefined },
      { model: 'model-b', provider: 'custom:b' }
    )
  )
  expect(select).toHaveBeenCalledWith('model-b', 'custom:b')
  expect(select.mock.invocationCallOrder[0]).toBeLessThan(applyPreset.mock.invocationCallOrder[0])
  expect(close).toHaveBeenCalledOnce()
})

it('选择失败不应用预设或关闭菜单', async () => {
  select.mockResolvedValue(false)
  show()
  fireEvent.click(screen.getByText('模型 b'))
  await waitFor(() => expect(select).toHaveBeenCalledOnce())
  expect(applyPreset).not.toHaveBeenCalled()
  expect(close).not.toHaveBeenCalled()
})

it.each([
  ['desktop-mt-maas-plan', 'glm-5.2', 'GLM 5.2'],
  ['desktop-mt-maas-plan', 'deepseek-v4-flash', 'DeepSeek V4 Flash'],
  ['desktop-mt-maas-plan', 'deepseek-v4.1-flash', 'DeepSeek V4.1 Flash'],
  ['personal', 'my-model', '我的模型']
])('点击 %s 的 %s 时展示 %s，提交原始模型 ID 和提供方', async (id, model, name) => {
  const response: CustomEndpointsResponse = {
    endpoints: [
      {
        id,
        model,
        models: [model],
        name,
        api_key_preview: null,
        api_mode: 'chat_completions',
        base_url: 'https://models.invalid/v1',
        context_length: 100000,
        discover_models: false,
        has_api_key: false
      }
    ],
    current: { model, provider: `custom:${id}`, base_url: 'https://models.invalid/v1' }
  }

  current.model = ''
  show(buildComposerModelMeta(response, {}, []))
  fireEvent.click(screen.getByText(name))
  await waitFor(() => expect(select).toHaveBeenCalledWith(model, `custom:${id}`))
  expect(applyPreset).toHaveBeenCalledWith(expect.anything(), { model, provider: `custom:${id}` })
})

it('八项不显示搜索，九项可按名字或模型标识筛选并显示无匹配提示', () => {
  current.model = ''
  const { unmount } = show(Array.from({ length: 8 }, (_, i) => modelRow(String(i))))
  expect(screen.queryByRole('textbox')).toBeNull()
  unmount()
  show(Array.from({ length: 9 }, (_, i) => modelRow(String(i))))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'model-8' } })
  expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  expect(screen.getByText('模型 8')).toBeTruthy()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: '不存在' } })
  expect(screen.getByText('No models found')).toBeTruthy()
})

it('加载和空列表使用禁用说明行，当前模型不在配置时补到首行', () => {
  current.model = ''
  const loading = show([], true)
  expect(screen.getByText('Loading models…').getAttribute('aria-disabled')).toBe('true')
  loading.unmount()
  const empty = show([])
  expect(screen.getByText('No models available').getAttribute('aria-disabled')).toBe('true')
  empty.unmount()
  current.model = 'missing-model'
  current.provider = 'missing'
  show()
  expect(screen.getAllByRole('menuitem')[0].getAttribute('data-current')).toBe('true')
  expect(screen.getAllByRole('menuitem')[0].textContent).toContain('Missing Model')
})
