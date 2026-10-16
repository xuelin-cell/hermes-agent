import './connectors-page.css'

import { useEffect, useId, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { PAGE_INSET_X } from '@/app/layout-constants'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchField } from '@/components/ui/search-field'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { McpConnectorsTab, type McpConnectorsTabProps } from './connectors-tab'
import { RECOMMENDED_CONNECTORS } from './recommended-catalog'
import { RecommendedConnectorCard, RecommendedConnectorDetail } from './recommended-connector'

/** 推荐目录只负责展示，MCP 页继续使用原生管理；深链始终优先打开 MCP。 */
export function ConnectorsPage(props: McpConnectorsTabProps) {
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
  const panelId = useId()
  const selected = RECOMMENDED_CONNECTORS.find(entry => entry.id === selectedId)
  const term = query.trim().toLocaleLowerCase()

  const entries = RECOMMENDED_CONNECTORS.filter(entry => {
    const item = copy.catalog[entry.id]

    return `${item.name} ${item.description} ${item.provider}`.toLocaleLowerCase().includes(term)
  })

  // 切换账号或 Profile 后不保留上一个范围打开的详情。
  useEffect(() => setSelectedId(null), [props.profile])

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

  return (
    <div className="mt-connectors-page flex h-full min-h-0 flex-col">
      <div className={cn('mt-connectors-toolbar', PAGE_INSET_X)}>
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
        {view === 'recommended' && (
          <SearchField
            aria-label={copy.search}
            containerClassName="mt-connectors-search"
            onChange={setQuery}
            placeholder={copy.search}
            value={query}
            variant="box"
          />
        )}
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
            <RecommendedConnectorCard entry={entry} key={entry.id} onSelect={() => setSelectedId(entry.id)} />
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
      <RecommendedConnectorDetail entry={selected ?? null} onClose={() => setSelectedId(null)}>
        <Button onClick={() => changeView('mcp')} variant="secondary">
          MCP
        </Button>
      </RecommendedConnectorDetail>
    </div>
  )
}
