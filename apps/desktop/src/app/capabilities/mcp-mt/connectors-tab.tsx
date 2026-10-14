import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { PAGE_INSET_X } from '@/app/layout-constants'
import { PageLoader } from '@/components/page-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { SearchField } from '@/components/ui/search-field'
import type { HermesGateway, ProfileScope } from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { AddServerDialog } from '../connectors/add-dialog'
import { joinLocalServers, pluginServerRows } from '../connectors/data/join'
import { PLUGIN_SERVERS_STALE_TIME, pluginServersQueryKey } from '../connectors/data/keys'
import { listMcpServers, mcpServerStatus } from '../connectors/data/rpc'
import { cardKey, deriveCards } from '../connectors/derive'
import { RemoveServerConfirm } from '../connectors/local-slots'
import { openToolsList, resetOpenedTools } from '../connectors/tools-summary'
import type { ConnectorCardModel } from '../connectors/types'
import { useMcpServers } from '../mcp/use-mcp-servers'

import { McpServerRow } from './server-row'

export interface McpConnectorsTabProps {
  gateway: HermesGateway | null
  profile: ProfileScope
  scopeLabel?: string
}

/** 按当前 Profile 展示原生 MCP，页面只管理展开、搜索和对话框状态。 */
export function McpConnectorsTab({ gateway, profile, scopeLabel }: McpConnectorsTabProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.mcpLocal
  const mcp = useMcpServers({ gateway, profile })
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [removing, setRemoving] = useState<ConnectorCardModel | null>(null)
  const navigate = useNavigate()
  const location = useLocation()

  const plugins = useQuery({
    queryKey: pluginServersQueryKey(profile),
    queryFn: async () => {
      const [list, runtime] = await Promise.all([listMcpServers(profile), mcpServerStatus(profile)])

      return pluginServerRows({ runtime: runtime.servers, servers: list.servers })
    },
    retry: false,
    staleTime: PLUGIN_SERVERS_STALE_TIME
  })

  const cards = useMemo(
    () =>
      deriveCards({
        hosted: [],
        local: [
          ...joinLocalServers({
            catalog: [],
            servers: mcp.servers,
            status: mcp.statuses,
            toolCounts: mcp.toolCounts,
            usage: mcp.usageByServer
          }),
          ...(plugins.data ?? [])
        ]
      }),
    [mcp.servers, mcp.statuses, mcp.toolCounts, mcp.usageByServer, plugins.data]
  )

  const matched = cards.filter(card => card.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const custom = matched.filter(card => card.plugin === undefined)
  const provided = matched.filter(card => card.plugin !== undefined)
  const profileName = scopeLabel ?? (typeof profile === 'object' ? profile?.profile : profile) ?? 'default'

  // 工具展开偏好不跨 Profile 沿用，随后再处理本次深链。
  useEffect(resetOpenedTools, [profile])

  // 保留安装和健康提示的原生深链，等配置加载完成后展开目标服务。
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const target = params.get('server') ?? params.get('connector')
    const card = cards.find(candidate => candidate.ways.local?.serverName === target)

    if (!card) {
      return
    }

    if (params.has('tool')) {
      openToolsList(card.ways.local?.serverName ?? card.slug)
    }

    setExpanded(cardKey(card))

    for (const key of ['server', 'connector', 'tool']) {
      params.delete(key)
    }

    navigate({ ...location, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true })
  }, [cards, location, navigate])

  /** 插件声明的服务回到原生插件页管理，不当作普通配置删除。 */
  function openPlugins(): void {
    const params = new URLSearchParams(location.search)
    params.set('tab', 'plugins')
    navigate({ ...location, search: `?${params.toString()}` })
  }

  /** 所有行共享原生控制器，配置与探测结果继续由它维护。 */
  function renderRow(card: ConnectorCardModel) {
    const key = cardKey(card)

    return (
      <McpServerRow
        card={card}
        controller={mcp}
        expanded={expanded === key}
        key={key}
        onExpand={() => setExpanded(expanded === key ? null : key)}
        onOpenPlugins={openPlugins}
        onRemove={() => setRemoving(card)}
        profile={profile}
      />
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-4', PAGE_INSET_X)}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-(--ui-text-tertiary)">
          {copy.profile}: {profileName}
        </p>
        <Button
          disabled={mcp.configLoading || mcp.configFailed || mcp.profilePending}
          onClick={() => setAddOpen(true)}
          size="sm"
        >
          {copy.addCustom}
        </Button>
      </div>
      <section aria-label={copy.builtIn} className="grid gap-3">
        <h2 className="text-sm font-semibold">{copy.builtIn}</h2>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <div className="flex items-center gap-2">
              <span className="text-sm">Playwright</span>
              <Badge variant="muted">STDIO</Badge>
            </div>
            <p className="text-xs text-(--ui-text-tertiary)">{copy.playwrightDescription}</p>
            <p className="text-xs text-(--ui-text-tertiary)">{copy.installPending}</p>
          </div>
          <Button disabled size="sm" variant="secondary">
            {copy.install}
          </Button>
        </div>
      </section>
      {cards.length > 0 && (
        <SearchField aria-label={copy.search} onChange={setQuery} placeholder={copy.search} value={query} />
      )}
      <section aria-label={copy.custom} className="grid gap-3">
        <h2 className="text-sm font-semibold">{copy.custom}</h2>
        {mcp.configLoading ? (
          <PageLoader label={t.skills.loading} />
        ) : mcp.configFailed ? (
          <ErrorState title={copy.loadFailed}>
            <Button onClick={mcp.refetchConfig} size="sm" variant="secondary">
              {t.common.retry}
            </Button>
          </ErrorState>
        ) : custom.length > 0 ? (
          custom.map(renderRow)
        ) : (
          <EmptyState title={query.trim() ? copy.noMatches : copy.empty} />
        )}
      </section>
      {(provided.length > 0 || plugins.isPending || plugins.isError) && (
        <section aria-label={copy.plugins} className="grid gap-3">
          <h2 className="text-sm font-semibold">{copy.plugins}</h2>
          {plugins.isError ? (
            <ErrorState title={copy.pluginsFailed}>
              <Button onClick={() => void plugins.refetch()} size="sm" variant="secondary">
                {t.common.retry}
              </Button>
            </ErrorState>
          ) : plugins.isPending ? (
            <PageLoader label={t.skills.loading} />
          ) : (
            provided.map(renderRow)
          )}
        </section>
      )}
      <AddServerDialog controller={mcp} onOpenChange={setAddOpen} open={addOpen} profile={profile} />
      <RemoveServerConfirm
        card={removing}
        controller={mcp}
        onClose={() => setRemoving(null)}
        onRemoved={() => setExpanded(null)}
      />
    </div>
  )
}
