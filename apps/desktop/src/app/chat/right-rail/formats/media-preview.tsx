import { type SyntheticEvent, useEffect, useState } from 'react'

import { PageLoader } from '@/components/page-loader'
import { useI18n } from '@/i18n'
import { mediaKind, resolveMediaPlaybackSrc } from '@/lib/media'

import { previewFailure } from './failure'
import type { FormatRendererProps } from './registry'

/** 复用原版可拖动进度的媒体通道，不自动播放，也不读取整份文件。 */
export default function MediaPreview({ onFailure, reloadKey, target }: FormatRendererProps) {
  const { t } = useI18n()
  const path = target.path || target.source || target.url
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
    // 解码与格式错误单独提示，其他播放失败保留通用出口。
    onError: (event: SyntheticEvent<HTMLMediaElement>) =>
      onFailure({ code: [3, 4].includes(event.currentTarget.error?.code || 0) ? 'unsupported' : 'unavailable' }),
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
