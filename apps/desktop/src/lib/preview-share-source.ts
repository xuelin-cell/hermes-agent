import type { HermesConnection } from '@/global'
import { previewArtifactKey } from '@/lib/preview-targets'
import type { PreviewTarget } from '@/store/preview'

export interface PreviewShareFileSource {
  sessionId: string
  path: string
}

/** 显式来源只在所属本机 Profile 和同一文件中生效；无来源的聊天预览沿用原行为。 */
export function previewShareSource(
  target: PreviewTarget,
  connection: HermesConnection | null,
  visiblePath = target.path || target.source
): PreviewShareFileSource | null | undefined {
  const origin = target.shareOrigin

  if (origin === undefined) {
    return undefined
  }

  if (
    !origin ||
    target.kind !== 'file' ||
    connection?.mode !== 'local' ||
    origin.connectionId !== 'local' ||
    origin.profile !== (connection.profile || 'default') ||
    typeof origin.sessionId !== 'string' ||
    !origin.sessionId ||
    typeof origin.path !== 'string' ||
    !origin.path ||
    previewArtifactKey(visiblePath, '') !== previewArtifactKey(origin.path, '')
  ) {
    return null
  }

  return { sessionId: origin.sessionId, path: origin.path }
}
