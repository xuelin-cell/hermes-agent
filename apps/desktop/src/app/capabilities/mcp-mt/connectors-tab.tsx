import { useQuery } from '@tanstack/react-query'
import { type ReactNode, useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { PAGE_INSET_X } from '@/app/layout-constants'
import { PageLoader } from '@/components/page-loader'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { ErrorState } from '@/components/ui/error-state'
import type { HermesGateway, ProfileScope } from '@/hermes'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { pluginServerRows } from '../connectors/data/join'
import { PLUGIN_SERVERS_STALE_TIME, pluginServersQueryKey } from '../connectors/data/keys'
import { listMcpServers, mcpServerStatus } from '../connectors/data/rpc'
import { useMcpServers } from '../mcp/use-mcp-servers'

import type { FormTransport } from './server-form-model'
import { isBuiltInServer } from './server-form-model'
import { McpServerRow, PluginServerRow } from './server-row'
import { useServerEdits } from './use-server-edits'

export interface McpConnectorsTabProps {
  gateway: HermesGateway | null
  profile: ProfileScope
  scopeLabel?: string
}

/** UniWork 同款 MCP 连接器页：内置服务在上，自定义服务在下，插件服务只读；读写仍走 Hermes 原生 MCP。 */
export function McpConnectorsTab({ gateway, profile, scopeLabel }: McpConnectorsTabProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.mcpLocal
  const mcp = useMcpServers({ gateway, profile })
  const edits = useServerEdits(mcp)
  const [expanded, setExpanded] = useState<null | string>(null)
  const [picking, setPicking] = useState(false)
  const [removing, setRemoving] = useState<null | string>(null)
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

  const names = Object.keys(mcp.servers)
  const builtIn = names.filter(isBuiltInServer)
  const custom = names.filter(name => !isBuiltInServer(name))
  const profileName = scopeLabel ?? (typeof profile === 'object' ? profile?.profile : profile) ?? 'default'
  const ready = !mcp.configLoading && !mcp.configFailed

  // 保留安装和健康提示的深链：配置加载后展开目标服务。
  useEffect(() => {
    const params = new URLSearchParams(location.search)
    const target = params.get('server') ?? params.get('connector')

    if (!target || !(target in mcp.servers)) {
      return
    }

    setExpanded(edits.rowId(target))

    for (const key of ['server', 'connector', 'tool']) {
      params.delete(key)
    }

    navigate({ ...location, search: params.toString() ? `?${params.toString()}` : '' }, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mcp.servers, location, navigate])

  /** 展开或收起一行。 */
  const toggleRow = (id: string) => setExpanded(current => (current === id ? null : id))

  /** 选好传输类型后生成空白行并展开，填好名称和地址/命令才写入配置。 */
  const addRow = (transport: FormTransport) => {
    setExpanded(edits.addRow(transport))
    setPicking(false)
  }

  /** 插件声明的服务回到插件页管理。 */
  const openPlugins = () => {
    const params = new URLSearchParams(location.search)
    params.set('tab', 'plugins')
    navigate({ ...location, search: `?${params.toString()}` })
  }

  /** 已保存服务的一行。 */
  const savedRow = (name: string) => {
    const id = edits.rowId(name)

    return (
      <McpServerRow
        controller={mcp}
        edits={edits}
        expanded={expanded === id}
        id={id}
        key={id}
        name={name}
        onExpand={() => toggleRow(id)}
        onRemove={() => setRemoving(name)}
      />
    )
  }

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-4', PAGE_INSET_X)}>
      <div className="grid gap-1">
        <p className="text-xs text-(--ui-text-secondary)">{copy.hint}</p>
        <p className="text-xs text-(--ui-text-tertiary)">
          {copy.profile}: {profileName}
        </p>
      </div>
      {mcp.configLoading ? (
        <PageLoader label={t.skills.loading} />
      ) : mcp.configFailed ? (
        <ErrorState title={copy.loadFailed}>
          <Button onClick={mcp.refetchConfig} size="sm" variant="secondary">
            {t.common.retry}
          </Button>
        </ErrorState>
      ) : (
        <>
          {builtIn.length > 0 && (
            <section aria-label={copy.builtIn} className="grid gap-2">
              <ServerList>{builtIn.map(savedRow)}</ServerList>
            </section>
          )}
          {builtIn.length > 0 && <div className="border-t border-(--ui-stroke-tertiary)" />}
          <section aria-label={copy.custom} className="grid gap-3">
            <div className="grid gap-1">
              <h2 className="text-sm font-semibold">{copy.custom}</h2>
              <p className="text-xs text-(--ui-text-tertiary)">{copy.customHint}</p>
            </div>
            {custom.length === 0 && edits.newRows.length === 0 ? (
              <div className="flex items-center gap-2 rounded-md border border-dashed border-(--ui-stroke-secondary) px-3 py-4 text-xs text-(--ui-text-tertiary)">
                <Codicon name="server" />
                {copy.empty}
              </div>
            ) : (
              <ServerList>
                {custom.map(savedRow)}
                {edits.newRows.map(row => (
                  <McpServerRow
                    controller={mcp}
                    edits={edits}
                    expanded={expanded === row.id}
                    id={row.id}
                    key={row.id}
                    name={null}
                    newTransport={row.transport}
                    onExpand={() => toggleRow(row.id)}
                    onRemove={() => edits.dropRow(row.id)}
                  />
                ))}
              </ServerList>
            )}
            {picking ? (
              <div className="grid gap-2 rounded-md border border-(--ui-stroke-secondary) p-3">
                <span className="text-xs text-(--ui-text-secondary)">{copy.chooseTransport}</span>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => addRow('http')} size="sm" variant="secondary">
                    HTTP
                  </Button>
                  <Button onClick={() => addRow('stdio')} size="sm" variant="secondary">
                    Stdio
                  </Button>
                  <Button onClick={() => setPicking(false)} size="sm" variant="ghost">
                    {t.common.cancel}
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                className="justify-self-start"
                disabled={!ready || mcp.profilePending}
                onClick={() => setPicking(true)}
                size="sm"
                variant="secondary"
              >
                <Codicon name="add" />
                {copy.addServer}
              </Button>
            )}
          </section>
        </>
      )}
      {(plugins.isPending || plugins.isError || (plugins.data?.length ?? 0) > 0) && (
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
            <ServerList>
              {plugins.data.map(row => (
                <PluginServerRow key={row.name} onOpenPlugins={openPlugins} row={row} />
              ))}
            </ServerList>
          )}
        </section>
      )}
      <ConfirmDialog
        confirmLabel={t.common.delete}
        description={t.connectorsPage.dialog.removeServerBody}
        destructive
        onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) {
            return
          }

          edits.forget(removing)

          if (!(await mcp.removeServer(removing))) {
            throw new Error(t.settings.mcp.removeFailed)
          }

          setExpanded(null)
        }}
        open={removing !== null}
        title={t.connectorsPage.dialog.removeServerTitle(removing ?? '')}
      />
    </div>
  )
}

/** 行之间用细线分隔的列表。 */
function ServerList({ children }: { children: ReactNode }) {
  return <div className="grid divide-y divide-(--ui-stroke-tertiary)">{children}</div>
}
