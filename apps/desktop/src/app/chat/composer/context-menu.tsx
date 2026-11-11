import { useStore } from '@nanostores/react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'

import { withEnabled } from '@/app/capabilities/mcp/mcp-doc'
import { CAPABILITIES_ROUTE } from '@/app/routes'
import { composerPanelCard } from '@/components/chat/composer-dock'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import {
  getHermesConfigRecord,
  getSkills,
  reloadMcpServers,
  saveMcpServers,
  setSkillEnabled,
  testMcpServer
} from '@/hermes'
import { useI18n } from '@/i18n'
import { Brain, FileText, FolderOpen, type IconComponent, MessageSquareText, Plug, Plus, Settings } from '@/lib/icons'
import { getServers, type McpServers, serverEnabled } from '@/lib/mcp-servers'
import { cn } from '@/lib/utils'
import { $developerMode } from '@/store/developer-mode'
import { notifyError } from '@/store/notifications'
import { $activeGatewayProfile } from '@/store/profile'
import type { SkillInfo } from '@/types/hermes'

import { CONNECTOR_SPECS, type ConnectorId } from '../../../../electron/open-connector/contract'

import { useComposerAttachmentProviders } from './contrib'
import { GHOST_ICON_BTN } from './controls'
import type { ChatBarState } from './types'

const SNIPPET_KEYS = ['codeReview', 'implementationPlan', 'explainThis']

const QUICK_CONNECTOR_NAMES = {
  'UniAI-Toolkit': 'uniAiToolkit',
  'arXiv-mcp': 'arxiv',
  'UniWork-Drive': 'uniworkDrive'
} as const

const HIDDEN_QUICK_CONNECTORS = new Set(['connector_wo_mail'])

function desktopConnectorId(name: string, entry: Record<string, unknown>): ConnectorId | null {
  const value = typeof entry.desktop_connector === 'string' ? entry.desktop_connector : name.replace(/^connector_/, '')

  return Object.hasOwn(CONNECTOR_SPECS, value) ? (value as ConnectorId) : null
}

export function ContextMenu({ state, onInsertText, onPickFiles, onPickFolders }: ContextMenuProps) {
  const { t } = useI18n()
  const c = t.composer
  const navigate = useNavigate()
  const developerMode = useStore($developerMode)
  // Prompt snippets used to be a Radix submenu. That submenu didn't open
  // reliably when the parent menu was positioned at the bottom of the
  // window (composer "+" anchor), so we promoted it to a real Dialog —
  // easier to grow with search / descriptions, and no positioning math.
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [open, setOpen] = useState(false)
  // `composer.attachments` contributions — plugin/core-registered rows that
  // extend this menu through the same registry as every other surface.
  const attachmentProviders = useComposerAttachmentProviders()

  return (
    <>
      <DropdownMenu onOpenChange={setOpen} open={open}>
        <Tip label={state.tools.label} placement="control">
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={state.tools.label}
              className={cn(
                GHOST_ICON_BTN,
                'data-[state=open]:bg-(--chrome-action-hover) data-[state=open]:text-foreground'
              )}
              disabled={!state.tools.enabled}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Plus className="size-5 text-(--ui-text-secondary)" strokeWidth={2.5} />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="start" className={cn('w-60', composerPanelCard)} side="top" sideOffset={6}>
          <DropdownMenuLabel className="px-2 pb-0.5 pt-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)">
            {c.attachLabel}
          </DropdownMenuLabel>
          <ContextMenuItem disabled={!onPickFiles} icon={FileText} onSelect={onPickFiles}>
            {c.files}
          </ContextMenuItem>
          <ContextMenuItem disabled={!onPickFolders} icon={FolderOpen} onSelect={onPickFolders}>
            {c.folder}
          </ContextMenuItem>
          {open && <CapabilitySubmenus onNavigate={navigate} />}
          {developerMode && (
            <>
              <DropdownMenuSeparator />
              <ContextMenuItem icon={MessageSquareText} onSelect={() => setSnippetsOpen(true)}>
                {c.promptSnippets}
              </ContextMenuItem>
            </>
          )}

          {attachmentProviders.length > 0 && <DropdownMenuSeparator />}
          {attachmentProviders.map(provider => (
            <DropdownMenuItem
              className="text-[length:var(--conversation-tool-font-size)] focus:bg-(--ui-bg-tertiary)"
              key={provider.key}
              onSelect={() => void provider.run({ insertText: onInsertText })}
            >
              <Codicon name={provider.icon ?? 'plug'} size="0.875rem" />
              <span>{provider.label}</span>
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />

          <div className="px-2 py-1 text-[0.7rem] text-muted-foreground/80">
            {c.tipPre}
            <Kbd size="sm">@</Kbd>
            {c.tipPost}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      {developerMode && (
        <PromptSnippetsDialog onInsertText={onInsertText} onOpenChange={setSnippetsOpen} open={snippetsOpen} />
      )}
    </>
  )
}

/**
 * The quick capability layer mirrors HexAgent's input-settings menu: it loads
 * the active profile only while the composer menu is open; skill switches
 * persist immediately. Standard MCPs are checked before enabling. Desktop
 * connectors instead go through their owned OAuth/credential flow, rather
 * than being incorrectly probed as a standalone MCP URL.
 */
function CapabilitySubmenus({ onNavigate }: { onNavigate: ReturnType<typeof useNavigate> }) {
  const { t } = useI18n()
  const c = t.composer
  const profile = useStore($activeGatewayProfile)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [servers, setServers] = useState<McpServers | null>(null)
  const [pending, setPending] = useState<null | string>(null)

  useEffect(() => {
    let current = true
    setSkills(null)
    setServers(null)

    void Promise.resolve()
      .then(() => getSkills(profile))
      .then(rows => current && setSkills(rows))
      .catch(() => current && setSkills([]))
    void Promise.resolve()
      .then(() => getHermesConfigRecord(profile))
      .then(config => current && setServers(getServers(config)))
      .catch(() => current && setServers({}))

    return () => {
      current = false
    }
  }, [profile])

  const setSkill = async (skill: SkillInfo, enabled: boolean) => {
    if (pending) {
      return
    }

    setPending(`skill:${skill.name}`)
    setSkills(current => current?.map(row => (row.name === skill.name ? { ...row, enabled } : row)) ?? null)

    try {
      await setSkillEnabled(skill.name, enabled, profile)
    } catch (error) {
      notifyError(error, c.manageSkills)
      void getSkills(profile)
        .then(setSkills)
        .catch(() => undefined)
    } finally {
      setPending(null)
    }
  }

  const setConnector = async (name: string, enabled: boolean) => {
    if (!servers || pending) {
      return
    }

    setPending(`connector:${name}`)

    try {
      const connectorId = desktopConnectorId(name, servers[name])

      if (connectorId && enabled) {
        const desktop = window.hermesDesktop

        const local =
          typeof desktop?.localConnectors === 'function' &&
          (await desktop.getConnectionConfig(profile)).mode === 'local'

        const connected =
          local &&
          (await desktop.localConnectors({ operation: 'list', profile })).connectors.some(
            row => row.id === connectorId && row.connected
          )

        if (!connected) {
          onNavigate(`${CAPABILITIES_ROUTE}?tab=connectors&recommended=${connectorId}&connect=1`)

          return
        }

        await desktop.localConnectors({ operation: 'enable', profile, id: connectorId })
        const config = await getHermesConfigRecord(profile)
        setServers(getServers(config))
        await reloadMcpServers(profile)

        return
      }

      if (enabled) {
        const probe = await testMcpServer(name, profile)

        if (!probe.ok) {
          throw new Error(probe.error || `Could not connect to ${name}.`)
        }
      }

      const next = { ...servers, [name]: withEnabled(servers[name], enabled) }
      await saveMcpServers(next, profile)
      setServers(next)
      await reloadMcpServers(profile)
    } catch (error) {
      notifyError(error, c.manageConnectors)
    } finally {
      setPending(null)
    }
  }

  const keepOpen = (event: Event) => event.preventDefault()

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-[length:var(--conversation-tool-font-size)] focus:bg-(--ui-bg-tertiary)">
          <Brain />
          <span>{c.skills}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-72 p-1" sideOffset={6}>
          <div className="max-h-72 overflow-y-auto">
            {skills === null ? (
              <QuickMenuNotice>{c.loading}</QuickMenuNotice>
            ) : skills.length === 0 ? (
              <QuickMenuNotice>{c.noSkills}</QuickMenuNotice>
            ) : (
              skills.map(skill => (
                <DropdownMenuItem className="gap-3" key={skill.name} onSelect={keepOpen}>
                  <span className="min-w-0 flex-1 truncate">{skill.name}</span>
                  <Switch
                    aria-label={skill.name}
                    checked={skill.enabled}
                    disabled={pending !== null}
                    onCheckedChange={enabled => void setSkill(skill, enabled)}
                    onClick={event => event.stopPropagation()}
                    size="xs"
                  />
                </DropdownMenuItem>
              ))
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onNavigate(`${CAPABILITIES_ROUTE}?tab=skills`)}>
            <Settings />
            <span>{c.manageSkills}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="text-[length:var(--conversation-tool-font-size)] focus:bg-(--ui-bg-tertiary)">
          <Plug />
          <span>{c.connectors}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="w-72 p-1" sideOffset={6}>
          <div className="max-h-72 overflow-y-auto">
            {servers === null ? (
              <QuickMenuNotice>{c.loading}</QuickMenuNotice>
            ) : Object.keys(servers).length === 0 ? (
              <QuickMenuNotice>{c.noConnectors}</QuickMenuNotice>
            ) : (
              Object.entries(servers)
                .filter(([name]) => !HIDDEN_QUICK_CONNECTORS.has(name))
                .map(([name, entry]) => {
                  const enabled = serverEnabled(entry)
                  const busy = pending === `connector:${name}`
                  const connectorId = desktopConnectorId(name, entry)
                  const nameKey = QUICK_CONNECTOR_NAMES[name as keyof typeof QUICK_CONNECTOR_NAMES]

                  const label = connectorId
                    ? t.connectorsPage.recommended.catalog[connectorId].name
                    : nameKey
                      ? c.quickConnectorNames[nameKey]
                      : name

                  return (
                    <DropdownMenuItem className="gap-3" key={name} onSelect={keepOpen}>
                      <span className="min-w-0 flex-1 truncate">{label}</span>
                      <Switch
                        aria-label={label}
                        checked={enabled}
                        disabled={pending !== null}
                        onCheckedChange={next => void setConnector(name, next)}
                        onClick={event => event.stopPropagation()}
                        pending={busy}
                        size="xs"
                      />
                    </DropdownMenuItem>
                  )
                })
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => onNavigate(`${CAPABILITIES_ROUTE}?tab=connectors`)}>
            <Settings />
            <span>{c.manageConnectors}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    </>
  )
}

function QuickMenuNotice({ children }: { children: string }) {
  return <p className="px-2 py-1.5 text-xs text-(--ui-text-tertiary)">{children}</p>
}

function PromptSnippetsDialog({ onInsertText, onOpenChange, open }: PromptSnippetsDialogProps) {
  const { t } = useI18n()
  const c = t.composer

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{c.snippetsTitle}</DialogTitle>
          <DialogDescription>{c.snippetsDesc}</DialogDescription>
        </DialogHeader>
        <ul className="grid gap-1">
          {SNIPPET_KEYS.map(key => {
            const snippet = c.snippets[key]

            return (
              <li key={key}>
                <button
                  className="group/snippet flex w-full cursor-pointer items-start gap-2.5 rounded-md border border-transparent px-2.5 py-2 text-left transition-colors hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-control-hover-background) focus-visible:border-(--ui-stroke-tertiary) focus-visible:bg-(--ui-control-hover-background) focus-visible:outline-none"
                  onClick={() => {
                    onInsertText(snippet.text)
                    onOpenChange(false)
                  }}
                  type="button"
                >
                  <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-(--ui-text-tertiary) group-hover/snippet:text-foreground" />
                  <span className="grid min-w-0 gap-0.5">
                    <span className="text-sm font-medium text-foreground">{snippet.label}</span>
                    <span className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                      {snippet.description}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </DialogContent>
    </Dialog>
  )
}

export function ContextMenuItem({ children, disabled, icon: Icon, onSelect }: ContextMenuItemProps) {
  return (
    // Override font size + highlight to match the / · @ completion rows exactly.
    <DropdownMenuItem
      className="text-[length:var(--conversation-tool-font-size)] focus:bg-(--ui-bg-tertiary)"
      disabled={disabled}
      onSelect={onSelect}
    >
      <Icon />
      <span>{children}</span>
    </DropdownMenuItem>
  )
}

interface ContextMenuItemProps {
  children: string
  disabled?: boolean
  icon: IconComponent
  onSelect?: () => void
}

interface ContextMenuProps {
  onInsertText: (text: string) => void
  onPickFiles?: () => void
  onPickFolders?: () => void
  state: ChatBarState
}

interface PromptSnippetsDialogProps {
  onInsertText: (text: string) => void
  onOpenChange: (open: boolean) => void
  open: boolean
}
