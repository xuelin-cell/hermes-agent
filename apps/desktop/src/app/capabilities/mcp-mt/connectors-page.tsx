import './connectors-page.css'
import '../skills-mt/skills-mt.css'

import { useEffect, useId, useState } from 'react'
import { createPortal } from 'react-dom'
import { useLocation, useNavigate } from 'react-router'

import { PAGE_INSET_X } from '@/app/layout-constants'
import { EmptyState } from '@/components/ui/empty-state'
import { useI18n } from '@/i18n'
import { Search } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { CONNECTOR_SPECS, type ConnectorId } from '../../../../electron/open-connector/contract'

import { McpConnectorsTab, type McpConnectorsTabProps } from './connectors-tab'
import { RECOMMENDED_CONNECTORS } from './recommended-catalog'
import { RecommendedConnectorCard, RecommendedConnectorDetail } from './recommended-connector'
import { useRecommendedConnections } from './use-recommended-connections'

/** 推荐目录只负责展示，MCP 页继续使用原生管理；深链始终优先打开 MCP。 */
interface ConnectorsPageProps extends McpConnectorsTabProps {
  searchContainer?: HTMLDivElement | null
}

export function ConnectorsPage({ searchContainer, ...props }: ConnectorsPageProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.recommended
  const location = useLocation()
  const navigate = useNavigate()
  const params = new URLSearchParams(location.search)
  const hasMcpTarget = params.has('server') || params.has('connector') || params.has('tool')
  const view = hasMcpTarget || params.get('connectorView') === 'mcp' ? 'mcp' : 'recommended'
  const [mcpOpened, setMcpOpened] = useState(view === 'mcp')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detailMode, setDetailMode] = useState<'overview' | 'credentials'>('overview')
  const connections = useRecommendedConnections(props.profile)
  const panelId = useId()
  const supported = RECOMMENDED_CONNECTORS.filter(entry => !window.hermesDesktop.cloudConnectorIds || window.hermesDesktop.cloudConnectorIds.includes(entry.id))
  const selected = supported.find(entry => entry.id === selectedId)
  const connected = connections.rows.some(row => row.id === selectedId && row.connected)
  const term = query.trim().toLocaleLowerCase()

  const entries = supported.filter(entry => {
    const item = copy.catalog[entry.id]

    return `${item.name} ${item.description} ${item.provider}`.toLocaleLowerCase().includes(term)
  })

  // 切换账号或 Profile 后不保留上一个范围打开的详情。
  useEffect(() => setSelectedId(null), [connections.scopeKey])

  // 推荐连接器的深链（召唤东方财富专家时的「去连接」）：打开那张卡片的详情，再把参数从地址里去掉。
  // 不用 connector 参数，那个留给 MCP 页展开已保存的服务。
  useEffect(() => {
    const nextParams = new URLSearchParams(location.search)
    const target = nextParams.get('recommended')

    if (!target) {
      return
    }

    if (supported.some(entry => entry.id === target)) {
      setDetailMode('overview')
      setSelectedId(target)
    }

    nextParams.delete('recommended')
    navigate({ ...location, search: nextParams.toString() ? `?${nextParams.toString()}` : '' }, { replace: true })
  }, [location, navigate])

  // 首次打开后保留原生编辑器，切换推荐页不丢失尚未保存的 MCP 草稿。
  useEffect(() => {
    if (view === 'mcp') {
      setMcpOpened(true)
    }
  }, [view])

  /** 标签通过 URL 保留，避免 MCP 清理深链后跳回推荐目录。 */
  function changeView(next: 'recommended' | 'mcp'): void {
    const nextParams = new URLSearchParams(location.search)

    if (next === 'mcp') {
      nextParams.set('connectorView', 'mcp')
    } else {
      for (const key of ['connectorView', 'server', 'connector', 'tool']) {
        nextParams.delete(key)
      }
    }

    setSelectedId(null)
    navigate({ ...location, search: nextParams.toString() ? `?${nextParams.toString()}` : '' }, { replace: true })
  }

  function connect(id: ConnectorId): void {
    setSelectedId(id)

    if (CONNECTOR_SPECS[id].auth === 'oauth2' && !(window.hermesDesktop.cloudConnectorIds && id === 'ifind_mcp')) {
      setDetailMode('overview')
      void connections.request('authorize', id)
    } else {
      setDetailMode('credentials')
    }
  }

  async function openExample(text: string): Promise<void> {
    if (!selected) {
      return
    }

    if (!connected) {
      connect(selected.id)

      return
    }

    const current = connections.capture()
    const { openConnectorExample } = await import('./open-connector-example')

    if (!current()) {
      return
    }

    openConnectorExample(props.profile, text)
    setSelectedId(null)
    navigate('/')
  }

  const searchField = (
    <div
      aria-hidden={view !== 'recommended' || undefined}
      className={cn('mt-connectors-search-slot', searchContainer !== undefined && 'mt-connectors-search-header')}
      inert={view !== 'recommended'}
    >
      <label className="mt-skills-search">
        <Search className="size-4 shrink-0" />
        <input
          aria-label={copy.search}
          onChange={event => setQuery(event.target.value)}
          placeholder={copy.search}
          value={query}
        />
      </label>
    </div>
  )

  return (
    <div className="mt-connectors-page flex h-full min-h-0 flex-col">
      <div
        className={cn(
          'mt-connectors-toolbar',
          searchContainer !== undefined ? 'mt-connectors-toolbar-header' : PAGE_INSET_X
        )}
      >
        <div aria-label={t.connectorsPage.title} className="mt-connectors-tabs" role="tablist">
          <button
            aria-controls={`${panelId}-recommended`}
            aria-selected={view === 'recommended'}
            id={`${panelId}-recommended-tab`}
            onClick={() => changeView('recommended')}
            onKeyDown={event => {
              if (event.key === 'ArrowRight' || event.key === 'End') {
                event.preventDefault()
                changeView('mcp')
                document.getElementById(`${panelId}-mcp-tab`)?.focus()
              }
            }}
            role="tab"
            tabIndex={view === 'recommended' ? 0 : -1}
            type="button"
          >
            {copy.tab}
          </button>
          <button
            aria-controls={`${panelId}-mcp`}
            aria-selected={view === 'mcp'}
            id={`${panelId}-mcp-tab`}
            onClick={() => changeView('mcp')}
            onKeyDown={event => {
              if (event.key === 'ArrowLeft' || event.key === 'Home') {
                event.preventDefault()
                changeView('recommended')
                document.getElementById(`${panelId}-recommended-tab`)?.focus()
              }
            }}
            role="tab"
            tabIndex={view === 'mcp' ? 0 : -1}
            type="button"
          >
            MCP
          </button>
        </div>
        {searchContainer === undefined
          ? searchField
          : searchContainer
            ? createPortal(searchField, searchContainer)
            : null}
      </div>
      <div
        aria-labelledby={`${panelId}-recommended-tab`}
        className={cn('min-h-0 flex-1 overflow-y-auto py-6', PAGE_INSET_X)}
        hidden={view !== 'recommended'}
        id={`${panelId}-recommended`}
        role="tabpanel"
      >
        <div className="mt-connectors-grid">
          {entries.map(entry => (
            <RecommendedConnectorCard
              connected={connections.rows.some(row => row.id === entry.id && row.connected)}
              disabled={connections.busy || !connections.available}
              entry={entry}
              key={entry.id}
              onConnect={() => connect(entry.id)}
              onSelect={() => {
                setDetailMode('overview')
                setSelectedId(entry.id)
              }}
            />
          ))}
        </div>
        {entries.length === 0 && <EmptyState title={copy.noMatches} />}
      </div>
      <div
        aria-labelledby={`${panelId}-mcp-tab`}
        className="min-h-0 flex-1"
        hidden={view !== 'mcp'}
        id={`${panelId}-mcp`}
        role="tabpanel"
      >
        {(mcpOpened || view === 'mcp') && <McpConnectorsTab {...props} />}
      </div>
      <RecommendedConnectorDetail
        available={connections.available}
        busy={connections.busy}
        connected={connected}
        configured={connections.rows.some(row => row.id === selectedId && row.configured)}
        onRetrySave={window.hermesDesktop.cloudConnectorIds && selected ? () => {
          void connections.request('save', selected.id).then(saved => { if (saved) setDetailMode('overview') })
        } : undefined}
        onToggle={window.hermesDesktop.cloudConnectorIds && selected ? () => {
          void connections.request(connected ? 'disable' : 'enable', selected.id)
        } : undefined}
        entry={selected ?? null}
        error={connections.error}
        key={selectedId}
        mode={detailMode}
        onCancel={connections.cancel}
        onClose={() => setSelectedId(null)}
        onConnect={() => {
          if (selected) {
            connect(selected.id)
          }
        }}
        onConnected={() => setDetailMode('overview')}
        onDisconnect={() => {
          if (selected) {
            void connections.request('disconnect', selected.id)
          }
        }}
        onExample={text => void openExample(text)}
        onQr={connections.qr}
        onSubmit={async values => {
          if (selected && (await connections.request(CONNECTOR_SPECS[selected.id].auth === 'oauth2' ? 'authorize' : 'connect', selected.id, values))) {
            setDetailMode('overview')
          }
        }}
        waiting={connections.pending === selectedId}
      />
    </div>
  )
}
