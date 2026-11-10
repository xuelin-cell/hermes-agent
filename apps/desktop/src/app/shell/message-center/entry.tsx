import { useStore } from '@nanostores/react'
import { useLocation, useNavigate } from 'react-router'

import { navigateToWorkspacePage, NOTIFICATIONS_ROUTE } from '@/app/routes'
import { Button } from '@/components/ui/button'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Bell } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $unreadAnnouncements } from '@/store/message-center'

import { withCountBadge } from '../titlebar-count-badge'

/**
 * 通知入口（仍在桌面端 preload 暴露 ntfy 时才有意义，由调用方判定）。
 *
 * 位置在侧栏底部账号行、账号控件的右侧；点击走工作区整页路由，不再展开
 * 浮层 —— 离开时点任意会话或导航项即可，路由本身承载状态，没有额外开关。
 *
 * 入口恒常存在（不随通知条数显隐），未读数只决定角标。
 */
export function MessageCenterEntry() {
  const { t } = useI18n()
  const copy = t.messageCenter
  const unread = useStore($unreadAnnouncements)
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const active = pathname === NOTIFICATIONS_ROUTE

  return (
    <Tip label={copy.open}>
      <Button
        aria-current={active ? 'page' : undefined}
        aria-label={unread > 0 ? copy.unreadCount(unread) : copy.title}
        className={cn(
          'relative size-11 shrink-0 rounded-xl text-(--ui-text-secondary) transition-colors hover:bg-(--ui-control-hover-background) hover:text-foreground',
          active && 'bg-(--ui-control-active-background) text-foreground'
        )}
        data-tour="message-center"
        // 与工作区页面同一条导航路径：已在页面上再点一次也会把窗格提到前台。
        onClick={() => navigateToWorkspacePage(navigate, NOTIFICATIONS_ROUTE)}
        size="icon"
        type="button"
        variant="ghost"
      >
        {withCountBadge(<Bell className="size-4" />, unread)}
      </Button>
    </Tip>
  )
}
