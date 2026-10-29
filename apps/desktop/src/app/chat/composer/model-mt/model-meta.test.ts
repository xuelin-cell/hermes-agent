import { describe, expect, it } from 'vitest'

import type { CustomEndpoint, CustomEndpointsResponse } from '@/types/hermes'

import { buildComposerModelMeta } from './model-meta'

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
  it('默认模型最先、其余按保存顺序，套餐名美化且个人显示名优先', () => {
    const response = {
      endpoints: [
        endpoint('desktop-mt-maas-a', 'deepseek-v4-flash', '忽略套餐端点名'),
        endpoint('personal', 'my-model', '我的模型'),
        endpoint('another', 'glm-5.2')
      ],
      current: { provider: 'custom:personal', model: 'my-model' }
    } as CustomEndpointsResponse

    const rows = buildComposerModelMeta(response, {}, ['custom:another', 'plan:desktop-mt-maas-a:deepseek-v4-flash'])
    expect(rows.map(row => row.key)).toEqual([
      'custom:personal',
      'custom:another',
      'plan:desktop-mt-maas-a:deepseek-v4-flash'
    ])
    expect(rows.map(row => row.name)).toEqual(['我的模型', 'GLM 5.2', 'DeepSeek V4 Flash'])
    expect(rows.map(row => row.model)).toEqual(['my-model', 'glm-5.2', 'deepseek-v4-flash'])
    expect(rows[0].provider).toBe('custom:personal')
  })

  it('模型级容量优先，未声明时取端点容量；同名不同端点不会混用看图和上限', () => {
    const response = {
      endpoints: [endpoint('a', 'same'), endpoint('b', 'same')],
      current: {}
    } as CustomEndpointsResponse

    const rows = buildComposerModelMeta(
      response,
      { a: { models: { same: { context_length: 300000, supports_vision: true } } } },
      []
    )

    expect(rows.map(row => [row.contextWindow, row.vision])).toEqual([
      [300000, true],
      [100000, false]
    ])
  })
})
