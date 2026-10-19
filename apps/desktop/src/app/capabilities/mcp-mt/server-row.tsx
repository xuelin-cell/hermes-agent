import { useId, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Switch } from '@/components/ui/switch'
import { TextTab } from '@/components/ui/text-tab'
import type { ProfileScope } from '@/hermes'
import { useI18n } from '@/i18n'

import { localServerName } from '../connectors/derive'
import { PluginToolsPanel } from '../connectors/plugin-tools-panel'
import { LocalToolsPanel } from '../connectors/tools-panel'
import type { ConnectorCardModel } from '../connectors/types'
import { McpJsonEditor } from '../mcp/mcp-editor'
import { canAuthenticate } from '../mcp/mcp-status'
import type { McpServersController } from '../mcp/use-mcp-servers'

export interface McpServerRowProps {
  card: ConnectorCardModel
  controller: McpServersController
  expanded: boolean
  onExpand: () => void
  onOpenPlugins: () => void
  onRemove: () => void
  profile: ProfileScope
}

/** 一行连接配置可展开原生工具和 JSON；插件服务只提供原生只读工具视图。 */
export function McpServerRow({
  card,
  controller,
  expanded,
  onExpand,
  onOpenPlugins,
  onRemove,
  profile
}: McpServerRowProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.mcpLocal
  const m = t.settings.mcp
  const id = useId()
  const [view, setView] = useState<'tools' | 'config'>('tools')
  const name = localServerName(card)
  const entry = controller.servers[name]
  const probe = controller.probes[name]
  const plugin = card.plugin !== undefined
  const enabled = card.ways.local?.serverEnabled === true
  const pending = controller.saving || controller.profilePending

  const result =
    probe === 'probing' ? copy.testing : probe ? (probe.ok ? copy.testPassed : copy.testFailed) : copy.untested

  return (
    <article aria-label={name} className="grid min-w-0 gap-2 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <Button
          aria-controls={id}
          aria-expanded={expanded}
          className="min-w-0 flex-1 justify-start"
          onClick={onExpand}
          size="sm"
          variant="textStrong"
        >
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} />
          <span className="min-w-0 truncate">{name}</span>
        </Button>
        <Badge variant="muted">{entry?.url ? 'HTTP' : entry ? 'STDIO' : 'MCP'}</Badge>
        <Badge variant="muted">{enabled ? copy.enabled : m.disabled}</Badge>
        <div className="ml-auto flex items-center gap-3">
          {!plugin && (
            <Switch
              aria-label={
                enabled ? t.connectorsPage.card.turnServerOff(name) : t.connectorsPage.card.turnServerOn(name)
              }
              checked={enabled}
              disabled={pending}
              onCheckedChange={next => void controller.setServerEnabled(name, next)}
              size="xs"
            />
          )}
          {!plugin && (
            <Button
              aria-label={t.connectorsPage.dialog.removeServerTitle(name)}
              disabled={pending}
              onClick={onRemove}
              size="icon-xs"
              variant="ghost"
            >
              <Codicon name="trash" />
            </Button>
          )}
        </div>
      </div>
      <p className="text-xs text-(--ui-text-tertiary)">
        {plugin ? t.connectorsPage.dialog.providedByPlugin(card.plugin ?? '') : result}
      </p>
      {expanded && (
        <div className="grid min-w-0 gap-3" id={id}>
          {probe && probe !== 'probing' && !probe.ok && probe.error && (
            <p className="whitespace-pre-wrap break-words text-xs text-destructive" role="alert">
              {probe.error}
            </p>
          )}
          {!plugin && (
            <div className="flex flex-wrap items-center gap-3">
              <TextTab active={view === 'tools'} onClick={() => setView('tools')}>
                {t.connectorsPage.tools.title}
              </TextTab>
              <TextTab active={view === 'config'} onClick={() => setView('config')}>
                {copy.configuration}
              </TextTab>
              <Button
                disabled={pending || probe === 'probing'}
                onClick={() => void controller.runProbe(name)}
                size="xs"
                variant="secondary"
              >
                {m.test}
              </Button>
              {entry && canAuthenticate(entry, controller.statuses[name] ?? 'unknown') && (
                <Button
                  disabled={controller.authing === name || pending}
                  onClick={() => void controller.authenticate(name)}
                  size="xs"
                  variant="secondary"
                >
                  {m.authenticate}
                </Button>
              )}
            </div>
          )}
          {plugin ? (
            <div className="h-80 min-w-0 overflow-hidden">
              <PluginToolsPanel card={card} onOpenPlugins={onOpenPlugins} plugin={card.plugin ?? ''} scope={profile} />
            </div>
          ) : view === 'config' ? (
            <div className="h-72 min-w-0 overflow-hidden">
              <McpJsonEditor controller={controller} highlightServer={name} />
            </div>
          ) : (
            <div className="h-80 min-w-0 overflow-hidden">
              <LocalToolsPanel card={card} controller={controller} onRemove={onRemove} />
            </div>
          )}
        </div>
      )}
    </article>
  )
}
