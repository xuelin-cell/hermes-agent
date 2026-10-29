import { useStore } from '@nanostores/react'

import { useMaasAccount } from '@/app/shell/maas-account-status'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useI18n } from '@/i18n'
import { Bell } from '@/lib/icons'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import {
  $announcements,
  $messageCenterOpen,
  $unreadAnnouncements,
  markAllAnnouncementsRead,
  markAnnouncementRead,
  toggleMessageCenter
} from '@/store/message-center'

import { titlebarButtonClass } from '../titlebar'
import { withCountBadge } from '../titlebar-count-badge'

import { useNtfySubscription } from './use-ntfy-subscription'

/** 只有桌面端（preload 暴露了 ntfy 通道）才显示消息中心。 */
export function messageCenterAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.hermesDesktop?.ntfy
}

/**
 * 订阅跟随当前账号：登录后自动建立，退出登录断开并清走上一个账号的公告。
 * 本身不渲染任何东西，挂在应用外壳里。
 */
export function MessageCenterSync() {
  const account = useMaasAccount()
  useNtfySubscription(account?.maskedPhone ?? null)

  return null
}

/** 标题栏铃铛：未读角标 + 弹出的消息中心列表。 */
export function MessageCenterBell() {
  const { t } = useI18n()
  const copy = t.messageCenter
  const unread = useStore($unreadAnnouncements)
  const announcements = useStore($announcements)
  const open = useStore($messageCenterOpen)

  return (
    <Popover onOpenChange={next => toggleMessageCenter(next)} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-label={unread > 0 ? copy.unreadCount(unread) : copy.title}
          className={cn(titlebarButtonClass, 'bg-transparent select-none')}
          data-tour="message-center"
          onPointerDown={event => event.stopPropagation()}
          size="icon-titlebar"
          type="button"
          variant="ghost"
        >
          {withCountBadge(<Bell className="size-4" />, unread)}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0" side="bottom" sideOffset={6}>
        <div className="flex items-center justify-between gap-2 border-b border-(--ui-stroke-tertiary) px-3 py-2">
          <span className="text-sm font-medium">{copy.title}</span>
          <Button
            className="h-auto py-0 text-xs font-medium text-muted-foreground"
            disabled={unread === 0}
            onClick={() => markAllAnnouncementsRead()}
            size="xs"
            type="button"
            variant="text"
          >
            {copy.markAllRead}
          </Button>
        </div>
        {announcements.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">{copy.empty}</p>
        ) : (
          <ul className="max-h-96 overflow-y-auto py-1">
            {announcements.map(item => (
              <li key={item.id}>
                <button
                  className={cn(
                    'flex w-full items-start gap-2 rounded-md px-3 py-2 text-left hover:bg-(--ui-control-hover-background)',
                    item.readAt === null && 'bg-(--ui-bg-elevated)/40'
                  )}
                  onClick={() => markAnnouncementRead(item.id)}
                  type="button"
                >
                  <span
                    aria-hidden
                    className={cn(
                      'mt-1.5 size-1.5 shrink-0 rounded-full',
                      item.readAt === null ? 'bg-(--dt-primary-solid)' : 'bg-transparent'
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-sm font-medium',
                        item.priority >= 4 && 'text-destructive'
                      )}
                    >
                      {item.title || copy.untitled}
                    </span>
                    {item.text && (
                      <span className="mt-0.5 block line-clamp-3 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                        {item.text}
                      </span>
                    )}
                    <span className="mt-1 flex items-center gap-1 text-[0.66rem] text-muted-foreground/80">
                      {item.priority >= 4 && <Codicon name="warning" size="0.7rem" />}
                      {relativeTime(item.at)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
