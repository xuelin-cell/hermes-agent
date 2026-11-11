import { describe, expect, it } from 'vitest'

import type { CustomEndpoint, CustomEndpointsResponse } from '@/types/hermes'

import { buildComposerModelMeta, displayedComposerModel } from './model-meta'

/** 按真实端点接口构造配置，避免测试依赖全局模型目录。 */
function endpoint(id: string, model: string, name = ''): CustomEndpoint {
  return {
    id,
    model,
    models: [model],
    name,
    api_key_preview: null,
    api_mode: 'chat_completions',
    base_url: 'https://example.invalid/v1',
    context_length: 100000,
    discover_models: false,
    has_api_key: false
  }
}

describe('输入框模型元数据', () => {
  it('跨端点保留套餐原始顺序，过滤快速模型，再按接口顺序追加个人模型', () => {
    const deepseek = { provider: 'custom:desktop-mt-maas-a', model: 'deepseek-v4-flash' }
    const fast = { provider: 'custom:desktop-mt-maas-b', model: 'fast' }
    const glm = { provider: 'custom:desktop-mt-maas-a', model: 'glm-5.2' }
    const response = {
      endpoints: [
        endpoint('personal', 'my-model', '我的模型'),
        { ...endpoint('desktop-mt-maas-a', glm.model), models: [glm.model, deepseek.model] },
        endpoint('desktop-mt-maas-b', fast.model),
        endpoint('another', 'another-model')
      ],
      current: { provider: 'custom:personal', model: 'my-model' }
    } as CustomEndpointsResponse

    const catalog = buildComposerModelMeta(response, {}, { models: [deepseek, fast, glm], main: glm, fast })
    expect(catalog.rows.map(row => row.model)).toEqual([deepseek.model, fast.model, glm.model, 'my-model', 'another-model'])
    expect(catalog.selectable.map(row => row.name)).toEqual(['DeepSeek V4 Flash', 'GLM 5.2', '我的模型', 'Another Model'])
    expect(displayedComposerModel(catalog, fast.provider, fast.model)?.model).toBe(fast.model)
    expect(displayedComposerModel(catalog, deepseek.provider, 'retired')?.model).toBe(glm.model)
    expect(displayedComposerModel({ ...catalog, main: undefined }, deepseek.provider, 'retired')?.model).toBe(deepseek.model)
  })

  it('模型级容量优先，未声明时取端点容量；同名不同端点不会混用看图和上限', () => {
    const response = {
      endpoints: [endpoint('a', 'same'), endpoint('b', 'same')],
      current: {}
    } as CustomEndpointsResponse

    const catalog = buildComposerModelMeta(
      response,
      { a: { models: { same: { context_length: 300000, supports_vision: true } } } },
      undefined
    )

    expect(catalog.rows.map(row => [row.contextWindow, row.vision])).toEqual([
      [300000, true],
      [100000, false]
    ])
    expect(displayedComposerModel(catalog, 'custom:b', 'same', true)?.endpointId).toBe('b')
    expect(displayedComposerModel(catalog, '', 'same', true)).toBeUndefined()
  })
})
