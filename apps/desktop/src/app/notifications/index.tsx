import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { EmptyState } from '@/components/ui/empty-state'
import { useI18n } from '@/i18n'
import { Bell } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { $announcements, markAnnouncementRead } from '@/store/message-center'

// 通知整页：标题居中 + 按天分组的平铺列表（无卡片底、无分隔线），条目为
// 圆形图标 + 标题/正文两行；未读用标题色与字重表达，不再额外画圆点。
// 行右侧预留了操作区（截图里的「立即关联 / 前往查看」）——公告契约目前没有
// 动作字段，按本次要求不渲染、也不新增点击逻辑。
// header 右侧不承载任何状态/动作，只靠三等分列保证标题居中不偏移。
function dayLabel(at: number): string {
  const date = new Date(at)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${date.getFullYear()}-${month}-${day}`
}

export function NotificationsView() {
  const { t } = useI18n()
  const copy = t.messageCenter
  const announcements = useStore($announcements)

  // 公告已按时间倒序到达，这里只做「连续同一天」切块，顺序不变。
  const groups = useMemo(() => {
    const byDay = new Map<string, (typeof announcements)[number][]>()

    for (const item of announcements) {
      const label = dayLabel(item.at)
      const bucket = byDay.get(label)

      if (bucket) {
        bucket.push(item)
      } else {
        byDay.set(label, [item])
      }
    }

    return [...byDay].map(([label, items]) => ({ items, label }))
  }, [announcements])

  return (
    <section className="flex h-full min-h-0 flex-col bg-(--ui-chat-surface-background)">
      {/* 1fr/auto/1fr 三等分：两侧空列让标题相对页面真正居中，且不占位。 */}
      <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-6 pb-1 pt-4">
        <span aria-hidden />
        <h1 className="text-[0.9375rem] font-medium text-foreground">{copy.title}</h1>
        <span aria-hidden />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
        {groups.length === 0 ? (
          <div className="mx-auto w-full max-w-[72rem] px-6 pt-10">
            <EmptyState description={copy.emptyHint} title={copy.empty} />
          </div>
        ) : (
          <div className="mx-auto w-full max-w-[72rem] px-6 pb-16">
            {groups.map(group => (
              <section className="pt-4" key={group.label}>
                <h2 className="pb-1 pl-1 text-xs font-normal text-(--ui-text-tertiary)">{group.label}</h2>
                <ul>
                  {group.items.map(item => {
                    const unreadItem = item.readAt === null

                    return (
                      <li key={item.id}>
                        {/* 单条通知点击即标记已读，保持原浮层的语义。 */}
                        <button
                          aria-label={item.title || copy.untitled}
                          className="flex w-full items-start gap-3 rounded-lg px-1 py-2.5 text-left transition-colors hover:bg-(--ui-control-hover-background)"
                          onClick={() => markAnnouncementRead(item.id)}
                          type="button"
                        >
                          <span
                            aria-hidden
                            className={cn(
                              'mt-px grid size-9 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 transition-opacity dark:text-emerald-300',
                              !unreadItem && 'opacity-60'
                            )}
                          >
                            <Bell className="size-[1.125rem]" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span
                              className={cn(
                                'block truncate text-sm leading-6',
                                unreadItem ? 'font-medium text-foreground' : 'text-muted-foreground',
                                item.priority >= 4 && 'text-destructive'
                              )}
                            >
                              {item.title || copy.untitled}
                            </span>
                            {item.text && (
                              <span className="mt-0.5 block line-clamp-2 text-[0.8125rem] leading-5 text-muted-foreground">
                                {item.text}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
