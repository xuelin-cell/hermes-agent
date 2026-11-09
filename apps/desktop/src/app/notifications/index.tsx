import { useStore } from '@nanostores/react'
import { useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { EmptyState } from '@/components/ui/empty-state'
import { useI18n } from '@/i18n'
import { Bell } from '@/lib/icons'
import { relativeTime } from '@/lib/time'
import { cn } from '@/lib/utils'
import { $announcements, $unreadAnnouncements, markAllAnnouncementsRead, markAnnouncementRead } from '@/store/message-center'

import { PAGE_INSET_X } from '../layout-constants'
import { PageSearchShell } from '../page-search-shell'

// 通知整页（原标题栏铃铛的浮层）：工作区路由页，与资料库/连接手机同构 ——
// 由 ChatRoutesSurface 的 <Route> 挂载，占满工作区窗格而不是盖在聊天上。
// 数据、已读语义与账号分区完全沿用 store/message-center，不在这里另存一份。
export function NotificationsView() {
  const { t } = useI18n()
  const copy = t.messageCenter
  const announcements = useStore($announcements)
  const unread = useStore($unreadAnnouncements)
  const [query, setQuery] = useState('')

  const needle = query.trim().toLocaleLowerCase()

  const items = useMemo(
    () =>
      needle
        ? announcements.filter(item => `${item.title} ${item.text}`.toLocaleLowerCase().includes(needle))
        : announcements,
    [announcements, needle]
  )

  return (
    <PageSearchShell
      onSearchChange={setQuery}
      searchPlaceholder={copy.search}
      searchTrailingAction={
        <Button
          disabled={unread === 0}
          onClick={() => markAllAnnouncementsRead()}
          size="sm"
          type="button"
          variant="outline"
        >
          {copy.markAllRead}
        </Button>
      }
      searchValue={query}
    >
      <div className={cn('h-full overflow-y-auto pb-10 pt-4', PAGE_INSET_X)}>
        <div className="mx-auto w-full max-w-3xl space-y-3">
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="flex items-center gap-2 text-sm font-semibold leading-5">
              <Bell className="size-4 text-(--ui-text-tertiary)" />
              {copy.title}
            </h1>
            {/* 未读数沿用铃铛的同一份 computed atom，页面与入口不会漂移。 */}
            <p aria-live="polite" className="text-xs leading-5 text-(--ui-text-tertiary)">
              {unread > 0 ? copy.unreadCount(unread) : copy.allRead}
            </p>
          </header>

          {items.length === 0 ? (
            <EmptyState description={needle ? undefined : copy.emptyHint} title={needle ? copy.noResults : copy.empty} />
          ) : (
            <ul className="space-y-1.5">
              {items.map(item => {
                const unreadItem = item.readAt === null

                return (
                  <li key={item.id}>
                    {/* 单条通知点击即标记已读，保持原浮层的语义。 */}
                    <button
                      aria-label={item.title || copy.untitled}
                      className={cn(
                        'flex w-full items-start gap-3 rounded-xl px-4 py-3 text-left transition-colors',
                        unreadItem
                          ? 'bg-(--ui-bg-elevated)/60 hover:bg-(--ui-bg-elevated)'
                          : 'hover:bg-(--ui-control-hover-background)'
                      )}
                      onClick={() => markAnnouncementRead(item.id)}
                      type="button"
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'mt-1.5 size-1.5 shrink-0 rounded-full',
                          unreadItem ? 'bg-primary' : 'bg-transparent'
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate text-sm',
                            unreadItem ? 'font-semibold' : 'font-medium text-muted-foreground',
                            item.priority >= 4 && 'text-destructive'
                          )}
                        >
                          {item.title || copy.untitled}
                        </span>
                        {item.text && (
                          <span className="mt-0.5 block whitespace-pre-wrap break-words text-xs text-muted-foreground">
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
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </PageSearchShell>
  )
}
