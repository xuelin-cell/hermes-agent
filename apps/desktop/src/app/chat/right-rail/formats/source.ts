import { useStore } from '@nanostores/react'

import { desktopFsCacheKey } from '@/lib/desktop-fs'
import { downloadGatewayFileWithFeedback } from '@/lib/media'
import { revealFile } from '@/store/file-actions'
import type { PreviewTarget } from '@/store/preview'
import { $connection } from '@/store/session'

/** 在一处确定文件归属与失败出口，下载固定到显示该文件的连接。 */
export function usePreviewSource(target: PreviewTarget) {
  const connection = useStore($connection)
  const path = target.path || target.source || target.url
  const remote = connection?.mode === 'remote'

  return {
    exit: remote ? ('download' as const) : ('reveal' as const),
    key: desktopFsCacheKey(connection),
    // 显式点击时复用原有下载或文件管理器动作。
    open: () =>
      remote
        ? downloadGatewayFileWithFeedback(path, {
            owner: { connectionId: connection.connectionId, profile: connection.profile },
            suggestedName: target.label
          })
        : revealFile(path),
    path
  }
}
