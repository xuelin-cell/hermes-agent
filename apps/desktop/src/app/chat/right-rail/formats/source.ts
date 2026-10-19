import { useStore } from '@nanostores/react'

import { desktopFsCacheKey, readDesktopFileDataUrl, readDesktopFileText } from '@/lib/desktop-fs'
import { assertDesktopPreviewFileOwner, isDesktopPreviewFile } from '@/lib/desktop-preview-files'
import { dataUrlToBlob } from '@/lib/embedded-images'
import { downloadGatewayFileWithFeedback } from '@/lib/media'
import { revealFile } from '@/store/file-actions'
import type { PreviewTarget } from '@/store/preview'
import { $connection } from '@/store/session'

import { type PreviewFailure, previewFailure } from './failure'
import { filePathForTarget } from './path'

/** 把读取异常归为固定失败代码；IPC 丢失错误字段时识别其固定错误消息。 */
function readFailure(error: unknown): PreviewFailure {
  const detail = error as { code?: string; message?: string; statusCode?: number } | null
  const message = detail?.message || ''

  if (detail?.code === 'EFBIG' || detail?.statusCode === 413 || /\b413:|file is too large \(/i.test(message)) {
    return { code: 'too_large' }
  }

  if (detail?.code === 'ENOENT' || detail?.statusCode === 404 || /\b404:|path does not exist/i.test(message)) {
    return { code: 'not_found' }
  }

  return previewFailure(error)
}

/** 沿用既有文件读取与大小限制，读取失败统一转成失败代码。 */
export async function readPreviewBytes(path: string): Promise<ArrayBuffer> {
  try {
    const blob = dataUrlToBlob(await readDesktopFileDataUrl(path))

    if (!blob) {
      throw { code: 'unavailable' }
    }

    return await blob.arrayBuffer()
  } catch (error) {
    throw readFailure(error)
  }
}

/** PDF 保留原有类型、编码及文件头校验；字节读取后直接交给分页引擎，不创建 iframe 地址。 */
export async function readPdfBytes(path: string, supplied?: string): Promise<Uint8Array> {
  try {
    const source = supplied ?? (await readDesktopFileDataUrl(path))
    const comma = source.indexOf(',')

    const metadata = source
      .slice(5, comma)
      .split(';')
      .map(part => part.trim().toLowerCase())

    if (!source.startsWith('data:') || comma < 0 || metadata[0] !== 'application/pdf' || !metadata.includes('base64')) {
      throw { code: 'unsupported' }
    }

    const blob = dataUrlToBlob(`data:application/pdf;base64,${decodeURIComponent(source.slice(comma + 1))}`)

    if (!blob) {
      throw { code: 'unsupported' }
    }

    const bytes = new Uint8Array(await blob.arrayBuffer())

    if (new TextDecoder().decode(bytes.subarray(0, 5)) !== '%PDF-') {
      throw { code: 'unsupported' }
    }

    return bytes
  } catch (error) {
    throw readFailure(error)
  }
}

/** 原文件按读取归属请求现有转换；连接变化或未知异常不把旧产物交给显示器，取消时跳过排队转换。 */
export async function readOfficePreviewPdf(path: string, signal?: AbortSignal): Promise<Uint8Array> {
  const desktop = window.hermesDesktop
  const requestId = crypto.randomUUID()
  // 只取消本次请求；主进程按发送页面和编号定位，不会影响其它页面的同一文件。
  const cancel = () => void desktop?.cancelOfficePreview(requestId)

  try {
    const owner = desktopFsCacheKey()
    assertDesktopPreviewFileOwner(path)

    if (($connection.get()?.mode === 'remote' && !isDesktopPreviewFile(path)) || !desktop?.convertOfficePreview) {
      throw { code: 'unavailable' }
    }

    signal?.addEventListener('abort', cancel, { once: true })
    const result = await desktop.convertOfficePreview(path, requestId)

    if (owner !== desktopFsCacheKey()) {
      throw { code: 'unavailable' }
    }

    if (result.ok === false) {
      throw previewFailure(result)
    }

    return result.pdf
  } catch (error) {
    throw previewFailure(error)
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

/** 播放器对文件缺失和编码不支持报同一错误码，失败后用原有文本读取确认文件是否还能访问。 */
export async function previewAccessFailure(path: string): Promise<PreviewFailure | null> {
  try {
    await readDesktopFileText(path)

    return null
  } catch (error) {
    const failure = readFailure(error)

    // 超过文本读取上限说明文件还在，不算访问失败。
    return failure.code === 'too_large' ? null : failure
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

/** 在一处确定文件路径、归属与失败出口；路径与原版预览同一算法，下载固定到显示该文件的连接。 */
export function usePreviewSource(target: PreviewTarget) {
  const connection = useStore($connection)
  const path = filePathForTarget(target)
  const remote = connection?.mode === 'remote' && !isDesktopPreviewFile(path)

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
