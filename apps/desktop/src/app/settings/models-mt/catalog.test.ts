import { describe, expect, it } from 'vitest'

import type { CustomEndpoint } from '@/types/hermes'

import {
  configPatch,
  currentRowKey,
  draftChanged,
  draftProblem,
  endpointKind,
  endpointWrite,
  type ModelRow,
  newDraft,
  newEndpointId,
  orderRows,
  PLAN_KEY_ENV,
  rowsFromEndpoints,
  YUANJING_FALLBACK_URL
} from './catalog'
import { prettifyModelId } from './model-name'

const PLAN_ID = `desktop-mt-maas-${'a'.repeat(64)}`
const PLAN_URL = 'https://maas-api.example.com/plan/v1'

function endpoint(overrides: Partial<CustomEndpoint>): CustomEndpoint {
  return {
    api_key_preview: null,
    api_mode: 'chat_completions',
    base_url: 'https://api.example.com/v1',
    context_length: null,
    discover_models: false,
    has_api_key: false,
    id: 'x',
    model: 'm',
    models: ['m'],
    name: 'X',
    ...overrides
  }
}

const plan = endpoint({
  api_key_preview: `\${${PLAN_KEY_ENV}}`,
  base_url: PLAN_URL,
  has_api_key: true,
  id: PLAN_ID,
  model: 'deepseek-v4-flash',
  models: ['deepseek-v4-flash', 'glm-5.2'],
  name: 'MaaS · deepseek-v4-flash'
})

const gpt = endpoint({
  api_key_preview: '${CUSTOM_MY_GPT_API_KEY}',
  base_url: 'https://api.openai.com/v1',
  context_length: 128000,
  has_api_key: true,
  id: 'my-gpt',
  model: 'gpt-4.1',
  models: ['gpt-4.1'],
  name: 'My GPT'
})

describe('models-mt catalog', () => {
  it('认出服务商：套餐与引用套餐 Key 的是元景，Anthropic 看接口类型，OpenAI 看域名', () => {
    expect(endpointKind(plan)).toBe('yuanjing')
    expect(endpointKind(endpoint({ api_key_preview: `\${${PLAN_KEY_ENV}}` }))).toBe('yuanjing')
    expect(endpointKind(endpoint({ api_mode: 'anthropic_messages' }))).toBe('anthropic')
    expect(endpointKind(gpt)).toBe('openai')
    expect(endpointKind(endpoint({ base_url: 'not a url' }))).toBe('compatible')
  })

  it('套餐提供方按模型展开为只读行，自定义提供方一行，并读出看图开关', () => {
    const rows = rowsFromEndpoints([plan, gpt], { 'my-gpt': { models: { 'gpt-4.1': { supports_vision: true } } } })

    expect(rows.map(row => [row.key, row.plan, row.draft.displayName])).toEqual([
      [`plan:${PLAN_ID}:deepseek-v4-flash`, true, 'DeepSeek V4 Flash'],
      [`plan:${PLAN_ID}:glm-5.2`, true, 'GLM 5.2'],
      ['custom:my-gpt', false, 'My GPT']
    ])
    expect(rows[2].draft).toMatchObject({ contextWindow: '128000', hasOwnKey: true, kind: 'openai', vision: true })
    expect(rows[0].draft.hasOwnKey).toBe(false)
  })

  it('默认模型排第一，其余按保存的顺序，认得 custom: 前缀', () => {
    const rows = rowsFromEndpoints([plan, gpt])
    const key = currentRowKey(rows, { base_url: '', model: 'glm-5.2', provider: `custom:${PLAN_ID}` })

    expect(key).toBe(`plan:${PLAN_ID}:glm-5.2`)
    expect(orderRows(rows, ['custom:my-gpt'], key).map(row => row.key)).toEqual([
      `plan:${PLAN_ID}:glm-5.2`,
      'custom:my-gpt',
      `plan:${PLAN_ID}:deepseek-v4-flash`
    ])
    expect(currentRowKey(rows, { base_url: '', model: 'other', provider: 'anthropic' })).toBeNull()
  })

  it('新建元景模型默认用套餐端点，并只写套餐 Key 的引用', () => {
    const row: ModelRow = {
      draft: { ...newDraft('yuanjing', PLAN_URL), model: 'glm-5.2' },
      endpointId: 'uw-00000001',
      key: 'new:uw-00000001',
      plan: false
    }

    expect(row.draft.baseUrl).toBe(PLAN_URL)
    expect(newDraft('yuanjing', undefined).baseUrl).toBe(YUANJING_FALLBACK_URL)

    const write = endpointWrite(row)

    expect(write.payload).toMatchObject({
      api_mode: 'chat_completions',
      base_url: PLAN_URL,
      context_length: 200000,
      id: 'uw-00000001',
      make_default: false,
      model: 'glm-5.2',
      name: 'GLM 5.2'
    })
    expect(write.payload.api_key).toBeUndefined()
    expect(write.keyEnv).toBe(PLAN_KEY_ENV)
    expect(write.vision).toBeUndefined()
  })

  it('自有密钥换成元景时清掉原密钥；元景换成别家又没填密钥时去掉套餐引用', () => {
    const [custom] = rowsFromEndpoints([gpt])
    const toYuanjing = endpointWrite({ ...custom, draft: { ...custom.draft, kind: 'yuanjing' } })

    expect(toYuanjing.payload.api_key).toBe('')
    expect(toYuanjing.keyEnv).toBe(PLAN_KEY_ENV)

    const [yj] = rowsFromEndpoints([endpoint({ api_key_preview: `\${${PLAN_KEY_ENV}}`, has_api_key: true, id: 'yj' })])
    const toOpenAi = endpointWrite({ ...yj, draft: { ...yj.draft, kind: 'openai' } })

    expect(toOpenAi.payload.api_key).toBe('')
    expect(toOpenAi.keyEnv).toBeUndefined()

    const typed = endpointWrite({ ...custom, draft: { ...custom.draft, apiKey: ' sk-new ' } })

    expect(typed.payload.api_key).toBe('sk-new')

    const untouched = endpointWrite({ ...custom, draft: { ...custom.draft, displayName: 'Renamed' } })

    expect(untouched.payload.api_key).toBeUndefined()
  })

  it('看图开关只在改动时写进局部配置', () => {
    const [custom] = rowsFromEndpoints([gpt])
    const write = endpointWrite({ ...custom, draft: { ...custom.draft, vision: true } })

    expect(configPatch([{ endpointId: 'my-gpt', write }])).toEqual({
      providers: { 'my-gpt': { models: { 'gpt-4.1': { supports_vision: true } } } }
    })
    expect(configPatch([{ endpointId: 'my-gpt', write: endpointWrite(custom) }])).toBeNull()
  })

  it('未改的行不算改动；必填项缺失时给出原因', () => {
    const [custom] = rowsFromEndpoints([gpt])

    expect(draftChanged(custom)).toBe(false)
    expect(draftChanged({ ...custom, draft: { ...custom.draft, contextWindow: '1' } })).toBe(true)
    expect(draftProblem({ ...custom.draft, model: ' ' })).toBe('model')
    expect(draftProblem({ ...custom.draft, baseUrl: 'ftp://x' })).toBe('baseUrl')
    expect(draftProblem(custom.draft)).toBeNull()
  })

  it('新建标识只含服务端不会改写的字符；显示名按 UniWork 规则美化', () => {
    expect(newEndpointId(() => 0.5)).toMatch(/^uw-[0-9a-f]{8}$/)
    expect(prettifyModelId('deepseek-v4.1-flash')).toBe('DeepSeek V4.1 Flash')
    expect(prettifyModelId('qwen/qwen3-235b-a22b:free')).toBe('Qwen3 235B A22B (free)')
  })
})

it('round trips thinking and all input modalities without storing the API key in metadata', () => {
  const [row] = rowsFromEndpoints([gpt])
  const draft = { ...row.draft, thinking: 'off' as const, modalities: ['audio', 'pdf'], apiKey: 'secret' }
  const patch = configPatch([{ endpointId: row.endpointId, write: endpointWrite({ ...row, draft }) }])!
  const [restored] = rowsFromEndpoints([gpt], patch.providers)
  expect(restored.draft.thinking).toBe(draft.thinking)
  expect(restored.draft.modalities).toEqual(draft.modalities)
  expect(JSON.stringify(patch)).not.toContain(draft.apiKey)
})
