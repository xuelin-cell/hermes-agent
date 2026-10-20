import type { KeyboardEvent, ReactNode } from 'react'
import { useState } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  dropdownMenuRow,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { FileText, Loader2, MoreVertical, Plus, Trash2 } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { type InstalledBadge, skillColor, skillInitials, usableIconUrl } from './catalog'
import { useSkillsCopy } from './copy'

/** 有可用图片就显示图片，否则是按名称算颜色的两字母方块；图片加载失败也退回方块。 */
export function SkillTile({ iconUrl, name }: { iconUrl?: string | null; name: string }) {
  const [failed, setFailed] = useState(false)
  const url = failed ? null : usableIconUrl(iconUrl)

  if (url) {
    return <img alt="" className="mt-skills-card-icon" onError={() => setFailed(true)} src={url} />
  }

  return (
    <div aria-hidden className="mt-skills-card-icon" style={{ background: skillColor(name) }}>
      {skillInitials(name)}
    </div>
  )
}

function openOnKey(event: KeyboardEvent, open: () => void) {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    open()
  }
}

interface CardShellProps {
  actions: ReactNode
  children: ReactNode
  iconUrl?: string | null
  name: string
  off?: boolean
  onOpen?: () => void
}

/** 卡片外壳：左上图标、右上操作（点操作不触发整卡的打开）。 */
function CardShell({ actions, children, iconUrl, name, off, onOpen }: CardShellProps) {
  return (
    <div
      className="mt-skills-card"
      data-off={off ? '' : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? event => openOnKey(event, onOpen) : undefined}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
    >
      <div className="mt-skills-card-top">
        <SkillTile iconUrl={iconUrl} name={name} />
        <div
          className="mt-skills-card-actions"
          onClick={event => event.stopPropagation()}
          onKeyDown={event => event.stopPropagation()}
        >
          {actions}
        </div>
      </div>
      {children}
    </div>
  )
}

interface CatalogCardProps {
  description: string
  iconUrl?: string | null
  installable: boolean
  installed: boolean
  installing: boolean
  name: string
  onInstall: () => void
  onTry: () => void
  provider?: string
}

/** 推荐 / 技能市场的卡片：没装是「+」，装好了变「去试试」。 */
export function CatalogCard({
  description,
  iconUrl,
  installable,
  installed,
  installing,
  name,
  onInstall,
  onTry,
  provider
}: CatalogCardProps) {
  const t = useSkillsCopy()

  const actions = installing ? (
    <button className="mt-skills-card-add" disabled type="button">
      <Loader2 className="size-4 animate-spin" />
    </button>
  ) : installed ? (
    <button className="mt-skills-card-try" onClick={onTry} type="button">
      {t('try')}
    </button>
  ) : (
    <button
      aria-label={installable ? t('add') : t('noPackage')}
      className="mt-skills-card-add"
      disabled={!installable}
      onClick={onInstall}
      title={installable ? t('add') : t('noPackage')}
      type="button"
    >
      <Plus className="size-4" />
    </button>
  )

  return (
    <CardShell actions={actions} iconUrl={iconUrl} name={name}>
      <div className="mt-skills-card-name">
        <span title={name}>{name}</span>
      </div>
      <div className="mt-skills-card-desc">{description}</div>
      {provider ? <div className="mt-skills-card-meta">{provider}</div> : null}
    </CardShell>
  )
}

const BADGE_TEXT = { bundled: 'badgeBundled', market: 'badgeMarket', agent: 'badgeAgent' } as const

interface InstalledCardProps {
  badge: InstalledBadge
  busy: boolean
  description: string
  enabled: boolean
  name: string
  onDetail: () => void
  onToggle: (next: boolean) => void
  onTry: () => void
  onUninstall?: () => void
}

/** 已安装的卡片：去试试、启用开关、⋮（详情、卸载）；整卡点开是详情。 */
export function InstalledCard({
  badge,
  busy,
  description,
  enabled,
  name,
  onDetail,
  onToggle,
  onTry,
  onUninstall
}: InstalledCardProps) {
  const t = useSkillsCopy()

  const actions = (
    <>
      {enabled ? (
        <button className="mt-skills-card-try" onClick={onTry} type="button">
          {t('try')}
        </button>
      ) : null}
      <Switch
        aria-label={enabled ? t('turnOff') : t('turnOn')}
        checked={enabled}
        className="mx-1"
        disabled={busy}
        onCheckedChange={onToggle}
        title={enabled ? t('turnOff') : t('turnOn')}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button aria-label={t('more')} className="mt-skills-card-more" type="button">
            <MoreVertical className="size-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem className={dropdownMenuRow} onSelect={onDetail}>
            <FileText className="size-3.5" />
            {t('detail')}
          </DropdownMenuItem>
          {onUninstall ? (
            <DropdownMenuItem
              className={cn(dropdownMenuRow, 'text-destructive focus:text-destructive')}
              onSelect={onUninstall}
            >
              <Trash2 className="size-3.5" />
              {t('uninstall')}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )

  return (
    <CardShell actions={actions} name={name} off={!enabled} onOpen={onDetail}>
      <div className="mt-skills-card-name">
        <span title={name}>{name}</span>
        <span
          className={cn(
            'mt-skills-badge',
            badge === 'market' && 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-300'
          )}
          data-kind={badge}
        >
          {t(BADGE_TEXT[badge])}
        </span>
      </div>
      <div className="mt-skills-card-desc">{description || (enabled ? '' : t('disabledHint'))}</div>
    </CardShell>
  )
}
