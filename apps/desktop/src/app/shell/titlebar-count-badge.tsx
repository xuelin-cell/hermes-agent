import { compactNumber } from '@hermes/shared'
import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'

/**
 * 标题栏图标角标：图标 + 右上角计数。
 *
 * 会话未读和消息中心共用这一套比例 —— 同一排按钮上出现两种角标会显得不成体系。
 * `overlay` 角标只有 8px 高，位数一多就挤，所以计数统一走 compactNumber
 * （999 → "999"，1230 → "1.2k"），不在调用侧各写一套上限。
 */
export function withCountBadge(icon: ReactNode, count: number | undefined): ReactNode {
  if (!count) {
    return icon
  }

  return (
    <span className="relative inline-flex">
      {icon}
      <span className="pointer-events-none absolute -top-2.5 -right-1.5 z-1">
        <Badge aria-hidden size="overlay" variant="solid">
          {compactNumber(count)}
        </Badge>
      </span>
    </span>
  )
}
