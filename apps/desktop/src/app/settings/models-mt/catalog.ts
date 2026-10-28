import type {
  CustomEndpoint,
  CustomEndpointApiMode,
  CustomEndpointsResponse,
  CustomEndpointUpdate
} from '@/types/hermes'

import { prettifyModelId } from './model-name'

/** 套餐模型 Key 所在的环境变量，登录时由主进程按套餐重写。 */
export const PLAN_KEY_ENV = 'DESKTOP_MT_MAAS_API_KEY'
const PLAN_PROVIDER_PREFIX = 'desktop-mt-maas-'
const PLAN_KEY_REF = `\${${PLAN_KEY_ENV}}`
export const ORDER_KEY = 'uniwork.desktop.models.order.v1'

/** 列表顺序按 Profile 保存在本账号浏览器分区，读取失败时使用自然顺序。 */
export function readOrder(profile: string | undefined): string[] {
  try {
    const raw = window.localStorage.getItem(`${ORDER_KEY}:${profile ?? ''}`)
    const parsed: unknown = raw ? JSON.parse(raw) : []

    return Array.isArray(parsed) ? parsed.filter((key): key is string => typeof key === 'string') : []
  } catch {
    return []
  }
}

/** 没有套餐提供方可参照时的元景地址；套餐 Key 只在 my-plan 给的端点有效，优先用套餐的。 */
export const YUANJING_FALLBACK_URL = 'https://maas-api.ai-yuanjing.com/openapi/compatible-mode/v1'

export type ProviderKind = 'anthropic' | 'compatible' | 'openai' | 'yuanjing'

export const PROVIDER_KINDS: readonly ProviderKind[] = ['openai', 'anthropic', 'yuanjing', 'compatible']

export const PROVIDER_LABEL: Record<ProviderKind, string> = {
  anthropic: 'Anthropic',
  compatible: 'OpenAI-Compatible',
  openai: 'OpenAI',
  yuanjing: 'YuanJing'
}

const PRESET_URL: Record<Exclude<ProviderKind, 'yuanjing'>, string> = {
  anthropic: 'https://api.anthropic.com',
  compatible: '',
  openai: 'https://api.openai.com/v1'
}

const PRESET_API_MODE: Record<ProviderKind, CustomEndpointApiMode> = {
  anthropic: 'anthropic_messages',
  compatible: 'chat_completions',
  openai: 'chat_completions',
  yuanjing: 'chat_completions'
}

/** 自定义模型的可编辑字段；只放 Hermes 实际生效的项。 */
export interface ModelDraft {
  /** 新输入的密钥；空串表示没改（元景模型不用）。 */
  apiKey: string
  baseUrl: string
  contextWindow: string
  displayName: string
  hasOwnKey: boolean
  kind: ProviderKind
  model: string
  vision: boolean
  thinking?: 'auto' | 'on' | 'off'
  modalities?: string[]
}

export interface ModelRow {
  /** 套餐模型或用户自定义模型在 `providers` 下的标识。 */
  endpointId: string
  /** 列表里的稳定键：套餐 `plan:<id>:<model>`，自定义 `custom:<id>`，新建 `new:<id>`。 */
  key: string
  /** 读入时的状态；新建的为 undefined。 */
  original?: ModelDraft
  plan: boolean
  draft: ModelDraft
}

export function isPlanEndpoint(endpoint: Pick<CustomEndpoint, 'id'>): boolean {
  return endpoint.id.startsWith(PLAN_PROVIDER_PREFIX)
}

/** 按接口类型、地址和密钥引用认出服务商；认不出的归入 OpenAI-Compatible。 */
export function endpointKind(
  endpoint: Pick<CustomEndpoint, 'api_key_preview' | 'api_mode' | 'base_url' | 'id'>
): ProviderKind {
  if (isPlanEndpoint(endpoint) || endpoint.api_key_preview === PLAN_KEY_REF) {
    return 'yuanjing'
  }

  if (endpoint.api_mode === 'anthropic_messages') {
    return 'anthropic'
  }

  try {
    if (new URL(endpoint.base_url).hostname === 'api.openai.com') {
      return 'openai'
    }
  } catch {
    // 地址不合法时按兼容服务处理，保存前会再校验。
  }

  return 'compatible'
}

/** 从原始配置里读 `providers.<id>.models.<model>.supports_vision`；没写过就是 false。 */
function visionOf(providers: unknown, endpointId: string, model: string): boolean {
  if (!providers || typeof providers !== 'object') {
    return false
  }

  const entry = (providers as Record<string, unknown>)[endpointId]
  const models = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).models : undefined
  const row = models && typeof models === 'object' ? (models as Record<string, unknown>)[model] : undefined

  return Boolean(row && typeof row === 'object' && (row as Record<string, unknown>).supports_vision === true)
}

/** 套餐提供方展开成一行一个模型（只读）；其余提供方一行一个，按其当前模型显示。 */
export function rowsFromEndpoints(endpoints: readonly CustomEndpoint[], providers?: unknown): ModelRow[] {
  const rows: ModelRow[] = []

  for (const endpoint of endpoints) {
    const kind = endpointKind(endpoint)

    const meta = (
      providers as
        Record<string, { desktop_thinking?: ModelDraft['thinking']; input_modalities?: string[] }> | undefined
    )?.[endpoint.id]

    const base: Omit<ModelDraft, 'displayName' | 'model' | 'vision'> = {
      apiKey: '',
      baseUrl: endpoint.base_url,
      contextWindow: endpoint.context_length ? String(endpoint.context_length) : '',
      hasOwnKey: endpoint.has_api_key && endpoint.api_key_preview !== PLAN_KEY_REF,
      kind,
      thinking: meta?.desktop_thinking ?? 'auto',
      modalities: meta?.input_modalities ?? ['text', ...(visionOf(providers, endpoint.id, endpoint.model) ? ['image'] : [])]
    }

    if (isPlanEndpoint(endpoint)) {
      const models = endpoint.models.length ? endpoint.models : [endpoint.model]

      for (const model of models.filter(Boolean)) {
        const draft = {
          ...base,
          displayName: prettifyModelId(model),
          model,
          vision: visionOf(providers, endpoint.id, model)
        }

        rows.push({ draft, endpointId: endpoint.id, key: `plan:${endpoint.id}:${model}`, original: draft, plan: true })
      }

      continue
    }

    const draft = {
      ...base,
      displayName: endpoint.name,
      model: endpoint.model,
      vision: visionOf(providers, endpoint.id, endpoint.model)
    }

    rows.push({ draft, endpointId: endpoint.id, key: `custom:${endpoint.id}`, original: draft, plan: false })
  }

  return rows
}

/** `model.provider` 可能写成 `custom:<id>` 或裸 id，统一后比较。 */
export function providerIdOf(provider: string): string {
  return provider
    .trim()
    .replace(/^custom:/i, '')
    .toLowerCase()
}

/** 找到当前默认模型对应的行；对不上（例如默认是别的内置提供方）返回 null。 */
export function currentRowKey(
  rows: readonly ModelRow[],
  current: CustomEndpointsResponse['current'] | undefined
): null | string {
  if (!current?.provider) {
    return null
  }

  const provider = providerIdOf(current.provider)

  const row = rows.find(
    candidate => candidate.endpointId.toLowerCase() === provider && candidate.draft.model === current.model
  )

  return (
    row?.key ?? rows.find(candidate => !candidate.plan && candidate.endpointId.toLowerCase() === provider)?.key ?? null
  )
}

/** 默认模型排第一，其余按上次保存的顺序，新出现的排在后面。 */
export function orderRows(
  rows: readonly ModelRow[],
  savedOrder: readonly string[],
  defaultKey: null | string
): ModelRow[] {
  const rank = new Map(savedOrder.map((key, index) => [key, index]))

  return rows
    .map((row, index) => ({ index, row }))
    .sort((a, b) => {
      if (a.row.key === defaultKey) {
        return -1
      }

      if (b.row.key === defaultKey) {
        return 1
      }

      return (rank.get(a.row.key) ?? savedOrder.length + a.index) - (rank.get(b.row.key) ?? savedOrder.length + b.index)
    })
    .map(entry => entry.row)
}

/** 新建模型的默认值；元景地址取套餐提供方的端点。 */
export function newDraft(kind: ProviderKind, planUrl: string | undefined): ModelDraft {
  return {
    apiKey: '',
    baseUrl: presetBaseUrl(kind, planUrl),
    contextWindow: '200000',
    displayName: '',
    hasOwnKey: false,
    kind,
    model: '',
    vision: false
  }
}

export function presetBaseUrl(kind: ProviderKind, planUrl: string | undefined): string {
  return kind === 'yuanjing' ? planUrl || YUANJING_FALLBACK_URL : PRESET_URL[kind]
}

export function draftChanged(row: ModelRow): boolean {
  const { draft, original } = row

  if (!original) {
    return true
  }

  return (
    draft.apiKey.trim() !== '' ||
    draft.baseUrl.trim() !== original.baseUrl ||
    draft.contextWindow.trim() !== original.contextWindow ||
    draft.displayName.trim() !== original.displayName ||
    draft.kind !== original.kind ||
    draft.model.trim() !== original.model ||
    draft.thinking !== original.thinking ||
    JSON.stringify(draft.modalities) !== JSON.stringify(original.modalities) ||
    draft.vision !== original.vision
  )
}

export type DraftProblem = 'baseUrl' | 'model'

/** 保存前的必填校验：模型 ID、合法的 http(s) 接口地址。 */
export function draftProblem(draft: ModelDraft): DraftProblem | null {
  if (!draft.model.trim()) {
    return 'model'
  }

  try {
    const url = new URL(draft.baseUrl.trim())

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return 'baseUrl'
    }
  } catch {
    return 'baseUrl'
  }

  return null
}

export interface EndpointWrite {
  /** 保存后还要写进配置的部分：元景密钥引用、看图开关。 */
  keyEnv?: string
  model: string
  payload: CustomEndpointUpdate
  vision?: boolean
  thinking?: ModelDraft['thinking']
  modalities?: string[]
}

/** 一行自定义模型对应的保存请求；密钥规则见注释。 */
export function endpointWrite(row: ModelRow): EndpointWrite {
  const { draft, original } = row
  const model = draft.model.trim()
  const contextWindow = Number.parseInt(draft.contextWindow.trim() || '200000', 10)

  const payload: CustomEndpointUpdate = {
    api_mode: PRESET_API_MODE[draft.kind],
    base_url: draft.baseUrl.trim(),
    discover_models: false,
    id: row.endpointId,
    make_default: false,
    model,
    name: draft.displayName.trim() || prettifyModelId(model)
  }

  if (Number.isFinite(contextWindow) && contextWindow > 0) {
    payload.context_length = contextWindow
  }

  const write: EndpointWrite = { model, payload }

  if (draft.thinking !== original?.thinking) {write.thinking = draft.thinking}

  if (JSON.stringify(draft.modalities) !== JSON.stringify(original?.modalities)) {write.modalities = draft.modalities}

  if (draft.kind === 'yuanjing') {
    // 元景模型统一引用套餐 Key；原来有自己的密钥就清掉，免得 .env 里留一份没人用的。
    if (original?.hasOwnKey) {
      payload.api_key = ''
    }

    if (!original || original.kind !== 'yuanjing' || original.hasOwnKey) {
      write.keyEnv = PLAN_KEY_ENV
    }
  } else if (draft.apiKey.trim()) {
    payload.api_key = draft.apiKey.trim()
  } else if (original?.kind === 'yuanjing') {
    // 从元景换成别的服务商又没填新密钥：去掉套餐 Key 的引用，不能拿套餐 Key 去调别家。
    payload.api_key = ''
  }

  if (original ? draft.vision !== original.vision || model !== original.model : draft.vision) {
    write.vision = draft.vision
  }

  return write
}

/** 把保存后的补充写成 `PUT /api/config` 的局部配置（服务端深合并，只动这几个键）。 */
export function configPatch(
  writes: readonly { endpointId: string; write: EndpointWrite }[]
): null | Record<string, unknown> {
  const providers: Record<string, Record<string, unknown>> = {}

  for (const { endpointId, write } of writes) {
    if (
      write.keyEnv === undefined &&
      write.vision === undefined &&
      write.thinking === undefined &&
      write.modalities === undefined
    ) {
      continue
    }

    const entry: Record<string, unknown> = {}

    if (write.keyEnv !== undefined) {
      entry.key_env = write.keyEnv
    }

    if (write.vision !== undefined) {
      entry.models = { [write.model]: { supports_vision: write.vision } }
    }

    if (write.modalities) {entry.input_modalities = write.modalities}

    if (write.thinking) {entry.desktop_thinking = write.thinking}
    providers[endpointId] = entry
  }

  return Object.keys(providers).length ? { providers } : null
}

/** 新建模型用的 providers 键；只含小写字母、数字和连字符，服务端不会再改写。 */
export function newEndpointId(random: () => number = Math.random): string {
  return `uw-${Math.floor(random() * 0xffffffff)
    .toString(16)
    .padStart(8, '0')}`
}
