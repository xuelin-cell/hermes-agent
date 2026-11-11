import { useState } from 'react'

import { Input } from '@/components/ui/input'

import { type OverlayNavGroup, OverlayNavItem, OverlaySidebar } from '../overlays/overlay-split-layout'

import { useSettingsRedesignCopy } from './redesign-copy'

const keywords: Record<string, string> = {
  general:
    '语言 語言 language 主题 主題 theme 防休眠 sleep 工作空间 工作空間 workspace 隐私 隱私 privacy 资料库 資料庫 library',
  models: '模型 model api 自定义 自訂',
  messaging: '微信 钉钉 飛書 飞书 企业微信 手机 手機 上下文 context 历史 歷史 history 压缩 壓縮 compression',
  sessions: '归档 封存 archive 恢复 還原 restore 删除 刪除 delete',
  help: '反馈 回報 feedback 日志 日誌 logs 截图 截圖 screenshot 文档 文件 docs'
}

const sectionOrder = [
  'general',
  'config:appearance',
  'keybinds',
  'notifications',
  'models',
  'messaging',
  'sessions',
  'config:safety',
  'about',
  'help'
]

const sectionFor = (id: string) => {
  if (['general', 'config:appearance', 'keybinds', 'notifications'].includes(id)) {
    return 'settings'
  }

  if (['sessions', 'config:safety', 'vault'].includes(id)) {
    return 'data'
  }

  if (['about', 'help', 'billing'].includes(id)) {
    return 'other'
  }

  return 'features'
}

export function GroupedSettingsNavigation({ groups, footer }: { groups: OverlayNavGroup[]; footer?: React.ReactNode }) {
  const copy = useSettingsRedesignCopy()
  const [query, setQuery] = useState('')

  const filtered = groups.filter(group =>
    [group.label, keywords[group.id] ?? '', ...(group.children?.map(child => child.label) ?? [])].some(label =>
      label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
    )
  )

  return (
    <OverlaySidebar className="settings-redesign-nav">
      <Input
        aria-label={copy('search')}
        onChange={event => setQuery(event.target.value)}
        placeholder={copy('search')}
        value={query}
      />
      <nav aria-label={copy('settings')} className="min-h-0 flex-1 overflow-y-auto">
        {(['settings', 'features', 'data', 'other'] as const).map(section => {
          const items = filtered
            .filter(group => sectionFor(group.id) === section)
            .sort(
              (a, b) =>
                (sectionOrder.indexOf(a.id) < 0 ? 100 : sectionOrder.indexOf(a.id)) -
                (sectionOrder.indexOf(b.id) < 0 ? 100 : sectionOrder.indexOf(b.id))
            )

          return items.length ? (
            <section className="mb-3" key={section}>
              <h2 className="px-2 pb-1 pt-3 text-xs text-(--ui-text-tertiary)">{copy(section)}</h2>
              {items.map(group => (
                <div key={group.id}>
                  <OverlayNavItem
                    active={group.active}
                    icon={group.icon}
                    id={group.id}
                    label={group.label}
                    onClick={group.onSelect}
                  />
                  {group.active &&
                    !['sessions', 'config:safety'].includes(group.id) &&
                    group.children?.map(child => (
                      <OverlayNavItem
                        active={child.active}
                        icon={child.icon}
                        key={child.id}
                        label={child.label}
                        nested
                        onClick={child.onSelect}
                      />
                    ))}
                </div>
              ))}
            </section>
          ) : null
        })}
      </nav>
      {footer}
    </OverlaySidebar>
  )
}
