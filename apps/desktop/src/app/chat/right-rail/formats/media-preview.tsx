import { type SyntheticEvent, useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'
import { mediaKind, resolveMediaPlaybackSrc } from '@/lib/media'

import { previewFailure } from './failure'
import type { FormatRendererProps } from './registry'
import { previewAccessFailure } from './source'

/** 复用原版可拖动进度的媒体通道，不自动播放，也不读取整份文件。 */
export default function MediaPreview({ onFailure, path, reloadKey, target }: FormatRendererProps) {
  const { t } = useI18n()
  const [src, setSrc] = useState('')

  useEffect(() => {
    let active = true

    void resolveMediaPlaybackSrc(path).then(
      url => {
        if (active) {
          setSrc(url)
        }
      },
      error => {
        if (active) {
          onFailure(previewFailure(error))
        }
      }
    )

    return () => {
      active = false
    }
  }, [onFailure, path, reloadKey])

  if (!src) {
    return <PageLoader label={t.preview.loading} />
  }

  const player = {
    'aria-label': target.label,
    controls: true,
    // 文件缺失、连接失败和编码不支持可能是同一错误码；确认文件还能访问后才提示不支持。
    onError: (event: SyntheticEvent<HTMLMediaElement>) => {
      const decoding = [3, 4].includes(event.currentTarget.error?.code || 0)

      void previewAccessFailure(path).then(failure =>
        onFailure(failure || { code: decoding ? 'unsupported' : 'unavailable' })
      )
    },
    preload: 'metadata',
    src
  }

  return (
    <div className="flex size-full items-center justify-center p-4">
      {mediaKind(path) === 'audio' ? (
        <div className="w-full max-w-md">
          <div className="mb-3 truncate text-sm text-foreground">{target.label}</div>
          <audio {...player} className="block w-full" />
        </div>
      ) : (
        <video {...player} className="max-h-full max-w-full" playsInline />
      )}
    </div>
  )
}
