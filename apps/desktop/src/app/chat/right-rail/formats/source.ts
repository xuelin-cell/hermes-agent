import { useStore } from '@nanostores/react'

import { desktopFsCacheKey, readDesktopFileDataUrl, readDesktopFileText } from '@/lib/desktop-fs'
import { dataUrlToBlob } from '@/lib/embedded-images'
import { downloadGatewayFileWithFeedback } from '@/lib/media'
import { revealFile } from '@/store/file-actions'
import type { PreviewTarget } from '@/store/preview'
import { $connection } from '@/store/session'

import { previewFailure } from './failure'

/** 沿用既有文件读取与大小限制；IPC 丢失错误字段时识别其固定错误消息。 */
export async function readPreviewBytes(path: string): Promise<ArrayBuffer> {
  try {
    const blob = dataUrlToBlob(await readDesktopFileDataUrl(path))

    if (!blob) {
      throw { code: 'unavailable' }
    }

    return await blob.arrayBuffer()
  } catch (error) {
    const detail = error as { code?: string; message?: string; statusCode?: number } | null
    const message = detail?.message || ''

    if (detail?.code === 'EFBIG' || detail?.statusCode === 413 || /\b413:|file is too large \(/i.test(message)) {
      throw { code: 'too_large' }
    }

    if (detail?.code === 'ENOENT' || detail?.statusCode === 404 || /\b404:|path does not exist/i.test(message)) {
      throw { code: 'not_found' }
    }

    throw previewFailure(error)
  }
}

/** 复用原有本机／远程文本读取与上限，二进制内容交回原版预览处理。 */
export async function readPreviewText(path: string) {
  const file = await readDesktopFileText(path)

  if (file.binary) {
    throw new Error('Binary content cannot be displayed as a table')
  }

  return file
}

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
