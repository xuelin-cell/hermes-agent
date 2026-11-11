import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'

import { providerIdOf, rowsFromEndpoints } from '@/app/settings/models-mt/catalog'
import { prettifyModelId } from '@/app/settings/models-mt/model-name'
import { getCustomEndpoints, getHermesConfigRecord } from '@/hermes'
import { $activeConnectionId } from '@/store/connections'
import { $activeGatewayProfile } from '@/store/profile'
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

export interface ComposerModelCatalog {
  rows: ComposerModelMeta[]
  selectable: ComposerModelMeta[]
  main?: ComposerModelMeta
}

export function matchesComposerModel(row: ComposerModelMeta, provider: string, model: string): boolean {
  return row.model === model && providerIdOf(row.provider) === providerIdOf(provider)
}

export function displayedComposerModel(
  catalog: ComposerModelCatalog,
  provider: string,
  model: string,
  waitingForModel = false
) {
  return previewComposerModel(catalog, provider, model)
    ?? (waitingForModel ? undefined : catalog.main ?? catalog.selectable[0])
}

function previewComposerModel(catalog: ComposerModelCatalog, provider: string, model: string) {
  if (!model) {
    return undefined
  }

  const exact = catalog.selectable.find(row => matchesComposerModel(row, provider, model))
    ?? catalog.rows.find(row => matchesComposerModel(row, provider, model))

  if (exact || (provider && provider !== 'custom')) {
    return exact
  }

  // Older rows can be missing the provider or contain only Hermes' generic billing class.
  const matches = catalog.rows.filter(row => row.model === model)
  const first = matches[0]

  return first && matches.every(row => providerIdOf(row.provider) === providerIdOf(first.provider)) ? first : undefined
}

export function buildComposerModelMeta(
  response: CustomEndpointsResponse,
  providers: unknown,
  planConfig: unknown
): ComposerModelCatalog {
  const plan = record(planConfig)
  const rows = rowsFromEndpoints(response.endpoints, providers)
    .filter(row => row.draft.model)
    .map((row): ComposerModelMeta => {
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
  const find = (target: unknown) => {
    const { model, provider } = record(target)

    return typeof provider === 'string' && typeof model === 'string'
      ? rows.find(row => matchesComposerModel(row, provider, model))
      : undefined
  }
  const planModels = Array.isArray(plan.models) ? plan.models : null
  const planRows = planModels
    ? planModels.flatMap((target: unknown, index) => {
        const row = find(target)
        const { id } = record(target)

        return row?.plan ? [{ ...row, key: `${row.key}:${id || index}` }] : []
      })
    : rows.filter(row => row.plan)
  const ordered = [...planRows, ...rows.filter(row => !row.plan)]
  const matchesTarget = (target: unknown) => {
    const model = find(target)
    const { id } = record(target)

    return (row: ComposerModelMeta) =>
      model && matchesComposerModel(row, model.provider, model.model) && (!id || row.key === `${model.key}:${id}`)
  }
  const isFast = matchesTarget(plan.fast)

  return {
    rows: ordered,
    selectable: ordered.filter(row => !isFast(row)),
    main: ordered.find(matchesTarget(planModels ? plan.main : response.current))
  }
}

/** 用会话所属后端读取目录，设置页的 Profile 切换不会影响聊天框。 */
export function useComposerModelMeta(profile?: string, connectionId?: string, enabled = true) {
  const activeProfile = useStore($activeGatewayProfile)
  const activeConnectionId = useStore($activeConnectionId)
  const ownerProfile = profile ?? activeProfile
  const ownerConnection = connectionId ?? activeConnectionId
  const query = useQuery({
    enabled,
    queryKey: ['model-options', 'desktop-mt-meta', ownerProfile, ownerConnection],
    queryFn: async () => {
      const scope = ownerConnection ? { connectionId: ownerConnection, profile: ownerProfile } : ownerProfile
      const [response, config] = await Promise.all([
        getCustomEndpoints(scope),
        getHermesConfigRecord(scope, { includeDefaults: false })
      ])

      return buildComposerModelMeta(response, config.providers, config.uniwork_model_catalog)
    }
  })

  const catalog = query.data
  const rows = catalog?.rows ?? []

  return {
    ...(catalog && { catalog }),
    rows,
    find: (provider: string, model: string) => rows.find(row => matchesComposerModel(row, provider, model)),
    loading: query.isPending,
    error: query.isError
  }
}
