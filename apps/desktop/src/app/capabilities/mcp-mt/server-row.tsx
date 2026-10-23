import { useEffect, useId, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Switch } from '@/components/ui/switch'
import { useI18n } from '@/i18n'
import { NEEDS_AUTH_RE } from '@/lib/mcp-probe-cache'
import { serverEnabled } from '@/lib/mcp-servers'
import { cn } from '@/lib/utils'

import type { LocalServerInput } from '../connectors/types'
import { canAuthenticate, okProbe, STATUS_DOT } from '../mcp/mcp-status'
import type { McpServersController } from '../mcp/use-mcp-servers'

import { ServerFormFields } from './server-form'
import {
  blankForm,
  builtInServerSummary,
  formatArgs,
  formFromEntry,
  type FormTransport,
  isBuiltInServer,
  type ServerForm,
  transportOf
} from './server-form-model'
import type { ServerEdits } from './use-server-edits'

type RowStatus = { count: number; kind: 'ok' } | { kind: 'connecting' } | { kind: 'failed' } | null

export interface McpServerRowProps {
  controller: McpServersController
  edits: ServerEdits
  expanded: boolean
  id: string
  /** 已保存服务的名称；新建未保存的行为 null。 */
  name: null | string
  newTransport?: FormTransport
  onExpand: () => void
  onRemove: () => void
}

/** 一行 MCP 服务：名称、类型、连接状态、开关和删除；展开后是配置表单。 */
export function McpServerRow({
  controller,
  edits,
  expanded,
  id,
  name,
  newTransport = 'http',
  onExpand,
  onRemove
}: McpServerRowProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.mcpLocal
  const panelId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const entry = name ? controller.servers[name] : undefined
  const builtIn = isBuiltInServer(name)
  const enabled = entry ? serverEnabled(entry) : false
  const checking = name !== null && edits.checking.has(name)
  const failure = name ? edits.failures[name] : undefined
  const busy = controller.profilePending || controller.saving
  const status = rowStatus()
  const title = name || copy.untitled
  const transport = entry ? transportOf(entry) : newTransport

  // 选中传输类型后，新建行可能落在当前视口下方；让最近的滚动容器主动揭示完整表单。
  useEffect(() => {
    if (expanded) {
      panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [expanded])

  /** 状态与 UniWork 相同：开启验证中、启用后的测试结果，或刚才开启失败。 */
  function rowStatus(): RowStatus {
    if (checking) {
      return { kind: 'connecting' }
    }

    if (failure !== undefined) {
      return { kind: 'failed' }
    }

    if (!name || !enabled) {
      return null
    }

    const state = controller.statuses[name]

    if (state === 'probing') {
      return { kind: 'connecting' }
    }

    if (state === 'error' || state === 'needs-auth') {
      return { kind: 'failed' }
    }

    const probe = okProbe(controller.probes[name])

    return probe ? { count: controller.toolCounts[name]?.on ?? probe.tools.length, kind: 'ok' } : null
  }

  /** 折叠时的一行摘要：内置服务显示简介，其余显示地址或命令。 */
  function summary(): string {
    if (builtIn) {
      const summary = builtInServerSummary(name)

      return summary ? copy[summary] : ''
    }

    if (!entry) {
      return transport === 'http' ? copy.noUrl : copy.noCommand
    }

    if (transport === 'http') {
      return typeof entry.url === 'string' && entry.url ? entry.url : copy.noUrl
    }

    const line = [typeof entry.command === 'string' ? entry.command : '', formatArgs(entry.args)].join(' ').trim()

    return line || copy.noCommand
  }

  return (
    <article aria-label={title} className="min-w-0">
      <div className="flex items-center gap-3 py-3">
        <button
          aria-controls={panelId}
          aria-expanded={expanded}
          className="grid min-w-0 flex-1 gap-1 text-left"
          onClick={onExpand}
          type="button"
        >
          <span className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium">{title}</span>
            <Badge variant="muted">{transport.toUpperCase()}</Badge>
            {builtIn && <Badge variant="muted">{copy.builtInTag}</Badge>}
            {status && <StatusTag status={status} />}
          </span>
          <span className="truncate text-xs text-(--ui-text-tertiary)">{summary()}</span>
        </button>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            aria-label={
              enabled ? t.connectorsPage.card.turnServerOff(title) : t.connectorsPage.card.turnServerOn(title)
            }
            checked={enabled || checking}
            className={cn(failure !== undefined && 'border-destructive')}
            disabled={!name || checking || busy}
            onCheckedChange={next => name && void edits.toggle(name, next)}
            size="xs"
          />
          {!builtIn && (
            <Button
              aria-label={t.connectorsPage.dialog.removeServerTitle(title)}
              disabled={checking || busy}
              onClick={onRemove}
              size="icon-xs"
              variant="ghost"
            >
              <Codicon name="trash" />
            </Button>
          )}
          <Codicon
            className="cursor-pointer text-(--ui-text-tertiary)"
            name={expanded ? 'chevron-down' : 'chevron-right'}
            onClick={onExpand}
          />
        </div>
      </div>
      {expanded && (
        <div
          className="grid gap-3 rounded-xl border border-(--ui-stroke-secondary) bg-(--ui-bg-quaternary) p-4 pb-5 sm:p-5"
          id={panelId}
          ref={panelRef}
        >
          <RowEditor
            controller={controller}
            edits={edits}
            id={id}
            name={name}
            readOnly={builtIn || checking || busy}
            transport={newTransport}
          />
          {failureText() && (
            <p className="whitespace-pre-wrap break-words text-xs text-destructive" role="alert">
              {failureText()}
            </p>
          )}
          {name && entry && canAuthenticate(entry, authStatus()) && (
            <Button
              className="justify-self-start"
              disabled={controller.authing === name || busy}
              onClick={() => {
                edits.dismissFailure(name)
                void controller.authenticate(name)
              }}
              size="xs"
              variant="secondary"
            >
              {t.settings.mcp.authenticate}
            </Button>
          )}
        </div>
      )}
    </article>
  )

  /** 展开后显示的失败原因：刚才开启失败，或启用中的服务测试失败。 */
  function failureText(): string {
    if (failure) {
      return failure
    }

    const probe = name ? controller.probes[name] : undefined

    return status?.kind === 'failed' && probe && probe !== 'probing' && !probe.ok ? (probe.error ?? '') : ''
  }

  /** 判断是否显示“授权”按钮所用的状态：开启失败时按失败原因归类。 */
  function authStatus() {
    if (failure !== undefined) {
      return NEEDS_AUTH_RE.test(failure) ? 'needs-auth' : 'error'
    }

    return (name && controller.statuses[name]) || 'unknown'
  }
}

interface RowEditorProps {
  controller: McpServersController
  edits: ServerEdits
  id: string
  name: null | string
  readOnly: boolean
  transport: FormTransport
}

/** 展开时才创建表单状态；输入只留在本行，由 `edits` 决定何时保存。 */
function RowEditor({ controller, edits, id, name, readOnly, transport }: RowEditorProps) {
  const [form, setForm] = useState<ServerForm>(() => {
    const entry = name ? controller.servers[name] : undefined

    return entry && name ? formFromEntry(name, entry) : blankForm(transport)
  })

  /** 更新本行表单并交给编辑逻辑。 */
  const change = (next: ServerForm) => {
    setForm(next)
    edits.edit(id, next)
  }

  return (
    <ServerFormFields
      autoFocusName={name === null && !readOnly}
      error={edits.errors[id] ?? null}
      form={form}
      onChange={change}
      readOnly={readOnly}
    />
  )
}

/** UniWork 同款状态标签：连接中、N 个工具可用、失败。 */
function StatusTag({ status }: { status: NonNullable<RowStatus> }) {
  const { t } = useI18n()
  const copy = t.connectorsPage.mcpLocal

  const view = {
    connecting: { dot: STATUS_DOT.probing, text: copy.connecting, tone: 'text-(--ui-text-tertiary)' },
    failed: { dot: STATUS_DOT.error, text: copy.failed, tone: 'text-destructive' },
    ok: { dot: STATUS_DOT.ok, text: '', tone: 'text-emerald-600 dark:text-emerald-300' }
  }[status.kind]

  return (
    <span className={cn('inline-flex items-center gap-1 text-[0.65rem]', view.tone)}>
      <span className={cn('size-1.5 rounded-full', view.dot)} />
      {status.kind === 'ok' ? copy.toolsAvailable(status.count) : view.text}
    </span>
  )
}

export interface PluginServerRowProps {
  onOpenPlugins: () => void
  row: LocalServerInput
}

/** 插件提供的服务只读展示，管理入口在插件页。 */
export function PluginServerRow({ onOpenPlugins, row }: PluginServerRowProps) {
  const { t } = useI18n()
  const copy = t.connectorsPage.mcpLocal

  const status: RowStatus =
    row.status === 'ok'
      ? { count: row.toolsTotal ?? 0, kind: 'ok' }
      : row.status === 'probing'
        ? { kind: 'connecting' }
        : row.status === 'error' || row.status === 'needs-auth'
          ? { kind: 'failed' }
          : null

  return (
    <article aria-label={row.name} className="flex min-w-0 items-center gap-3 py-3">
      <div className="grid min-w-0 flex-1 gap-1">
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium">{row.title ?? row.name}</span>
          {status && <StatusTag status={status} />}
        </span>
        <span className="truncate text-xs text-(--ui-text-tertiary)">
          {t.connectorsPage.dialog.providedByPlugin(row.plugin ?? '')}
        </span>
      </div>
      <Button onClick={onOpenPlugins} size="xs" variant="secondary">
        {copy.openPlugins}
      </Button>
    </article>
  )
}
