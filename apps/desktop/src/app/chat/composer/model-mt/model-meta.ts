import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'

import { currentRowKey, orderRows, providerIdOf, readOrder, rowsFromEndpoints } from '@/app/settings/models-mt/catalog'
import { prettifyModelId } from '@/app/settings/models-mt/model-name'
import { getCustomEndpoints, getHermesConfigRecord } from '@/hermes'
import { $settingsRequestProfile } from '@/store/settings-scope'
import type { CustomEndpointsResponse } from '@/types/hermes'

export interface ComposerModelMeta {
  key: string
  endpointId: string
  provider: string
  model: string
  name: string
  contextWindow?: number
  thinking?: 'auto' | 'on' | 'off'
  modalities?: string[]
  vision: boolean
  plan: boolean
}

/** 原始 YAML 配置只按普通字段映射读取，不把数组当作模型选项。 */
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** 只采用有效上限，缺失或非法模型值时继续检查端点。 */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** 与设置页共用默认行和排序，只提取输入框需要展示的非秘密元数据。 */
export function buildComposerModelMeta(
  response: CustomEndpointsResponse,
  providers: unknown,
  savedOrder: readonly string[]
): ComposerModelMeta[] {
  const rows = rowsFromEndpoints(response.endpoints, providers)

  return orderRows(rows, savedOrder, currentRowKey(rows, response.current)).map(row => {
    const endpoint = response.endpoints.find(item => item.id === row.endpointId)!
    const provider = record(record(providers)[row.endpointId])
    const options = record(record(provider.models)[row.draft.model])

    return {
      key: row.key,
      endpointId: row.endpointId,
      provider: `custom:${row.endpointId}`,
      model: row.draft.model,
      name: row.plan
        ? prettifyModelId(row.draft.model)
        : row.draft.displayName.trim() || prettifyModelId(row.draft.model),
      contextWindow: positiveInteger(options.context_length) ?? positiveInteger(endpoint.context_length),
      thinking: row.draft.thinking,
      modalities: row.draft.modalities,
      vision: row.draft.vision,
      plan: row.plan
    }
  })
}

/** 配置查询跟随设置页的 Profile，并参与现有 model-options 刷新。 */
export function useComposerModelMeta() {
  const profile = useStore($settingsRequestProfile)

  const query = useQuery({
    queryKey: ['model-options', 'desktop-mt-meta', profile],
    queryFn: async () => {
      const [response, config] = await Promise.all([
        getCustomEndpoints(profile),
        getHermesConfigRecord(profile, { includeDefaults: false })
      ])

      return buildComposerModelMeta(response, config.providers, readOrder(profile))
    }
  })

  const rows = query.data ?? []

  /** 同名模型必须同时匹配提供方，不能把不同端点的配置混用。 */
  const find = (provider: string, model: string) =>
    rows.find(row => providerIdOf(row.provider) === providerIdOf(provider) && row.model === model)

  return { rows, find, loading: query.isPending, error: query.isError }
}
