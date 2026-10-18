import type { ComponentProps } from 'react'

import { Button } from '@/components/ui/button'
import { useZoomPan } from '@/components/ui/use-zoom-pan'
import { useI18n } from '@/i18n'
import { RefreshCw, ZoomIn, ZoomOut } from '@/lib/icons'
import { cn } from '@/lib/utils'

/** 图片在面板内缩放和拖动；双击还原，文件变化由调用方重新挂载。 */
export function ImagePreview({ alt, ...props }: ComponentProps<'img'>) {
  const { t } = useI18n()
  const { panning, reset, stageProps, style, zoomIn, zoomOut } = useZoomPan()

  return (
    <div className="relative flex size-full min-h-0 flex-col">
      <div className="flex shrink-0 justify-end gap-1 p-1">
        <Button aria-label={t.preview.imageZoomOut} onClick={zoomOut} size="icon-sm" variant="ghost">
          <ZoomOut />
        </Button>
        <Button aria-label={t.preview.imageReset} onClick={reset} size="icon-sm" variant="ghost">
          <RefreshCw />
        </Button>
        <Button aria-label={t.preview.imageZoomIn} onClick={zoomIn} size="icon-sm" variant="ghost">
          <ZoomIn />
        </Button>
      </div>
      <div
        aria-label={alt}
        className={cn(
          'relative min-h-0 flex-1 touch-none overflow-hidden',
          panning ? 'cursor-grabbing' : 'cursor-grab'
        )}
        onDoubleClick={reset}
        role="region"
        {...stageProps}
      >
        <div className="absolute inset-0 flex items-center justify-center p-4" style={style}>
          <img
            {...props}
            alt={alt ?? ''}
            className="max-h-full max-w-full select-none object-contain"
            draggable={false}
          />
        </div>
      </div>
    </div>
  )
}
